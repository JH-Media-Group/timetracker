/**
 * Sessions.
 *
 * Database sessions, not JWTs. The whole point is immediate revocation: when
 * somebody leaves, deleting their row ends every session they have on every
 * device, and a signed token that is valid until it expires cannot do that.
 *
 * The cookie carries a random token; the database stores only its SHA-256 hash.
 * A dump of the sessions table is therefore not a set of working credentials.
 * (SHA-256 rather than argon2 here on purpose: the token is 32 bytes of
 * randomness, so there is nothing to brute force, and session lookup happens on
 * every request.)
 *
 * Specification: docs/BACKEND_PRD.md section 7.1.
 */

import { createHmac } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { db } from "@/server/db/client";
import * as s from "@/server/db/schema";
import { newId, randomToken } from "@/server/db/ids";
import { env } from "@/server/env";
import type { Actor } from "@/server/ctx";
import type { Capability } from "./capabilities";

export const SESSION_COOKIE = "tally_session";

/** Rolling 30 days, with a hard 90-day ceiling no amount of activity extends. */
const ROLLING_DAYS = 30;
const ABSOLUTE_DAYS = 90;
/** Only touch `last_seen_at` and the rolling expiry once an hour. */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Keyed, not plain.
 *
 * A plain SHA-256 of a 32-byte random token is already impractical to reverse,
 * so the key is not there to protect the token. It is there so that write
 * access to the database is not enough to mint a session: somebody who can
 * insert a row still cannot produce a hash matching a cookie they chose without
 * also having SESSION_SECRET, which lives in the environment.
 *
 * Rotating the secret invalidates every session, which is the documented
 * behaviour and occasionally the point.
 */
const hashToken = (token: string) =>
  createHmac("sha256", env.SESSION_SECRET).update(token).digest("hex");

export interface NewSession {
  token: string;
  expiresAt: Date;
}

export async function createSession(
  userId: string,
  info: { ip?: string | null; userAgent?: string | null } = {}
): Promise<NewSession> {
  const token = randomToken(32);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ROLLING_DAYS * 86_400_000);
  const absoluteExpiresAt = new Date(now.getTime() + ABSOLUTE_DAYS * 86_400_000);

  await db.insert(s.sessions).values({
    id: newId(),
    userId,
    tokenHash: hashToken(token),
    userAgent: info.userAgent ?? null,
    ip: info.ip ?? null,
    expiresAt,
    absoluteExpiresAt,
  });

  return { token, expiresAt };
}

export async function revokeSession(token: string): Promise<void> {
  await db
    .update(s.sessions)
    .set({ revokedAt: new Date() })
    .where(eq(s.sessions.tokenHash, hashToken(token)));
}

export async function revokeAllSessions(userId: string): Promise<number> {
  const rows = await db
    .update(s.sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(s.sessions.userId, userId), isNull(s.sessions.revokedAt)))
    .returning({ id: s.sessions.id });
  return rows.length;
}

/**
 * Resolves a request to an actor, or null.
 *
 * One query joins the session, the user, and the profile: authorization needs
 * the capability list on every request, and three round trips per request is
 * three round trips too many.
 */
export async function resolveSession(req?: NextRequest): Promise<Actor | null> {
  const token = req ? readCookie(req) : await readCookieFromStore();
  if (!token) return null;
  return actorForToken(token);
}

