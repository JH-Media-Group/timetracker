/**
 * Invites and password resets (TALLY-48).
 *
 * With Google SSO dropped in favour of password-only, this is the **only** way
 * anybody gets an account on a deployed instance. Before it existed, passwords
 * could be set by exactly three things: the seed, the Harvest importer behind a
 * flag that refuses to run in production, and two test scripts.
 *
 * ONE MECHANISM, TWO PURPOSES
 *
 * An invite and a reset are the same thing with different copy and different
 * expiries: prove you can read an inbox, then choose a password. Splitting them
 * into two tables would duplicate the security-relevant half, which is where
 * mistakes are expensive.
 *
 * WHY THE TOKEN IS HASHED
 *
 * A token in a database is a credential. Anybody who could read this table
 * could otherwise set any password in the account, and a backup would be a
 * permanent skeleton key. Only the digest is stored, so a stolen copy is
 * worthless. This is the same reasoning `sessions` already applies.
 *
 * NOT `user_invites`
 *
 * That table exists in the schema, is referenced by nothing but the seed's
 * truncate list, and models a different flow: inviting somebody who has no user
 * row yet, creating it on acceptance. Every real person here already exists,
 * because the Harvest import created them, and it cannot serve a reset either.
 * It is left alone rather than half-adopted, and is worth deleting or building
 * on deliberately rather than by accident.
 */

import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { createCtx, systemActor, withTransaction, type Ctx } from "@/server/ctx";
import { db } from "@/server/db/client";
import * as s from "@/server/db/schema";
import { newId } from "@/server/db/ids";
import { assertCan } from "@/server/ctx";
import { AppError, notFound } from "@/server/errors";
import { hashPassword, checkPasswordPolicy } from "@/server/auth/password";
import { revokeAllSessions } from "@/server/auth/session";
import { queueMail } from "@/server/services/mail";
import { TOKEN_TTL_MS as TTL_MS, type TokenPurpose } from "@/server/auth/token-ttl";
import { env } from "@/server/env";

// The TTLs live in `@/server/auth/token-ttl` because `mail` needs them too, to
// recognise a queued message that has outlived the credential inside it, and
// importing them from here would be a cycle.
export type { TokenPurpose };

const digest = (token: string) => createHash("sha256").update(token).digest("hex");

/** 32 random bytes, base64url, so it survives a URL and an email client. */
const mintToken = () => randomBytes(32).toString("base64url");

const linkFor = (token: string) => `${env.APP_URL.replace(/\/$/, "")}/set-password?token=${token}`;

/**
 * Create a token and queue the email that carries it.
 *
 * Returns nothing. It used to hand the raw token back "for tests", which sat
 * oddly beside this file's argument that the token must not exist anywhere but
 * the one email: a return value is the easiest thing in the world for a future
 * caller to put in a response body. The tests read it out of the queued message,
 * which is also a truer test, because it proves the link actually reached the
 * mail the person receives.
 */
async function issue(
  ctx: Ctx,
  user: { id: string; email: string; firstName: string | null },
  purpose: TokenPurpose,
  createdBy: string | null
): Promise<void> {
  const token = mintToken();

  /*
    Supersede any outstanding token of the same purpose.

    Two live reset links mean a stolen one keeps working after the owner has
    quietly requested another, which is the case where this matters.
  */
  await ctx.db
    .update(s.authTokens)
    .set({ usedAt: new Date() })
    .where(
      and(eq(s.authTokens.userId, user.id), eq(s.authTokens.purpose, purpose), isNull(s.authTokens.usedAt))
    );

  await ctx.db.insert(s.authTokens).values({
    id: newId(),
    userId: user.id,
    purpose,
    tokenHash: digest(token),
    expiresAt: new Date(Date.now() + TTL_MS[purpose]),
    createdBy,
  });

  const name = user.firstName?.trim() || "there";
  const link = linkFor(token);

  const copy =
    purpose === "invite"
      ? {
          subject: "Your Tally account",
          text:
            `Hi ${name},\n\n` +
            `An account has been created for you in Tally, JH Media Group's time tracking and invoicing system.\n\n` +
            `Choose a password to get started:\n${link}\n\n` +
            `This link works once and expires in seven days.\n`,
        }
      : {
          subject: "Reset your Tally password",
          text:
            `Hi ${name},\n\n` +
            `Somebody asked to reset the password for this address.\n\n` +
            `Choose a new one:\n${link}\n\n` +
            `This link works once and expires in an hour. ` +
            `If it was not you, you can ignore this: nothing has changed.\n`,
        };

  await queueMail(ctx, {
    kind: purpose === "invite" ? "invite" : "password_reset",
    to: user.email,
    subject: copy.subject,
    text: copy.text,
    relatedType: "user",
    relatedId: user.id,
    userId: user.id,
  });

}

