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
import { AppError, forbidden, notFound } from "@/server/errors";
import { hashPassword, checkPasswordPolicy } from "@/server/auth/password";
import { revokeAllSessions } from "@/server/auth/session";
import { queueMail } from "@/server/services/mail";
import { assertOutranksOrEqual } from "@/server/services/people";
import { effectiveCapabilities, type Capability } from "@/server/auth/capabilities";
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
 * Create a token, optionally queue the email that carries it, and return the
 * link.
 *
 * THIS RETURNS A CREDENTIAL, AND IT DID NOT USED TO
 *
 * An earlier version returned nothing, and said so deliberately: it had once
 * handed the raw token back "for tests", which sat oddly beside this file's
 * argument that the token must not exist anywhere but the one email, on the
 * grounds that a return value is the easiest thing in the world for a future
 * caller to put in a response body.
 *
 * That is now exactly what one caller does, on purpose. A queued invite is not
 * a delivered invite: until mail is configured and draining, pressing the
 * button writes a row nothing sends and the person waits for an email that
 * never arrives. `scripts/invite-link.mts` existed only to work around that
 * from a shell on the host, which needs database credentials, which is far more
 * authority than the person doing the inviting should need.
 *
 * The reasoning behind the old comment still holds, so the shape answers it
 * rather than ignoring it. The link goes back to a caller that asked for it in
 * so many words; `inviteUser` omits the field entirely otherwise, the audit row
 * records which channels were used, and `tests/auth-tokens.test.ts` asserts
 * both. What must not happen is a link appearing in a response nobody asked
 * for one in, and that is the thing under test.
 */
