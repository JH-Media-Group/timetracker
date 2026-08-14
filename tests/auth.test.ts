/**
 * Authentication and authorization.
 *
 * The tests that matter here are the negative ones: a session that should not
 * resolve, a capability that should not be granted, a scope that should not
 * widen. A passing "the administrator can do everything" test proves very
 * little on its own.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, db, makeClient, makeProject, makeUser, resetDb, s } from "./helpers";
import { newId } from "@/server/db/ids";
import { syncBaseProfiles, baseProfileId } from "@/server/auth/profiles";
import { BASE_PROFILES, CAPABILITIES } from "@/server/auth/capabilities";
import { actorForToken, createSession, revokeAllSessions, revokeSession } from "@/server/auth/session";
import { checkPasswordPolicy, hashPassword, verifyPassword } from "@/server/auth/password";
import { consume, resetLocalBuckets } from "@/server/auth/rate-limit";
import { createCtx, assertCan, can } from "@/server/ctx";
import { AppError } from "@/server/errors";

let profiles: Record<string, string>;

beforeEach(async () => {
  await resetDb();
  resetLocalBuckets();
  const synced = await syncBaseProfiles(db);
  profiles = synced.ids;
});

afterAll(async () => {
  await closeDb();
});

/* ================================================================ profiles */

describe("base profiles", () => {
  it("creates all six on first sync", async () => {
    const rows = await db.select().from(s.permissionProfiles);
    expect(rows).toHaveLength(6);
    expect(rows.every((r) => r.isBase)).toBe(true);
  });

  it("is idempotent", async () => {
    const again = await syncBaseProfiles(db);
    expect(again.created).toHaveLength(0);
    expect(again.updated).toHaveLength(0);
  });

  it("repairs a profile whose capabilities have drifted", async () => {
    // This is the scenario the sync exists for: a release adds a capability and
    // every stored profile is one array behind.
    await db
      .update(s.permissionProfiles)
      .set({ capabilities: ["time:create_own"] })
      .where(eq(s.permissionProfiles.baseKey, "administrator"));

    const result = await syncBaseProfiles(db);
    expect(result.updated).toContain("administrator");

    const [admin] = await db
      .select({ capabilities: s.permissionProfiles.capabilities })
      .from(s.permissionProfiles)
      .where(eq(s.permissionProfiles.baseKey, "administrator"));
    expect(admin!.capabilities).toHaveLength(CAPABILITIES.length);
  });

  it("recreates a base profile somebody deleted", async () => {
    await db.delete(s.permissionProfiles).where(eq(s.permissionProfiles.baseKey, "accounting"));
    const result = await syncBaseProfiles(db);
    expect(result.created).toContain("accounting");
  });

  it("grants no profile a capability that does not exist", () => {
    for (const [key, definition] of Object.entries(BASE_PROFILES)) {
      for (const capability of definition.capabilities) {
        expect(CAPABILITIES, `${key} declares ${capability}`).toContain(capability);
      }
    }
  });

  it("keeps cost rates to administrators alone", () => {
    const withCost = Object.entries(BASE_PROFILES)
      .filter(([, d]) => d.capabilities.includes("rates:view_cost"))
      .map(([k]) => k);
    expect(withCost).toEqual(["administrator"]);
  });

  it("keeps settings and the audit log to administrators alone", () => {
    for (const capability of ["settings:manage", "audit:view"] as const) {
      const holders = Object.entries(BASE_PROFILES)
        .filter(([, d]) => d.capabilities.includes(capability))
        .map(([k]) => k);
      expect(holders, capability).toEqual(["administrator"]);
    }
  });

  it("gives a Member no reach over anybody else", () => {
    const member = BASE_PROFILES.member;
    expect(member.othersScope).toBe("none");
    for (const capability of member.capabilities) {
      expect(capability).not.toMatch(/_others$/);
      expect(capability).not.toMatch(/^(invoice|settings|audit|rates):/);
    }
  });

  it("finds a base profile by key", async () => {
    await expect(baseProfileId(db, "member")).resolves.toBe(profiles.member);
  });
});

/* ================================================================ sessions */

