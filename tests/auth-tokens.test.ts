/**
 * Invite and password reset (TALLY-48).
 *
 * This is the only way anybody gets an account on a deployed instance, so the
 * cases that matter are the ones an attacker cares about: can a token be used
 * twice, does a reset leave the old sessions alive, and can the public endpoint
 * be used to find out who works here.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/mail/transport", async () => {
  const actual = await vi.importActual<typeof import("@/server/mail/transport")>("@/server/mail/transport");
  return { ...actual, canSend: () => true, send: vi.fn(async () => ({ messageId: null })) };
});

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, sql as pg } from "@/server/db/client";
import { createCtx, withTransaction } from "@/server/ctx";
import * as s from "@/server/db/schema";
import { newId } from "@/server/db/ids";
import { consumeToken, inviteUser, peekToken, requestPasswordReset } from "@/server/services/auth-tokens";
import { verifyPassword } from "@/server/auth/password";
import { AppError } from "@/server/errors";

const GOOD = "a-perfectly-fine-passphrase-42";

/** The token never leaves the service, so tests read the queued email for it. */
async function linkTokenFor(userId: string): Promise<string> {
  const [msg] = await db
    .select()
    .from(s.outboundMessages)
    .where(eq(s.outboundMessages.userId, userId))
    .orderBy(s.outboundMessages.createdAt);
  const match = /set-password\?token=([A-Za-z0-9_-]+)/.exec(msg?.bodyText ?? "");
  if (!match) throw new Error("no set-password link in the queued email");
  return match[1]!;
}

/** Only the users this file created, so cleanup can delete by id. */
const madeUsers: string[] = [];
/** Profiles this file created, deleted after the users that reference them. */
const madeProfiles: string[] = [];

async function makeUser(over: Partial<typeof s.users.$inferInsert> = {}) {
  const [profile] = await db.select().from(s.permissionProfiles).limit(1);
  const id = newId();
  madeUsers.push(id);
  await db.insert(s.users).values({
    id,
    email: `person-${id}@example.test`,
    firstName: "Test",
    lastName: "Person",
    profileId: profile!.id,
    timezone: "America/New_York",
    ...over,
  });
  return id;
}

/** A profile holding exactly the capabilities named, and nothing else. */
async function makeProfile(name: string, capabilities: string[]): Promise<string> {
  const id = newId();
  await db.insert(s.permissionProfiles).values({ id, name: `${name}-${id}`, capabilities });
  madeProfiles.push(id);
  return id;
}

/** A Ctx with the capability, since the service asserts on it. */
const ctxFor = (userId: string) =>
  ({
    db,
    audit: () => {},
    actor: { userId, capabilities: new Set(["people:manage"]) },
  }) as never;

beforeEach(async () => {
  await db.delete(s.outboundMessages);
  await db.delete(s.authTokens);

  /*
    By id, not by email pattern.

    `email LIKE '%@example.test'` matched users **other files** had created, and
    deleting one of those hit whichever foreign key that file had left pointing
    at it: `invoice_messages.sent_by` on one run, `settings.updated_by` on
    another. Sixteen tests failed here with a constraint violation that had
    nothing to do with tokens, and the file that actually owned the row was
    already green and gone. This is the same lesson `invoice-reminders` records
    about matching on a mutable column: a pattern is a guess about which rows
    are yours, and the ids are not a guess.
  */
  if (madeUsers.length) {
    await db.delete(s.sessions).where(inArray(s.sessions.userId, madeUsers));
    /*
      And the audit rows, which now exist because these tests drive the real
      transaction. `audit_log.actor_id` is a foreign key to users, so deleting
      a person who has audited anything fails on it. This is the same shape of
      constraint the comment above is about; it simply had no audit rows to
      trip over until the race test started using `withTransaction`.
    */
    await db.delete(s.auditLog).where(inArray(s.auditLog.actorId, madeUsers));
    await db.delete(s.users).where(inArray(s.users.id, madeUsers));
    madeUsers.length = 0;
  }
  // After the users, because `users.profile_id` references them.
  if (madeProfiles.length) {
    await db.delete(s.permissionProfiles).where(inArray(s.permissionProfiles.id, madeProfiles));
    madeProfiles.length = 0;
  }
});