/**
 * Invite somebody who already has a user record.
 *
 * Refuses an archived account and refuses an `@imported.invalid` address. The
 * import created 45 history-only people with addresses on that reserved TLD
 * (RFC 2606) precisely so they could never receive mail; inviting one would
 * bounce, and bounces are what cost a domain its reputation.
 */
export async function inviteUser(ctx: Ctx, userId: string): Promise<{ queued: boolean }> {
  assertCan(ctx, "people:manage");

  const [user] = await ctx.db
    .select({
      id: s.users.id,
      email: s.users.email,
      firstName: s.users.firstName,
      archivedAt: s.users.archivedAt,
    })
    .from(s.users)
    .where(eq(s.users.id, userId))
    .limit(1);

  if (!user) throw notFound("That person");
  if (user.archivedAt) {
    throw new AppError("conflict", "That person is archived. Restore them before inviting them.");
  }
  if (user.email.endsWith("@imported.invalid")) {
    throw new AppError(
      "conflict",
      "That account has no real email address. It exists only to carry imported history. Give it a real address first."
    );
  }

  await issue(ctx, user, "invite", ctx.actor.userId);
  ctx.audit({ action: "user.invited", entityType: "user", entityId: user.id });
  return { queued: true };
}

/**
 * Begin a password reset. **Public, and must not disclose whether an account
 * exists.**
 *
 * Always reports the same thing. A response that differs by whether the address
 * is known turns this into an account enumeration endpoint on a public URL, and
 * the list of who works somewhere is worth having if you are choosing a
 * phishing target.
 */
/**
 * The least time between two reset emails to the same address.
 *
 * This replaces a per-address rate-limit bucket, which was the wrong tool
 * twice over. Enforced, it let anybody lock a chosen person out of the only
 * self-service recovery path by spending their allowance. Consumed silently
 * instead, it was worse: the victim got a cheerful "a reset link is on its
 * way" and no link, which a reviewer demonstrated.
 *
 * **What this does and does not buy, stated accurately.** It stops the hour-long
 * lockout a per-address rate-limit bucket caused, because the window always
 * expires and every issuance emails the owner of the address: a minute after
 * any flood, the victim holds a live link. It does not stop an attacker
 * occupying the window by posting just before them, in which case the victim's
 * own request is suppressed and answered reassuringly. That is survivable
 * because the link the attacker's request just sent is in the victim's inbox
 * and valid for an hour. An earlier version of this comment claimed the floor
 * "cannot be weaponised", which was too strong; a reviewer was right to say so.
 *
 * What it costs an attacker to sustain is one request a minute forever, and
 * what it gains them is inbox noise at that rate.
 */
const MIN_SECONDS_BETWEEN_RESETS = 60;

export async function requestPasswordReset(email: string): Promise<void> {
  const [user] = await db
    .select({
      id: s.users.id,
      email: s.users.email,
      firstName: s.users.firstName,
      archivedAt: s.users.archivedAt,
      passwordHash: s.users.passwordHash,
    })
    .from(s.users)
    .where(eq(s.users.email, email))
    .limit(1);

  // Silently do nothing for an unknown, archived or unreachable address. The
  // caller cannot tell the difference, which is the point.
  if (!user || user.archivedAt || user.email.endsWith("@imported.invalid")) return;

  /*
    A real context, and one transaction.

    This used to fabricate a Ctx with `as unknown as Ctx` and run the three
    writes (supersede, insert, queue) as separate autocommits. Two concurrent
    requests could both supersede before either inserted, leaving two live reset
    links, which is exactly what superseding exists to prevent. A failure
    between the insert and the queue left a valid token nobody was ever sent.
    The cast was the tell: it hid both the missing transaction and a context
    with none of the fields `issue` would need the moment it grew.
  */
  /*
    Suppress a duplicate, do not refuse the person.

    The window is read from the tokens themselves rather than a counter, so it
    needs no extra state and cannot drift out of step with what was actually
    issued.
  */
  const ctx = createCtx({ actor: systemActor(user.id), db });

  await withTransaction(ctx, async (tx) => {
    /*
      Take the user row before deciding, and decide inside the transaction.

      Checking outside it was a plain check-then-act race: two requests
      arriving together both saw no recent token, both superseded, and both
      issued, so two live links went out. The lock serialises them and the
      second one then sees the first one's token.
    */
    await tx.db.select({ id: s.users.id }).from(s.users).where(eq(s.users.id, user.id)).limit(1).for("update");

    const [recent] = await tx.db
      .select({ id: s.authTokens.id })
      .from(s.authTokens)
      .where(
        and(
          eq(s.authTokens.userId, user.id),
          eq(s.authTokens.purpose, "password_reset"),
          // The database clock on both sides. `created_at` is written by
          // Postgres, so comparing it to Node's would let a skewed container
          // suppress every reset while still answering "on its way", which is
          // the same class of bug `mail.ts` carries a comment about.
          sql`${s.authTokens.createdAt} > now() - make_interval(secs => ${MIN_SECONDS_BETWEEN_RESETS})`
        )
      )
      .limit(1);

    if (recent) return;
    await issue(tx, user, "password_reset", null);
  });
}

