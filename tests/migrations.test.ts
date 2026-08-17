/** Deployment migration safety. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("the production migration runner", () => {
  const source = readFileSync(join(process.cwd(), "src/server/db/migrate.ts"), "utf8");

  it("takes a session-level advisory lock before touching migration state", () => {
    const lock = source.indexOf("pg_try_advisory_lock");
    const ledger = source.indexOf("await ensureLedger(sql)");

    expect(lock, "concurrent deploys must not race the migration ledgers").toBeGreaterThan(-1);
    expect(lock, "the lock must be acquired before migration state is read or written").toBeLessThan(ledger);
    expect(source).toContain("if (!migrationLock?.locked)");
  });
});