describe("inviteUser", () => {
  it("queues an invite and mints a usable token", async () => {
    const id = await makeUser();
    await inviteUser(ctxFor(id), id);

    const token = await linkTokenFor(id);
    const subject = await peekToken(token);
    expect(subject?.userId).toBe(id);
    expect(subject?.purpose).toBe("invite");
  });

  it("refuses an account whose address can never receive mail", async () => {
    // The import created 45 of these on the RFC 2606 reserved TLD precisely so
    // they could never be mailed. Inviting one would bounce, and bounces are
    // what cost a domain its sending reputation.
    const id = await makeUser({ email: `ghost-${newId()}@imported.invalid` });
    await expect(inviteUser(ctxFor(id), id)).rejects.toThrow(/no real email address/);
  });

  it("refuses an archived account", async () => {
    const id = await makeUser({ archivedAt: new Date() });
    await expect(inviteUser(ctxFor(id), id)).rejects.toThrow(/archived/);
  });

  it("never puts the token in its own return value unless it was asked to", async () => {
    /*
      The default is still email only, so the token goes to the inbox on the
      account and nowhere else. This is the guard on the whole magic-link
      change: the link may be returned, but only to a caller that said so in
      the request. Anything else getting one back is a leak.
    */
    const id = await makeUser();
    const result = await inviteUser(ctxFor(id), id);
    expect(result.link).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/[A-Za-z0-9_-]{40,}/);
  });

  it("hands back a working link when one is asked for", async () => {
    const id = await makeUser();
    const result = await inviteUser(ctxFor(id), id, { email: false, link: true });

    expect(result.link).toMatch(/\/set-password\?token=/);
    const token = /token=([A-Za-z0-9_-]+)/.exec(result.link!)![1]!;
    const subject = await peekToken(token);
    expect(subject?.userId).toBe(id);
    expect(subject?.purpose).toBe("invite");
  });

  it("queues no email for a link-only invite", async () => {
    /*
      A message nobody asked to send would sit in the outbox until mail is
      configured, then arrive weeks later about an invite that was handed over
      in person and used the same day.
    */
    const id = await makeUser();
    await inviteUser(ctxFor(id), id, { email: false, link: true });

    const queued = await db
      .select()
      .from(s.outboundMessages)
      .where(eq(s.outboundMessages.userId, id));
    expect(queued).toHaveLength(0);
  });

  it("emails and returns the same link, not two", async () => {
    /*
      The reason both channels are one call. Issuing supersedes any outstanding
      token of the same purpose, so two requests would leave the first one dead
      and whichever channel the person actually used might be the dead one. The
      failure would arrive days later as "this link has expired" with nothing
      to connect it to.
    */
    const id = await makeUser();
    const result = await inviteUser(ctxFor(id), id, { email: true, link: true });

    const emailed = await linkTokenFor(id);
    const returned = /token=([A-Za-z0-9_-]+)/.exec(result.link!)![1]!;
    expect(returned).toBe(emailed);

    // And exactly one token exists, rather than one live and one superseded.
    const live = await db
      .select()
      .from(s.authTokens)
      .where(eq(s.authTokens.userId, id));
    expect(live).toHaveLength(1);
    expect(live[0]!.usedAt).toBeNull();
  });

  it("refuses an invite that would reach nobody", async () => {
    // Not a no-op and not a default: a request meaning nothing would still
    // mint a token and supersede a live invite somebody is already holding.
    const id = await makeUser();
    await expect(inviteUser(ctxFor(id), id, { email: false, link: false })).rejects.toThrow(
      /at least one/i
    );

    const tokens = await db.select().from(s.authTokens).where(eq(s.authTokens.userId, id));
    expect(tokens, "a refused invite must not have minted anything").toHaveLength(0);
  });

  it("records on the audit row which channels were used", async () => {
    /*
      Emailing sends the credential to the address on the account. Taking the
      link hands it to whoever pressed the button, to pass on by a route this
      system cannot see. If an account turns out to have been set up by the
      wrong person, that distinction is the whole question.
    */
    const rows: { action: string; after?: unknown }[] = [];
    const id = await makeUser();
    // A real id: `created_by` on the token is a foreign key, so a placeholder
    // fails on the insert rather than on the thing under test.
    const ctx = {
      db,
      audit: (row: { action: string; after?: unknown }) => rows.push(row),
      actor: { userId: id, capabilities: new Set(["people:manage"]) },
    } as never;

    await inviteUser(ctx, id, { email: false, link: true });

    const invited = rows.find((r) => r.action === "user.invited");
    const after = invited?.after as { emailed: boolean; linkTaken: boolean; tokenId: string };
    expect(after.emailed).toBe(false);
    expect(after.linkTaken).toBe(true);
    // The token id is what joins this row to the moment the link was spent.
    // Without it the two ends of the story can only be guessed at by timestamp.
    expect(after.tokenId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("who may invite whom", () => {
  /*
    An invite is a credential for somebody else's account, so it is ranked the
    same way editing them is.

    This was found by an adversarial review of the magic-link change and it was
    real. `updateUser` had refused to touch the owner's record, or anybody
    holding permissions beyond the caller's, since somebody noticed the owner's
    email was editable by any holder of `people:manage`. Inviting had neither
    check, which was survivable only while the credential could go nowhere but
    the account's own inbox: the victim was told.

    A link-only invite removes that notification. Without these guards a People
    Admin could take a set-password link for the account owner, use it, and
    `consumeToken` would revoke every session the owner held. Silent takeover,
    by somebody the permission model says is junior.
  */

  const actorWith = (userId: string, capabilities: string[]) =>
    ({ db, audit: () => {}, actor: { userId, kind: "user", capabilities: new Set(capabilities) } }) as never;

  it("refuses to invite the account owner", async () => {
    const ownerId = await makeUser({ isOwner: true });
    const junior = await makeUser();

    await expect(
      inviteUser(actorWith(junior, ["people:manage"]), ownerId, { email: false, link: true })
    ).rejects.toThrow(/owner/i);

    const tokens = await db.select().from(s.authTokens).where(eq(s.authTokens.userId, ownerId));
    expect(tokens, "a refused invite must not have minted a credential").toHaveLength(0);
  });

  it("still lets the system actor invite anybody, including the owner", async () => {
    /*
      `scripts/invite-link.mts` and `bootstrap-owner.mts` run as the system and
      exist precisely to recover an account nobody can currently sign in to,
      the owner's included. Both new guards exempt the system actor, and they
      have to: running either script needs a shell on the host and the database
      credentials, which is already more authority than any profile confers, so
      a check there would be theatre that broke the recovery path.
    */
    const ownerId = await makeUser({ isOwner: true });
    const ctx = { db, audit: () => {}, actor: { userId: ownerId, kind: "system", capabilities: new Set() } } as never;

    const result = await inviteUser(ctx, ownerId, { email: false, link: true });
    expect(result.link).toMatch(/set-password/);
  });

  it("lets the owner invite themselves", async () => {
    // Re-inviting yourself is how you recover your own account, and the guard
    // must not be so broad that it takes that away.
    const ownerId = await makeUser({ isOwner: true });
    const result = await inviteUser(actorWith(ownerId, ["people:manage"]), ownerId, {
      email: false,
      link: true,
    });
    expect(result.link).toMatch(/set-password/);
  });

  it("refuses to invite somebody whose permissions exceed the caller's", async () => {
    const strongProfile = await makeProfile("strong", ["people:manage", "rates:view_cost", "settings:manage"]);
    const target = await makeUser({ profileId: strongProfile });
    const weak = await makeUser();

    await expect(
      inviteUser(actorWith(weak, ["people:manage"]), target, { email: false, link: true })
    ).rejects.toThrow(/exceed your own/i);
  });

  it("allows an equal to invite an equal", async () => {
    const profile = await makeProfile("equal", ["people:manage"]);
    const target = await makeUser({ profileId: profile });
    const peer = await makeUser();

    const result = await inviteUser(actorWith(peer, ["people:manage"]), target, {
      email: false,
      link: true,
    });
    expect(result.link).toMatch(/set-password/);
  });
});

describe("two invites at once", () => {
  /*
    Driven through `withTransaction`, because that is the only way this can be
    tested at all.

    The first version of this test called the service with a bare handle, so
    every statement autocommitted and `SELECT ... FOR UPDATE` released the row
    the instant it was taken. Removing the lock entirely did not fail it, which
    is the whole point of mutation-testing a guard: the test looked like it
    covered the race and covered nothing. A route wraps mutations in a
    transaction, so the test has to as well.

    And repeated, because racing once proves nothing: the first `Promise.all`
    in a process is serialised by connection establishment.
  */
  const realCtx = (userId: string) =>
    createCtx({
      actor: {
        userId,
        profileId: null,
        baseKey: null,
        capabilities: new Set(["people:manage"]) as never,
        kind: "user",
        timezone: "America/New_York",
        isOwner: false,
      } as never,
    });

  it("leaves one live token, not two", async () => {
    const inviter = await makeUser();
    // No capabilities, so the rank guard is satisfied and the race is what is
    // actually under test here rather than the authorization added beside it.
    const target = await makeUser({ profileId: await makeProfile("race-target", []) });
    const ctx = realCtx(inviter);

    // Warm the pool so the first round is not serialised by connect latency.
    await withTransaction(ctx, (tx) => inviteUser(tx, target, { email: true, link: false }));

    for (let round = 0; round < 12; round++) {
      await db.delete(s.authTokens).where(eq(s.authTokens.userId, target));

      await Promise.all([
        withTransaction(ctx, (tx) => inviteUser(tx, target, { email: false, link: true })).catch(() => {}),
        withTransaction(ctx, (tx) => inviteUser(tx, target, { email: false, link: true })).catch(() => {}),
      ]);

      const live = await db
        .select()
        .from(s.authTokens)
        .where(and(eq(s.authTokens.userId, target), isNull(s.authTokens.usedAt)));

      expect(live, `round ${round}: two live invite links is what superseding is for`).toHaveLength(1);
    }
  });
});

describe("the token itself", () => {
  it("is stored hashed, never in the clear", async () => {
    const id = await makeUser();
    await inviteUser(ctxFor(id), id);
    const token = await linkTokenFor(id);

    const [row] = await db.select().from(s.authTokens).where(eq(s.authTokens.userId, id));
    expect(row!.tokenHash).not.toBe(token);
    expect(row!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("works once", async () => {
    const id = await makeUser();
    await inviteUser(ctxFor(id), id);
    const token = await linkTokenFor(id);

    await consumeToken(token, GOOD);
    await expect(consumeToken(token, "another-fine-passphrase-99")).rejects.toThrow(
      /expired or has already been used/
    );
  });

  it("records that a credential was set, and against which token", async () => {
    /*
      The moment the credential actually changes hands used to write nothing at
      all. `user.invited` recorded who issued a link and by which channel, and
      then the trail stopped: an auditor asking "who set this account up" found
      an invitation and a `used_at` timestamp and had to infer the join.

      Both ends now name the same token id, so the question is answerable
      rather than inferable. Found by an adversarial review, which pointed out
      that the commit's own stated standard was not met by its own code.
    */
    const id = await makeUser();
    await inviteUser(ctxFor(id), id);
    const token = await linkTokenFor(id);

    await consumeToken(token, GOOD);

    const [row] = await db
      .select()
      .from(s.auditLog)
      .where(and(eq(s.auditLog.action, "user.password_set_via_token"), eq(s.auditLog.entityId, id)));

    expect(row, "spending a token must leave a trace").toBeTruthy();
    const after = row!.after as { purpose: string; tokenId: string; sessionsRevoked: boolean };
    expect(after.purpose).toBe("invite");
    expect(after.sessionsRevoked).toBe(true);

    // The same token the invite recorded, so the two ends of the story join.
    const [tokenRow] = await db.select().from(s.authTokens).where(eq(s.authTokens.userId, id));
    expect(after.tokenId).toBe(tokenRow!.id);
  });

  it("is refused once expired", async () => {
    const id = await makeUser();
    await inviteUser(ctxFor(id), id);
    const token = await linkTokenFor(id);

    await db
      .update(s.authTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(s.authTokens.userId, id));

    expect(await peekToken(token)).toBeNull();
    await expect(consumeToken(token, GOOD)).rejects.toThrow();
  });

  it("supersedes an earlier outstanding token of the same purpose", async () => {
    // Otherwise a stolen link keeps working after the owner has quietly asked
    // for another, which is exactly the case that matters.
    const id = await makeUser();
    await inviteUser(ctxFor(id), id);
    const first = await linkTokenFor(id);

    await db.delete(s.outboundMessages);
    await inviteUser(ctxFor(id), id);
    const second = await linkTokenFor(id);

    expect(await peekToken(first)).toBeNull();
    expect(await peekToken(second)).not.toBeNull();
  });
});

describe("consumeToken", () => {
  it("sets a password that actually verifies", async () => {
    const id = await makeUser();
    await inviteUser(ctxFor(id), id);
    await consumeToken(await linkTokenFor(id), GOOD);

    const [user] = await db.select().from(s.users).where(eq(s.users.id, id));
    expect(await verifyPassword(user!.passwordHash, GOOD)).toBe(true);
    expect(await verifyPassword(user!.passwordHash, "not the password")).toBe(false);
  });

  it("refuses a password the policy rejects", async () => {
    const id = await makeUser();
    await inviteUser(ctxFor(id), id);
    await expect(consumeToken(await linkTokenFor(id), "x")).rejects.toBeInstanceOf(AppError);
  });

  it("revokes every existing session for that person", async () => {
    // A reset after somebody else got in, that leaves the intruder signed in,
    // has achieved nothing.
    const id = await makeUser();
    await db.insert(s.sessions).values({
      id: newId(),
      userId: id,
      tokenHash: "deadbeef".repeat(8),
      expiresAt: new Date(Date.now() + 86_400_000),
      absoluteExpiresAt: new Date(Date.now() + 30 * 86_400_000),
    });

    await inviteUser(ctxFor(id), id);
    await consumeToken(await linkTokenFor(id), GOOD);

    const left = await db.select().from(s.sessions).where(eq(s.sessions.userId, id));
    expect(left.filter((r) => r.revokedAt == null)).toHaveLength(0);
  });
});

describe("requestPasswordReset", () => {
  it("queues a reset for a real address", async () => {
    const id = await makeUser();
    const [user] = await db.select().from(s.users).where(eq(s.users.id, id));
    await requestPasswordReset(user!.email);

    const token = await linkTokenFor(id);
    expect((await peekToken(token))?.purpose).toBe("password_reset");

    // The token existing is not the point: the person has to receive it. This
    // named itself "queues a reset" while asserting nothing about the mail.
    const [queued] = await db.select().from(s.outboundMessages).where(eq(s.outboundMessages.userId, id));
    expect(queued!.kind).toBe("password_reset");
    expect(queued!.toAddress).toBe(user!.email);
    expect(queued!.state).toBe("queued");
  });

  it("sends one email when two requests arrive together", async () => {
    /*
      Three things had to be got right before this test meant anything, and each
      wrong version passed with the lock deleted.

      **Asserting one live token proves nothing.** `issue()` supersedes any
      outstanding token before inserting its own, so two racing issuances still
      leave one live token. The count of *emails* is the property a person
      notices, and the one that survives superseding.

      **Holding `FOR UPDATE` from another connection proves nothing either.**
      Inserting a token takes a key-share lock on its parent user row through
      the foreign key, which conflicts with the holder's `FOR UPDATE` whether or
      not this code takes a lock of its own. That version measured Postgres.

      **Racing once proves nothing.** The first `Promise.all` in a process is
      serialised by connection establishment: the pool has no open connections,
      so one call gets there while the other is still connecting. Measured with
      the lock deleted, round 0 sent one email and rounds 1 and 2 sent two. A
      single-shot race is exactly round 0. Hence the warm-up and the repeat.
    */
    await Promise.all(Array.from({ length: 4 }, () => db.execute(sql`select 1`)));

    for (let round = 0; round < 3; round++) {
      const id = await makeUser();
      const [user] = await db.select().from(s.users).where(eq(s.users.id, id));

      await Promise.all([requestPasswordReset(user!.email), requestPasswordReset(user!.email)]);

      const mailed = await db.select().from(s.outboundMessages).where(eq(s.outboundMessages.userId, id));
      expect(mailed, `round ${round}: two racing requests must not both send`).toHaveLength(1);

      const live = (await db.select().from(s.authTokens).where(eq(s.authTokens.userId, id))).filter(
        (t) => t.usedAt == null
      );
      expect(live, `round ${round}: two live reset links defeat superseding`).toHaveLength(1);
    }
  });

  it("does not send a second link within the minute floor", async () => {
    const id = await makeUser();
    const [user] = await db.select().from(s.users).where(eq(s.users.id, id));

    await requestPasswordReset(user!.email);
    await requestPasswordReset(user!.email);

    expect(await db.select().from(s.outboundMessages).where(eq(s.outboundMessages.userId, id))).toHaveLength(1);
  });

  it("does nothing, and says nothing, for an address that does not exist", async () => {
    // The endpoint's answer is identical either way. This asserts the half that
    // is testable here: no token, no mail, no throw.
    await expect(requestPasswordReset("nobody-at-all@example.test")).resolves.toBeUndefined();
    expect(await db.select().from(s.authTokens)).toHaveLength(0);
    expect(await db.select().from(s.outboundMessages)).toHaveLength(0);
  });

  it("does nothing for an archived person", async () => {
    const id = await makeUser({ archivedAt: new Date() });
    const [user] = await db.select().from(s.users).where(eq(s.users.id, id));
    await requestPasswordReset(user!.email);
    expect(await db.select().from(s.authTokens).where(eq(s.authTokens.userId, id))).toHaveLength(0);
  });
});