export interface TokenSubject {
  userId: string;
  email: string;
  firstName: string | null;
  purpose: TokenPurpose;
}

/** Resolve a token without spending it, so the page can greet the right person. */
export async function peekToken(token: string): Promise<TokenSubject | null> {
  const [row] = await db
    .select({
      userId: s.authTokens.userId,
      purpose: s.authTokens.purpose,
      email: s.users.email,
      firstName: s.users.firstName,
    })
    .from(s.authTokens)
    .innerJoin(s.users, eq(s.users.id, s.authTokens.userId))
    .where(
      and(
        eq(s.authTokens.tokenHash, digest(token)),
        isNull(s.authTokens.usedAt),
        gt(s.authTokens.expiresAt, new Date()),
        isNull(s.users.archivedAt)
      )
    )
    .limit(1);

  if (!row) return null;
  return { userId: row.userId, email: row.email, firstName: row.firstName, purpose: row.purpose as TokenPurpose };
}

/**
 * Spend a token and set the password.
 *
 * **Every other session for that person is revoked.** A reset after somebody
 * else got in that leaves the intruder signed in has achieved nothing, and that
 * is the case a reset is usually for.
 */
export async function consumeToken(token: string, password: string): Promise<{ userId: string }> {
  const problem = checkPasswordPolicy(password);
  if (problem) throw new AppError("validation_failed", problem.message);

  const tokenHash = digest(token);

  /*
    Check the token before hashing the password, not after.

    argon2id here is deliberately expensive: 19 MiB and two passes, about 25ms.
    Doing that first meant anybody could spend it by posting a junk token, and a
    reviewer measured exactly that. It matters more than it sounds, because with
    `TRUST_PROXY=0` (which is what `.env.example` ships) `clientIp()` returns
    null and this route's rate limit does not apply at all. A cheap sha256
    lookup now decides whether the expensive work is worth doing.

    The lookup is repeated inside the transaction below under a row lock. This
    one is a filter, not the decision.
  */
  const [candidate] = await db
    .select({ id: s.authTokens.id })
    .from(s.authTokens)
    .where(and(eq(s.authTokens.tokenHash, tokenHash), isNull(s.authTokens.usedAt), gt(s.authTokens.expiresAt, new Date())))
    .limit(1);

  if (!candidate) {
    throw new AppError("validation_failed", "That link has expired or has already been used. Ask for another.");
  }

  const hash = await hashPassword(password);

  const userId = await db.transaction(async (tx) => {
    /*
      Claim the token under a row lock before touching the password.

      Two submissions of the same link, which a double click produces, must set
      one password rather than race. The lock plus the `used_at` recheck makes
      the second one find nothing.
    */
    const [row] = await tx
      .select({ id: s.authTokens.id, userId: s.authTokens.userId })
      .from(s.authTokens)
      .where(
        and(eq(s.authTokens.tokenHash, tokenHash), isNull(s.authTokens.usedAt), gt(s.authTokens.expiresAt, new Date()))
      )
      .limit(1)
      .for("update");

    if (!row) {
      throw new AppError("validation_failed", "That link has expired or has already been used. Ask for another.");
    }

    await tx.update(s.authTokens).set({ usedAt: new Date() }).where(eq(s.authTokens.id, row.id));
    await tx
      .update(s.users)
      .set({ passwordHash: hash, updatedAt: new Date() })
      .where(eq(s.users.id, row.userId));

    /*
      Inside the transaction, not after it.

      Revoking afterwards meant a failure between the commit and the revoke left
      the password changed and every hostile session still live, which is the
      one case a reset is usually for. Either all three happen or none do.
    */
    // Through the shared helper rather than a copy of its update: the inlined
    // version left `revokeAllSessions` with no caller in `src/`, which is how
    // an exported function and the thing it is supposed to do drift apart.
    await revokeAllSessions(row.userId, tx);

    return row.userId;
  });

  return { userId };
}
