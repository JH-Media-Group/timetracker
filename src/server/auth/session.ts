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

import { createHash } from "node:crypto";
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

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

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
  if (now.getTime() - row.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    const extended = new Date(now.getTime() + ROLLING_DAYS * 86_400_000);
    await db
      .update(s.sessions)
      .set({ lastSeenAt: now, expiresAt: sql`LEAST(${extended}, ${s.sessions.absoluteExpiresAt})` })
      .where(eq(s.sessions.id, row.sessionId));
    await db.update(s.users).set({ lastSeenAt: now }).where(eq(s.users.id, row.userId));
  }

  return {
    userId: row.userId,
    profileId: row.profileId,
    baseKey: row.baseKey,
    capabilities: new Set(row.capabilities as Capability[]),
    kind: "user",
    timezone: row.timezone,
    isOwner: row.isOwner,
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

/** Nightly sweep. Sessions that are expired or revoked have nothing to say. */
export async function purgeDeadSessions(olderThanDays = 7): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
  const rows = await db
    .delete(s.sessions)
    .where(sql`(${s.sessions.expiresAt} < ${cutoff}) OR (${s.sessions.revokedAt} IS NOT NULL AND ${s.sessions.revokedAt} < ${cutoff})`)
    .returning({ id: s.sessions.id });
  return rows.length;
}