async function issue(
  ctx: Ctx,
  user: { id: string; email: string; firstName: string | null },
  purpose: TokenPurpose,
  createdBy: string | null,
  { sendEmail = true, returnLink = false }: { sendEmail?: boolean; returnLink?: boolean } = {}
): Promise<{ link?: string; tokenId: string }> {
  const token = mintToken();
  const tokenId = newId();

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

  /*
    An invite has an issuer, and the check at redemption should never be the
    first thing to notice it does not. Refusing here means the row cannot
    exist, rather than existing and stranding somebody later behind a message
    about a person who was never there.
  */
  if (purpose === "invite" && !createdBy) {
    throw new AppError("internal_error", "An invitation must record who issued it.");
  }

  await ctx.db.insert(s.authTokens).values({
    id: tokenId,
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

  /*
    Skipped when the caller asked for a link and no email.

    Queueing one anyway would be a message the person never asked to send,
    sitting in the outbox until mail is configured and then arriving weeks
    later about an invite that was handed over in person and used the same day.
  */
  if (sendEmail) {
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

  /*
    The link goes back only to a caller that asked for it, not to every caller
    by default.

    Narrowed here as well as in `inviteUser` because this function serves the
    password-reset purpose too, and `requestPasswordReset` discards what it
    returns. A default that hands back a reset credential is the thing the
    comment above is about: harmless today, one careless caller from not being.
  */
  return returnLink ? { link, tokenId } : { tokenId };
}

/**
 * What a redemption says when it refuses.
 *
 * One message for every reason, deliberately. The endpoint is anonymous and
 * the reasons are not all the holder's business: "that account has been
 * archived" tells somebody who may no longer work here that a colleague was
 * archived, and "the person who sent it no longer has an account" says
 * something about a third party entirely. Neither is worth the small help it
 * gives somebody holding a dead link, whose next step is the same either way.
 *
 * It does not hide the existence of the account: holding a live token is
 * already proof of that. It hides what happened to it.
 *
 * Used for a token that does not resolve as well, not only for the checks
 * after it. Leaving "expired or already used" on the miss path and this on the
 * archived path is a two-value oracle: post a retained link, and which
 * sentence comes back says whether the person was archived. Collapsing one and
 * not the other would have looked like a fix and left the thing it was for.
 */
const REFUSED = "That link is no longer valid. Ask for a new one." as const;

/**
 * Does whoever issued this invite still outrank whoever it is for?
 *
 * Re-runs the rule at redemption, because the answer can change in the seven
 * days a link is good for and the consequence of it changing is the whole
 * account. Built from the two profiles as they stand now: the inviter's, for
 * what they may reach, and the subject's, for what redeeming it would hand
 * over.
 *
 * Refuses rather than silently downgrading. A link that no longer carries the
 * authority it was issued with is not a link with less authority, it is a link
 * that should not be spent.
 */
async function assertInviterStillOutranks(ctx: Ctx, inviterId: string, subjectId: string): Promise<void> {
  const [inviter] = await ctx.db
    .select({ capabilities: s.permissionProfiles.capabilities, archivedAt: s.users.archivedAt })
    .from(s.users)
    .leftJoin(s.permissionProfiles, eq(s.permissionProfiles.id, s.users.profileId))
    .where(eq(s.users.id, inviterId))
    .limit(1);

  const [subject] = await ctx.db
    .select({ isOwner: s.users.isOwner, profileId: s.users.profileId })
    .from(s.users)
    .where(eq(s.users.id, subjectId))
    .limit(1);

  if (!subject) throw notFound("That person");

  // Inviting yourself is always allowed, and is how the owner recovers.
  if (inviterId === subjectId) return;

  const stale = new AppError("validation_failed", REFUSED);

  // The inviter is gone, or has no profile and so no authority to lend.
  if (!inviter) throw stale;

  /*
    And must still hold the capability that issuing required.

    The rank comparison alone does not ask this, and a demotion satisfies it
    trivially: a People Admin demoted to Member still "outranks" a Member,
    because Member's capabilities are contained in Member's. So somebody who
    had the authority to invite, collected links, and then lost that authority
    kept every link working. Issuance demands `people:manage`; redemption of
    somebody else's invite has to demand it too, or losing the permission
    takes nothing away.
  */
  const held0 = effectiveCapabilities((inviter.capabilities ?? []) as Capability[]);
  if (!held0.has("people:manage")) throw stale;

  /*
    An archived inviter lends nothing either.

    The rank rule alone would still pass: somebody walked out last week
    outranks a Member on paper exactly as they did before. But a live
    credential for a colleague's account in the hands of an ex-employee is not
    something to leave working for seven days on a technicality, and the cost
    of refusing is one re-invite by somebody still here.
  */
  if (inviter.archivedAt) throw stale;

  if (subject.isOwner) throw stale;
  if (!subject.profileId) return;

  /*
    Shared-locked, because this read is the decision.

    Locking the subject's `users` row covers them being moved to another
    profile. It does nothing about the profile they already point at being
    widened, which takes `FOR UPDATE` on `permission_profiles` and touches no
    user row at all. Without this the guard added to make redemption
    authoritative is itself a check-then-act, which is the defect it exists to
    prevent one layer down.

    Deadlock-safe: every path that reaches a profile lock has already taken the
    subject's `users` row, so two of them serialise there rather than forming a
    cycle.
  */
  const [profile] = await ctx.db
    .select({ capabilities: s.permissionProfiles.capabilities })
    .from(s.permissionProfiles)
    .where(eq(s.permissionProfiles.id, subject.profileId))
    .limit(1)
    .for("share");

  /*
    A profile that no longer exists confers nothing, so there is nothing to
    outrank. Refusing here would strand somebody with no way back into an
    account if a profile were ever deleted while in use, and the same reading
    is what `assertOutranksOrEqual` already applies. Deliberate, not an
    oversight.
  */
  if (!profile) return;

  const beyond = ((profile.capabilities ?? []) as Capability[]).filter((c) => !held0.has(c));
  if (beyond.length > 0) throw stale;
}

/** How the invite reaches the person. At least one must be true. */
export interface InviteChannels {
  /** Queue the invitation email to their address. */
  email?: boolean;
  /** Return the one-time link for the inviter to pass on themselves. */
  link?: boolean;
}

/**
 * Invite somebody who already has a user record.
 *
 * Refuses an archived account and refuses an `@imported.invalid` address. The
 * import created history-only people with addresses on that reserved TLD
 * (RFC 2606) precisely so they could never receive mail; inviting one would
 * bounce, and bounces are what cost a domain its reputation.
 *
 * BOTH CHANNELS, ONE TOKEN, ONE CALL
 *
 * Issuing a token supersedes every outstanding token of the same purpose, which
 * is the right rule and makes "email it" and "give me a link" impossible to
 * offer as two requests. The second call would kill the first token, so
 * whichever channel the person actually used would be the dead one, and the
 * failure arrives later as "this link has expired" with nothing to explain it.
 * `scripts/invite-link.mts` carries a comment about being bitten by exactly
 * this, from running itself twice.
 *
 * So the channels are arguments to one call and there is one token either way.
 * The email carries it and the caller is handed it, and they are the same link.
 */
export async function inviteUser(
  ctx: Ctx,
  userId: string,
  channels: InviteChannels = { email: true }
): Promise<{ queued: boolean; link?: string }> {
  assertCan(ctx, "people:manage");

  const email = channels.email ?? false;
  const link = channels.link ?? false;
  if (!email && !link) {
    throw new AppError("validation_failed", "Choose at least one of sending the email or creating a link.");
  }

  /*
    Locked and read in one statement, and everything below decided from what it
    returned.

    The first version of this read the person, authorized against that read,
    and only then took the lock, which is a check-then-act race with a
    concurrent promotion. An `updateUser` transaction raising somebody from
    Member to Administrator commits between the two; the invite authorized
    against the Member profile, waited on the lock, and then issued a
    credential for an Administrator account. The guard is only worth as much as
    the values it was evaluated on.

    `FOR UPDATE` is also what serialises two invites for the same person, which
    is why it has to happen before the supersede rather than after the read.
  */
  const [user] = await ctx.db
    .select({
      id: s.users.id,
      email: s.users.email,
      firstName: s.users.firstName,
      archivedAt: s.users.archivedAt,
      isOwner: s.users.isOwner,
      profileId: s.users.profileId,
    })
    .from(s.users)
    .where(eq(s.users.id, userId))
    .limit(1)
    .for("update");

  if (!user) throw notFound("That person");

  /*
    AN INVITE IS A CREDENTIAL FOR SOMEBODY ELSE'S ACCOUNT, SO IT IS RANKED.

    `updateUser` has refused to edit the owner's record, or anybody holding
    permissions beyond the caller's, since the day somebody noticed that the
    owner's email was editable by any holder of `people:manage`. Inviting had
    neither check, which was survivable only while the credential could go
    nowhere but the account's own inbox: the victim was told.

    A link-only invite removes that. Without these two lines a People Admin can
    take a set-password link for the account owner, use it, and `consumeToken`
    revokes every session the owner holds. That is a silent takeover by
    somebody the permission model says is junior to them, and `people:manage`
    is held by two base profiles, not just Administrator.

    Same rule, same wording, same helper as editing them. Inviting somebody is
    at least as powerful as editing them.
  */
  if (user.isOwner && ctx.actor.kind !== "system" && user.id !== ctx.actor.userId) {
    throw forbidden("Only the account owner can invite the owner.");
  }
  if (user.profileId && user.id !== ctx.actor.userId) {
    await assertOutranksOrEqual(ctx, user.profileId, "invite");
  }

  if (user.archivedAt) {
    throw new AppError("conflict", "That person is archived. Restore them before inviting them.");
  }
  if (user.email.endsWith("@imported.invalid")) {
    throw new AppError(
      "conflict",
      "That account has no real email address. It exists only to carry imported history. Give it a real address first."
    );
  }

  const issued = await issue(ctx, user, "invite", ctx.actor.userId, { sendEmail: email, returnLink: link });

  /*
    The channels are on the audit row because they are not the same act.
    Queueing the email sends the credential to the address on the account.
    Taking the link hands it to whoever pressed the button, to pass on by some
    route this system cannot see. If an account is later found to have been set
    up by the wrong person, that distinction is the whole question.

    The token id goes on the row too, so the invite that issued a credential can
    be joined to the moment it was used rather than guessed at by timestamp.
  */
  ctx.audit({
    action: "user.invited",
    entityType: "user",
    entityId: user.id,
    after: { emailed: email, linkTaken: link, tokenId: issued.tokenId },
  });

  // Present only when asked for. A caller that did not request a link must not
  // be handed one by a change to this function's shape.
  return link ? { queued: email, link: issued.link } : { queued: email };
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
    .select({ id: s.authTokens.id, userId: s.authTokens.userId })
    .from(s.authTokens)
    .where(and(eq(s.authTokens.tokenHash, tokenHash), isNull(s.authTokens.usedAt), gt(s.authTokens.expiresAt, new Date())))
    .limit(1);

  if (!candidate) {
    throw new AppError("validation_failed", REFUSED);
  }

  const hash = await hashPassword(password);

  /*
    A Ctx so that spending a token is audited like every other change to a user.

    There is no signed-in actor here by design: whoever holds the link is the
    only party, and the endpoint is anonymous. The system is therefore the
    actor, acting for the account, which is the same shape `requestPasswordReset`
    above uses for the same reason.

    Before this, the one moment a credential actually changed hands wrote
    nothing at all. `user.invited` recorded who issued a link and by which
    channel, and then the trail stopped: an auditor asking "who set this account
    up" could see an invitation and a `used_at` timestamp, and had to infer the
    join between them. Now the invite row carries the token id and this row
    names the same token, so the two ends meet.
  */
  const ctx = createCtx({ actor: systemActor(candidate.userId), db });

  const userId = await withTransaction(ctx, async (tx) => {
    /*
      The user row first, then the token. That order matters more than it looks.

      `inviteUser` locks the user and then updates `auth_tokens` to supersede.
      This function used to lock `auth_tokens` and then update `users`, which is
      a lock-order inversion: re-invite holds the user and waits for the token,
      consumption holds the token and waits for the user, and Postgres breaks
      the cycle by aborting one of them. Nothing here retries a deadlock and
      `fromDatabaseError` does not translate 40P01, so somebody setting their
      password at the moment an admin re-invites them gets a 500 and, if
      consumption is the transaction that loses, a token the re-invite has
      since superseded.

      Taking them in the same order in both places means the two serialise
      instead of deadlocking. The user id comes from the unlocked pre-check
      above, which is safe for this purpose because a token never moves between
      users; everything the decision rests on is still re-read under the lock
      below.
    */
    await tx.db.select({ id: s.users.id }).from(s.users).where(eq(s.users.id, candidate.userId)).limit(1).for("update");

    /*
      Claim the token under a row lock before touching the password.

      Two submissions of the same link, which a double click produces, must set
      one password rather than race. The lock plus the `used_at` recheck makes
      the second one find nothing.
    */
    const [row] = await tx.db
      .select({
        id: s.authTokens.id,
        userId: s.authTokens.userId,
        purpose: s.authTokens.purpose,
        createdBy: s.authTokens.createdBy,
      })
      .from(s.authTokens)
      .where(
        and(eq(s.authTokens.tokenHash, tokenHash), isNull(s.authTokens.usedAt), gt(s.authTokens.expiresAt, new Date()))
      )
      .limit(1)
      .for("update");

    if (!row) {
      throw new AppError("validation_failed", REFUSED);
    }

    /*
      AN INVITE MUST NOT OUTLIVE THE AUTHORITY IT WAS ISSUED UNDER.

      Everything else here guards the moment a link is created, and a link is
      good for seven days. A People Admin invites a Member, keeps the link, and
      waits: somebody promotes that Member to Administrator, and the retained
      link now sets an Administrator's password and revokes their sessions. No
      race, no concurrency, no unusual timing. Just patience.

      So the rank rule is applied again here, against who the person is now
      rather than who they were then. `createdBy` is null for a self-service
      password reset, which has no inviter to outrank and is how somebody
      recovers their own account; those are unaffected.

      Refusing costs a re-invite. Not refusing costs the account.
    */
    /*
      A reset has no inviter and needs none: nobody else's authority is being
      spent and it is how a person recovers their own account.

      An invite with no recorded issuer is a different thing entirely. The
      foreign key is ON DELETE SET NULL, so deleting the person who issued it
      silently erases the provenance every check here depends on and the guard
      would wave the link through. Fail closed: the cost is a re-invite, and
      the alternative is a credential nobody can account for.
    */
    /*
      An archived person does not get a password.

      `peekToken` already refuses to resolve a token for one, so the screen
      that asks for a password never renders. Posting the token directly
      skipped that and set the password anyway, on an account that is supposed
      to be unable to sign in at all. Archiving somebody is the most complete
      version of taking access away and it has to survive a link they were sent
      the week before.
    */
    const [subject] = await tx.db
      .select({ archivedAt: s.users.archivedAt })
      .from(s.users)
      .where(eq(s.users.id, row.userId))
      .limit(1);

    if (subject?.archivedAt) {
      throw new AppError("validation_failed", REFUSED);
    }

    if (row.purpose === "invite") {
      if (!row.createdBy) {
        throw new AppError("validation_failed", REFUSED);
      }
      await assertInviterStillOutranks(tx, row.createdBy, row.userId);
    }

    /*
      Every outstanding token for this person, not just the one being spent,
      and across both purposes.

      Issuing supersedes within a purpose, which left the two able to shadow
      each other. Somebody holds a stolen invite; the owner of the account
      notices something is wrong and does a password reset; the reset succeeds
      and the invite is untouched, so the thief spends it afterwards, replaces
      the password that was just recovered and revokes the sessions that came
      with it. Recovering an account is the exact moment every other way into
      it should stop working, and it was the one moment nothing did.

      No race and no extra permission needed, which is what made this worth
      fixing before anything else this round.
    */
    await tx.db
      .update(s.authTokens)
      .set({ usedAt: new Date() })
      .where(and(eq(s.authTokens.userId, row.userId), isNull(s.authTokens.usedAt)));

    await tx.db
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
    await revokeAllSessions(row.userId, tx.db);

    /*
      The locked row's user, not the one read before the lock. The pre-check is
      a filter and says so; deciding anything from it would make this row a
      guess at exactly the moment somebody is relying on it.
    */
    tx.audit({
      action: "user.password_set_via_token",
      entityType: "user",
      entityId: row.userId,
      after: { purpose: row.purpose, tokenId: row.id, sessionsRevoked: true },
    });

    return row.userId;
  });

  return { userId };
}