export async function actorForToken(token: string): Promise<Actor | null> {
  const now = new Date();

  const rows = await db
    .select({
      sessionId: s.sessions.id,
      lastSeenAt: s.sessions.lastSeenAt,
      userId: s.users.id,
      timezone: s.users.timezone,
      isOwner: s.users.isOwner,
      archivedAt: s.users.archivedAt,
      profileId: s.permissionProfiles.id,
      baseKey: s.permissionProfiles.baseKey,
      capabilities: s.permissionProfiles.capabilities,
    })
    .from(s.sessions)
    .innerJoin(s.users, eq(s.users.id, s.sessions.userId))
    .innerJoin(s.permissionProfiles, eq(s.permissionProfiles.id, s.users.profileId))
    .where(
      and(
        eq(s.sessions.tokenHash, hashToken(token)),
        isNull(s.sessions.revokedAt),
        gt(s.sessions.expiresAt, now),
        gt(s.sessions.absoluteExpiresAt, now)
      )
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  // An archived person keeps their session row but loses their access. Checking
  // here rather than only at sign-in means deactivating somebody takes effect
  // on their next request, not on their next sign-in.
  if (row.archivedAt) return null;

  // Rolling expiry, written at most once an hour so a busy tab does not turn
  // every read into a write.
  //
  // The cookie has to roll with it. Extending only the database row means the
  // browser still discards the cookie thirty days after sign-in however much
  // the person has used Tally in between, which is not a rolling window at all,
  // it is a fixed one with extra writing.
  let renewedUntil: Date | null = null;
  if (now.getTime() - row.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    const extended = new Date(now.getTime() + ROLLING_DAYS * 86_400_000);
    const [updated] = await db
      .update(s.sessions)
      // `${extended}` would hand the driver a Date object, which it cannot
      // serialise, and every authenticated request would 500 from the moment
      // the first session crossed the touch interval. Text with an explicit
      // cast is the only safe way to put a time into a raw sql template.
      .set({
        lastSeenAt: now,
        expiresAt: sql`LEAST(${extended.toISOString()}::timestamptz, ${s.sessions.absoluteExpiresAt})`,
      })
      .where(eq(s.sessions.id, row.sessionId))
      .returning({ expiresAt: s.sessions.expiresAt });
    await db.update(s.users).set({ lastSeenAt: now }).where(eq(s.users.id, row.userId));
    renewedUntil = updated?.expiresAt ?? extended;
  }

  return {
    userId: row.userId,
    profileId: row.profileId,
    baseKey: row.baseKey,
    capabilities: new Set(row.capabilities as Capability[]),
    kind: "user",
    timezone: row.timezone,
    isOwner: row.isOwner,
    renewedUntil,
  };
}

/* ------------------------------------------------------------- cookie IO */

function readCookie(req: NextRequest): string | null {
  return req.cookies.get(SESSION_COOKIE)?.value ?? null;
}

async function readCookieFromStore(): Promise<string | null> {
  try {
    const store = await cookies();
    return store.get(SESSION_COOKIE)?.value ?? null;
  } catch {
    // Called outside a request scope, for example from a job.
    return null;
  }
}

export const sessionCookieOptions = (expiresAt: Date) =>
  ({
    name: SESSION_COOKIE,
    httpOnly: true,
    secure: env.isProduction,
    sameSite: "lax" as const,
    path: "/",
    expires: expiresAt,
  });

export const clearedCookieOptions = () =>
  ({
    name: SESSION_COOKIE,
    value: "",
    httpOnly: true,
    secure: env.isProduction,
    sameSite: "lax" as const,
    path: "/",
    maxAge: 0,
  });

/**
 * Nightly sweep for the idempotency ledger.
 *
 * The rows exist so a request retried within a few minutes returns the first
 * result instead of doing the work twice. They hold whole response bodies,
 * including entire invoices, and nothing was removing them: a table that only
 * grows, full of exactly the data everything else in this system is careful
 * about. A day is far longer than any client retries over.
 */
export async function purgeIdempotencyKeys(olderThanHours = 24): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanHours * 3_600_000).toISOString();
  const rows = await db
    .delete(s.idempotencyKeys)
    .where(sql`${s.idempotencyKeys.createdAt} < ${cutoff}::timestamptz`)
    .returning({ key: s.idempotencyKeys.key });
  return rows.length;
}

/**
 * Nightly sweep. Sessions that are expired or revoked have nothing to say.
 *
 * The cutoff is interpolated as text with an explicit cast. A JS `Date` handed
 * to a raw `sql` template reaches the driver as an object it cannot serialise,
 * and the query throws. Nothing called this function, so nothing found that
 * until `pnpm sweep` gave it a caller.
 */
export async function purgeDeadSessions(olderThanDays = 7): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
  const rows = await db
    .delete(s.sessions)
    .where(
      sql`(${s.sessions.expiresAt} < ${cutoff}::timestamptz)
          OR (${s.sessions.revokedAt} IS NOT NULL AND ${s.sessions.revokedAt} < ${cutoff}::timestamptz)`
    )
    .returning({ id: s.sessions.id });
  return rows.length;
}
