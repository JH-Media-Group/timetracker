/**
 * The delta importer only ever inserts.
 *
 * `scripts/harvest-delta.mts` exists because the original importer cannot be
 * pointed at a live database: to be correct when run twice it deletes every row
 * it previously wrote, which on the real system would have removed 56,751
 * entries including the 1,213 behind a paid invoice of $[private total removed], and would
 * have rebuilt eighteen user rates somebody had set by hand.
 *
 * The delta script's whole value is the promise in its header, that it issues
 * no DELETE and no UPDATE and never touches people, tasks or rates. That
 * promise is one careless edit away from being false, and the failure would be
 * silent and expensive, so it is asserted here rather than trusted.
 *
 * A source-level check, because the thing being guarded is what the file is
 * allowed to contain. Running it would prove one path; reading it proves there
 * is no other path to find.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withoutComments } from "./support/client-surface";

const SCRIPT = join(process.cwd(), "scripts/harvest-delta.mts");
const source = readFileSync(SCRIPT, "utf8");
// Comments describe the destructive thing it refuses to do, at length. The
// check is about code.
const code = withoutComments(source);

describe("the Harvest delta importer", () => {
  it("contains no delete and no update", () => {
    const forbidden = [
      { pattern: /\.delete\s*\(/g, what: "a delete" },
      { pattern: /\.update\s*\(/g, what: "an update" },
      { pattern: /\bDELETE\s+FROM\b/gi, what: "raw DELETE" },
      { pattern: /\bUPDATE\s+\w+\s+SET\b/gi, what: "raw UPDATE" },
      { pattern: /\.onConflict\w*\s*\(/g, what: "an upsert" },
    ];

    const found = forbidden
      .filter(({ pattern }) => pattern.test(code))
      .map(({ what }) => what);

    expect(
      found,
      "harvest-delta.mts promises it only inserts. Adding a write of another " +
        "kind breaks the reason it exists separately from harvest-import.mts."
    ).toEqual([]);
  });

  it("never writes to people, tasks, rates or invoices", () => {
    /*
      It reads all of these to resolve a row, so the check is on what it
      inserts into, not on what it mentions.
    */
    const inserts = [...code.matchAll(/\.insert\s*\(\s*s\.(\w+)/g)].map((m) => m[1]);

    expect(inserts.length, "no insert found at all, so this test proves nothing").toBeGreaterThan(0);
    expect(
      [...new Set(inserts)].sort(),
      "The delta importer adds time and nothing else. People, tasks and rates " +
        "carry changes made by hand in Tally that no export knows about."
    ).toEqual(["timeEntries"]);
  });

  it("requires a start date, so a run cannot reach the whole history", () => {
    // `--since` bounds the blast radius. Every protected entry on the real
    // system is dated 2021-01-28 to 2026-02-09, so a window that starts after
    // those cannot touch anything invoiced or rate-locked.
    expect(code).toMatch(/--since YYYY-MM-DD is required/);
  });

  it("holds back a person, day and project that already has time", () => {
    // The rule that stops the same afternoon being counted twice. Person10 had
    // five entries in Tally for 9 September totalling 6.22 hours and Harvest
    // had five totalling 6.23.
    expect(code).toMatch(/occupied\.has\(slot\)/);
    expect(code, "the override has to be explicit").toMatch(/INCLUDE_COLLISIONS/);
  });
});
