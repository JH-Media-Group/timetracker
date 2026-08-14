/**
 * The guard on the security scripts.
 *
 * `authz-sweep` and `scope-probe` insert six users, one of them an
 * administrator whose password is a string literal in the repository, then run
 * a hundred and fifty authenticated requests and delete audit rows. Until
 * `scripts/lib/dev-only.mts` existed, the only thing keeping that off the
 * production database was a sentence in a comment saying not to.
 *
 * That sentence was wrong in a specific way worth remembering: `src/server/env.ts`
 * reads `.env.local` and then `.env`, so running `pnpm authz:sweep` from a
 * deploy directory hands the script production credentials without mentioning
 * it, and `BASE` already defaults to `http://localhost:3200`, which is exactly
 * how production serves. Every ingredient was in place.
 *
 * So the rule is a function now, and this is the thing that checks it. The
 * cases below are the ones that would actually happen, not the ones that are
 * easy to write.
 */

import { describe, expect, it } from "vitest";
import { whyNotLocal } from "../scripts/lib/dev-only.mts";

const LOCAL = {
  nodeEnv: "development",
  databaseUrl: "postgres://tally:tally_dev_password@localhost:5434/tally",
  redisUrl: "redis://127.0.0.1:6382",
  base: "http://localhost:3200",
};

describe("dev-only guard", () => {
  it("allows a fully local stack", () => {
    expect(whyNotLocal(LOCAL)).toBeNull();
  });

  it("allows the stack with no Redis, which is a supported configuration", () => {
    expect(whyNotLocal({ ...LOCAL, redisUrl: undefined })).toBeNull();
  });

  it("refuses production", () => {
    expect(whyNotLocal({ ...LOCAL, nodeEnv: "production" })).toMatch(/production/i);
  });

  /**
   * The one that matters most.
   *
   * `BASE` is left at its default and looks reassuring; only the database has
   * moved. A guard that checked the URL the script talks HTTP to would pass
   * this, and the damage is done through the database handle rather than
   * through the API.
   */
  it("refuses a remote database even when everything else looks local", () => {
    const reason = whyNotLocal({
      ...LOCAL,
      databaseUrl: "postgres://tally:realpassword@db.jhmediagroup.com:5432/tally",
    });
    expect(reason).toMatch(/DATABASE_URL/);
    expect(reason).toMatch(/db\.jhmediagroup\.com/);
  });

  it("refuses a remote Redis, because clearing rate limits there is not ours to do", () => {
    expect(whyNotLocal({ ...LOCAL, redisUrl: "redis://cache.internal:6379" })).toMatch(/REDIS_URL/);
  });

  it("refuses a remote BASE", () => {
    expect(whyNotLocal({ ...LOCAL, base: "https://tally.jhmediagroup.com" })).toMatch(/BASE/);
  });

  /**
   * A private address is not this machine.
   *
   * A staging box on the LAN is exactly the kind of host that feels safe and
   * holds real data, so the allowlist is four literal loopback spellings rather
   * than a pattern that would wave through 10.x and 192.168.x.
   */
  it("refuses a private network address", () => {
    expect(whyNotLocal({ ...LOCAL, databaseUrl: "postgres://u:p@10.0.0.5:5432/tally" })).toMatch(/10\.0\.0\.5/);
    expect(whyNotLocal({ ...LOCAL, databaseUrl: "postgres://u:p@192.168.1.20:5432/tally" })).toMatch(/192\.168/);
    expect(whyNotLocal({ ...LOCAL, base: "http://staging.local:3200" })).toMatch(/staging\.local/);
  });

  /** Fails closed: unparseable is not the same as safe. */
  it("refuses what it cannot parse", () => {
    expect(whyNotLocal({ ...LOCAL, databaseUrl: "not a url" })).toMatch(/cannot be shown to be local/);
    expect(whyNotLocal({ ...LOCAL, databaseUrl: "" })).toMatch(/not set/);
  });

  it("is not fooled by a loopback host appearing elsewhere in the string", () => {
    // The database is on evil.example.com; "localhost" is only the user name.
    expect(
      whyNotLocal({ ...LOCAL, databaseUrl: "postgres://localhost:pw@evil.example.com:5432/tally" })
    ).toMatch(/evil\.example\.com/);
  });
});
