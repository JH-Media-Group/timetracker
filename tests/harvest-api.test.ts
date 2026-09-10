/**
 * The Harvest API reader only ever reads, and never prints the token.
 *
 * `scripts/harvest-api.mts` points at the live billing system of a working
 * business, over an API that can also edit and delete. One wrong verb in a
 * refactor would change a real invoice, and nothing in the run would look
 * different until somebody noticed the data had moved.
 *
 * A source-level check, because the thing being guarded is what the file is
 * allowed to contain. Running it would prove one path; reading it proves there
 * is no other path to find.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withoutComments } from "./support/client-surface";
import { cents } from "../scripts/harvest-api.mts";

const SCRIPT = join(process.cwd(), "scripts/harvest-api.mts");
const source = readFileSync(SCRIPT, "utf8");
/* The comments describe at length the writes it refuses to do. The check is
   about code. */
const code = withoutComments(source);

describe("the Harvest API reader", () => {
  it("issues no request that could change anything", () => {
    const forbidden = [
      { pattern: /method:\s*["'`](?!GET)/gi, what: "a non-GET method" },
      { pattern: /\bmethod:\s*\w+\b(?<!GET)/g, what: "a method from a variable" },
      { pattern: /["'`](POST|PUT|PATCH|DELETE)["'`]/g, what: "a mutating verb" },
    ];

    const found = forbidden.filter(({ pattern }) => pattern.test(code)).map(({ what }) => what);

    expect(
      found,
      "harvest-api.mts reads a live billing system. Every request must be a GET, " +
        "and the method must be a literal so this check can see it."
    ).toEqual([]);
  });

  it("has exactly one function that touches the network", () => {
    /*
      The value of the no-write check above depends on there being one place a
      request can be made. A second fetch call site is a second thing to audit,
      and the next person will only remember to audit the first.
    */
    const fetches = [...code.matchAll(/\bfetch\s*\(/g)];
    expect(fetches, "more than one fetch call site").toHaveLength(1);
    expect(code, "the single call site must hard-code the method").toMatch(/method:\s*"GET"/);
  });

  it("takes its credentials from the environment and nowhere else", () => {
    expect(code).toMatch(/process\.env\.HARVEST_ACCESS_TOKEN/);
    expect(code).toMatch(/process\.env\.HARVEST_ACCOUNT_ID/);

    // Not from an argument: those persist in shell history.
    const fromArgs = /flag\(\s*"--(token|secret|key|password)/i.test(code);
    expect(fromArgs, "a credential must not be a command-line flag").toBe(false);
  });

  it("never puts the token where it could be read back", () => {
    /*
      A token in an error message reaches a terminal, a log file and whatever
      scrolls past somebody's shoulder. The failure path is the one that gets
      least attention and leaks most.
    */
    const logsToken = /console\.(log|error|warn)[^\n]*\b(TOKEN|ACCESS_TOKEN|Authorization)\b/.test(code);
    expect(logsToken, "the token must not be logged").toBe(false);

    const writesToken = /writeFileSync[^\n]*\bTOKEN\b/.test(code);
    expect(writesToken, "the token must not be written to a file").toBe(false);
  });

  it("refuses to run at all without credentials", () => {
    // Not a warning and not a partial run: an unauthenticated request to this
    // API answers 401 for every call and burns the rate limit doing it.
    expect(code).toMatch(/if\s*\(!ACCOUNT_ID\s*\|\|\s*!TOKEN\)/);
  });

  it("converts money to integer cents, rounding rather than truncating", () => {
    /*
      Harvest sends dollars as a JSON number. Truncating turns a value that
      arrives a hair under a cent into a value a whole cent short, and doing
      that a few thousand times is how a reconciliation drifts.
    */
    expect(cents(1234.56)).toBe(123_456);
    expect(cents(0.1 + 0.2)).toBe(30);
    expect(cents(-9000)).toBe(-900_000);
    expect(cents(null)).toBeNull();
    expect(cents(undefined)).toBeNull();
  });
});