describe("sessions", () => {
  it("resolves a fresh session to an actor with its profile's capabilities", async () => {
    const userId = await makeUser({ profileId: profiles.accounting! });
    const { token } = await createSession(userId);

    const actor = await actorForToken(token);
    expect(actor?.userId).toBe(userId);
    expect(actor?.baseKey).toBe("accounting");
    expect(actor?.capabilities.has("invoice:manage")).toBe(true);
    expect(actor?.capabilities.has("rates:view_cost")).toBe(false);
  });

  it("stores only a hash, so the table is not a set of working credentials", async () => {
    const userId = await makeUser({ profileId: profiles.member! });
    const { token } = await createSession(userId);

    const [row] = await db.select({ tokenHash: s.sessions.tokenHash }).from(s.sessions);
    expect(row!.tokenHash).not.toBe(token);
    expect(row!.tokenHash).toHaveLength(64); // sha256 hex
  });

  it("refuses an unknown token", async () => {
    await expect(actorForToken("not-a-real-token")).resolves.toBeNull();
  });

  it("refuses a revoked session immediately", async () => {
    const userId = await makeUser({ profileId: profiles.member! });
    const { token } = await createSession(userId);
    await revokeSession(token);
    await expect(actorForToken(token)).resolves.toBeNull();
  });

  it("refuses an expired session", async () => {
    const userId = await makeUser({ profileId: profiles.member! });
    const { token } = await createSession(userId);
    await db.update(s.sessions).set({ expiresAt: new Date(Date.now() - 1000) });
    await expect(actorForToken(token)).resolves.toBeNull();
  });

  it("cannot have an absolute cap that precedes its rolling expiry", async () => {
    // The database makes the invariant structural rather than something the
    // session code has to remember: a rolling extension can never outrun the
    // ninety-day ceiling, because such a row cannot be written at all.
    const userId = await makeUser({ profileId: profiles.member! });
    await createSession(userId);

    await expect(
      db.update(s.sessions).set({
        expiresAt: new Date(Date.now() + 86_400_000),
        absoluteExpiresAt: new Date(Date.now() - 1000),
      })
    ).rejects.toThrow();
  });

  it("refuses a session past its absolute cap", async () => {
    const userId = await makeUser({ profileId: profiles.member! });
    const { token } = await createSession(userId);

    const past = new Date(Date.now() - 1000);
    await db.update(s.sessions).set({ expiresAt: past, absoluteExpiresAt: past });
    await expect(actorForToken(token)).resolves.toBeNull();
  });

  it("refuses an archived person on their next request, not their next sign-in", async () => {
    const userId = await makeUser({ profileId: profiles.member! });
    const { token } = await createSession(userId);
    expect(await actorForToken(token)).not.toBeNull();

    await db.update(s.users).set({ archivedAt: new Date() }).where(eq(s.users.id, userId));
    await expect(actorForToken(token)).resolves.toBeNull();
  });

  it("revokes every session for a person at once", async () => {
    const userId = await makeUser({ profileId: profiles.member! });
    const a = await createSession(userId);
    const b = await createSession(userId);

    const revoked = await revokeAllSessions(userId);
    expect(revoked).toBe(2);
    await expect(actorForToken(a.token)).resolves.toBeNull();
    await expect(actorForToken(b.token)).resolves.toBeNull();
  });
});

/* =============================================================== passwords */

describe("passwords", () => {
  it("round-trips a password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash).toMatch(/^\$argon2id\$/);
    await expect(verifyPassword(hash, "correct horse battery staple")).resolves.toBe(true);
    await expect(verifyPassword(hash, "wrong")).resolves.toBe(false);
  });

  it("returns false rather than throwing for an account with no password", async () => {
    await expect(verifyPassword(null, "anything")).resolves.toBe(false);
  });

  it("returns false rather than throwing on a corrupt hash", async () => {
    await expect(verifyPassword("not-a-hash", "anything")).resolves.toBe(false);
  });

  it("asks for length rather than symbol soup", () => {
    expect(checkPasswordPolicy("short")).not.toBeNull();
    expect(checkPasswordPolicy("aaaaaaaaaaaaaaa")).not.toBeNull();
    expect(checkPasswordPolicy("chalk marmalade window")).toBeNull();
    expect(checkPasswordPolicy("jhmediagroup2026")).not.toBeNull();
    // Rejects a passphrase built around the word everybody reaches for first.
    expect(checkPasswordPolicy("my password123")).not.toBeNull();
  });
});

/* ============================================================ rate limiting */

describe("rate limiting", () => {
  it("allows the first attempts and refuses the eleventh", async () => {
    const key = `test:${newId()}`;
    for (let i = 0; i < 10; i += 1) {
      const result = await consume("auth", key);
      expect(result.allowed, `attempt ${i + 1}`).toBe(true);
    }
    const eleventh = await consume("auth", key);
    expect(eleventh.allowed).toBe(false);
    expect(eleventh.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("keeps buckets separate per key", async () => {
    const a = `test:${newId()}`;
    const b = `test:${newId()}`;
    for (let i = 0; i < 10; i += 1) await consume("auth", a);
    await expect(consume("auth", b)).resolves.toMatchObject({ allowed: true });
  });
});

/* ============================================================= capabilities */

describe("assertCan", () => {
  const ctxFor = (capabilities: string[]) =>
    createCtx({
      actor: {
        userId: newId(),
        profileId: newId(),
        baseKey: "member",
        capabilities: new Set(capabilities as never),
        kind: "user",
        timezone: "UTC",
        isOwner: false,
      },
    });

  it("allows a held capability", () => {
    const ctx = ctxFor(["invoice:manage"]);
    expect(can(ctx, "invoice:manage")).toBe(true);
    expect(() => assertCan(ctx, "invoice:manage")).not.toThrow();
  });

  it("refuses one that is not held, with a 403", () => {
    const ctx = ctxFor(["time:create_own"]);
    expect(can(ctx, "invoice:manage")).toBe(false);
    try {
      assertCan(ctx, "invoice:manage");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe("forbidden");
      expect((e as AppError).status).toBe(403);
    }
  });
});
