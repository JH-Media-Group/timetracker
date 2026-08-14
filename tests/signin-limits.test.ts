/**
 * What the sign-in limiter rations, and what it must not.
 *
 * This file exists because two successive versions of that route had a comment
 * claiming a safety property the code did not have, which is the failure this
 * project has now written down three times.
 *
 * Version one bucketed every caller under the literal string "unknown", because
 * without a trusted proxy `clientIp` returns null for everybody. Ten anonymous
 * POSTs, needing no account and no password since the check runs before the
 * user lookup, locked out all eleven staff for fifteen minutes.
 *
 * Version two skipped that bucket and leaned on the per-email one, and its
 * comment said the class was gone. It was not: the per-email bucket counted
 * every *attempt*, so anybody who knew an address could spend ten requests on
 * it and lock the owner out, and the owner could not clear it by typing the
 * correct password because the correct password counted too. Eleven staff on
 * one guessable domain made that 110 requests to lock out the company.
 *
 * So the property is now asserted rather than described: failures count,
 * successes do not, and a success clears what came before.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { POST } from "@/app/api/v1/auth/signin/route";
import { resetLocalBuckets } from "@/server/auth/rate-limit";
import { db } from "@/server/db/client";
import * as s from "@/server/db/schema";
import { hashPassword } from "@/server/auth/password";
import { newId } from "@/server/db/ids";
import { eq } from "drizzle-orm";
import { resetDb, seedProfiles } from "./helpers";

const PASSWORD = "correct-horse-battery-staple";

/**
 * A fresh address per test.
 *
 * `resetDb()` truncates tables; it does not reach Redis, and these buckets
 * live there when REDIS_URL is set. Sharing one address between tests meant
 * each one inherited the previous one's failures, which showed up as an
 * unrelated test getting a 429. Unique identities are cheaper than teaching
 * the suite to clean a second store.
 */
let EMAIL = "";

function request(email: string, password: string): Request {
  return new Request("http://localhost:3200/api/v1/auth/signin", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:3200" },
    body: JSON.stringify({ email, password }),
  });
}

// The route takes a NextRequest; a Request is structurally sufficient for the
// fields it reads (json, headers), and typing it otherwise would need a server
// to produce one.
const post = (email: string, password: string) =>
  POST(request(email, password) as unknown as Parameters<typeof POST>[0]);

describe("sign-in rate limiting", () => {
  beforeEach(async () => {
    await resetDb();
    resetLocalBuckets();
    EMAIL = `limits-${newId()}@sweep.invalid`;
    const profiles = await seedProfiles();
    await db.insert(s.users).values({
      id: newId(),
      email: EMAIL,
      firstName: "Rate",
      lastName: "Limit",
      passwordHash: await hashPassword(PASSWORD),
      profileId: profiles.member!,
      isOwner: false,
      weeklyCapacitySeconds: 144000,
    });
  });

  it("lets a correct password through repeatedly", async () => {
    // Twelve successes, comfortably past the ten-point bucket. If successes
    // counted, this would start refusing on the eleventh.
    for (let i = 0; i < 12; i++) {
      const res = await post(EMAIL, PASSWORD);
      expect(res.status, `sign-in ${i + 1} of 12 should succeed`).toBe(200);
    }
  });

  it("refuses after ten failures and says how long", async () => {
    for (let i = 0; i < 10; i++) {
      expect((await post(EMAIL, "wrong")).status).toBe(401);
    }

    const res = await post(EMAIL, "wrong");
    expect(res.status, "the eleventh failure must be rate limited").toBe(429);

    const body = (await res.json()) as { meta?: { retry_after_seconds?: number } };
    expect(
      body.meta?.retry_after_seconds,
      "a 429 has to say when to come back, or the caller can only guess"
    ).toBeGreaterThan(0);
  });

  /**
   * The property that stops this being a lockout weapon: the account's owner
   * can always clear it by knowing their own password.
   */
  it("clears the count when the right password arrives", async () => {
    for (let i = 0; i < 9; i++) {
      expect((await post(EMAIL, "wrong")).status).toBe(401);
    }

    expect((await post(EMAIL, PASSWORD)).status, "one below the limit must still work").toBe(200);

    // The nine failures are gone, so there are ten more before any refusal.
    for (let i = 0; i < 10; i++) {
      expect((await post(EMAIL, "wrong")).status, `failure ${i + 1} after a success`).toBe(401);
    }
    expect((await post(EMAIL, "wrong")).status).toBe(429);
  });

  /**
   * The limit has to hold under concurrency, which is the only kind of guessing
   * worth stopping.
   *
   * A previous version read the count and then acted on it, so a reviewer sent
   * twenty simultaneous wrong passwords at a bucket with one point left and got
   * twenty 401s: every request read the same count before any of them wrote.
   * Consuming atomically first is what fixes it, and this is the assertion that
   * says so.
   */
  it("holds when the guesses arrive all at once", async () => {
    const attempts = 40;
    const statuses = await Promise.all(
      Array.from({ length: attempts }, () => post(EMAIL, "wrong").then((r) => r.status))
    );

    const verified = statuses.filter((s) => s === 401).length;
    const refused = statuses.filter((s) => s === 429).length;

    expect(verified + refused, "every request should be one or the other").toBe(attempts);
    expect(
      verified,
      `${verified} of ${attempts} concurrent guesses reached password verification; the bucket allows 10`
    ).toBeLessThanOrEqual(10);
    expect(refused, "the rest must be refused").toBe(attempts - verified);
  });

  /** A locked account must not lock the rest of the company. */
  it("keeps the buckets separate per address", async () => {
    for (let i = 0; i < 11; i++) await post(EMAIL, "wrong");
    expect((await post(EMAIL, "wrong")).status).toBe(429);

    const other = `someone-else-${newId()}@sweep.invalid`;
    const res = await post(other, "wrong");
    expect(res.status, "an unrelated address must not inherit the lockout").toBe(401);
  });

  /**
   * A caller with no address must not be able to spend anybody else's budget.
   *
   * This is the original bug, asserted directly: requests that carry no
   * identifiable address create no shared state, so no number of them affects
   * a real account's ability to sign in.
   */
  it("lets a real sign-in through after a flood of anonymous attempts", async () => {
    for (let i = 0; i < 40; i++) {
      await post(`flood-${newId()}-${i}@nowhere.invalid`, "wrong");
    }

    const res = await post(EMAIL, PASSWORD);
    expect(res.status, "a flood of unrelated attempts must not lock a real account out").toBe(200);
  });

  it("does not reveal whether the account exists", async () => {
    const missing = await post(`nobody-${newId()}@sweep.invalid`, "wrong");
    const wrong = await post(EMAIL, "wrong");

    // Everything but the request id, which is unique per request by design and
    // is the one field that is meant to differ.
    const shape = async (res: Awaited<ReturnType<typeof post>>) => {
      const { request_id: _ignored, ...rest } = (await res.json()) as Record<string, unknown>;
      return rest;
    };

    expect(missing.status).toBe(wrong.status);
    expect(await shape(missing)).toEqual(await shape(wrong));
  });

  /** Archived people are refused, and their failures are counted like anyone's. */
  it("refuses an archived account", async () => {
    await db.update(s.users).set({ archivedAt: new Date() }).where(eq(s.users.email, EMAIL));
    expect((await post(EMAIL, PASSWORD)).status).toBe(401);
  });
});
