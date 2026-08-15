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

import { eq, sql } from "drizzle-orm";
import { db } from "@/server/db/client";
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

async function makeUser(over: Partial<typeof s.users.$inferInsert> = {}) {
  const [profile] = await db.select().from(s.permissionProfiles).limit(1);
  const id = newId();
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
  // Only the rows these tests make. The test database is separate from the one
  // holding the imported account, but a scoped delete is cheap insurance.
  await db.delete(s.sessions).where(sql`user_id IN (SELECT id FROM users WHERE email LIKE '%@example.test' OR email LIKE 'ghost-%@imported.invalid')`);
  await db.delete(s.users).where(sql`email LIKE '%@example.test' OR email LIKE 'ghost-%@imported.invalid'`);
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

  it("never puts the token in its own return value", async () => {
    const id = await makeUser();
    const result = await inviteUser(ctxFor(id), id);
    expect(JSON.stringify(result)).not.toMatch(/[A-Za-z0-9_-]{40,}/);
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

  it("issues one link when two requests arrive together", async () => {
    // The throttle used to check outside its transaction, so two simultaneous
    // requests both saw no recent token, both superseded, and both issued.
    const id = await makeUser();
    const [user] = await db.select().from(s.users).where(eq(s.users.id, id));

    await Promise.all([requestPasswordReset(user!.email), requestPasswordReset(user!.email)]);

    const live = (await db.select().from(s.authTokens).where(eq(s.authTokens.userId, id))).filter(
      (t) => t.usedAt == null
    );
    expect(live).toHaveLength(1);
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
