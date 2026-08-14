/**
 * The environment schema against what is actually read.
 *
 * `env.ts` declares a zod schema and then builds the object it validates by
 * naming each variable explicitly, which is the right way round: a stray
 * `process.env` key cannot wander in. The failure mode of that shape is a
 * variable declared in the schema and never read, and it fails *silently*,
 * because zod is perfectly happy to validate `undefined` for an optional field.
 *
 * That happened to `TRUST_PROXY`. The consequence was invisible in development
 * and would have been invisible in production too: `clientIp()` returns null
 * without it, so every sign-in attempt shares one rate-limit bucket regardless
 * of where it came from, and `sessions.ip` and the audit log record nothing.
 *
 * The check is textual because the two lists are textual. A runtime check would
 * need every variable set to a distinguishable value, which is a harder test
 * that catches the same single bug.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "src/server/env.ts"), "utf8");

function block(startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  expect(start, `could not find ${startMarker} in env.ts`).toBeGreaterThan(-1);
  const end = source.indexOf(endMarker, start);
  expect(end, `could not find ${endMarker} after ${startMarker}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

/** The keys the schema declares. */
const declared = new Set(
  [...block("const schema = z.object({", "\n});").matchAll(/^\s{2}([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]!)
);

/** The keys `read()` actually pulls out of process.env. */
const read = new Set(
  [...block("const raw = {", "\n  };").matchAll(/([A-Z][A-Z0-9_]*):\s*blank\(process\.env\.([A-Z][A-Z0-9_]*)\)/g)].map(
    (m) => m[1]!
  )
);

describe("the environment schema", () => {
  it("declares at least the variables the app documents", () => {
    for (const required of ["DATABASE_URL", "SESSION_SECRET", "APP_URL", "NODE_ENV", "TRUST_PROXY"]) {
      expect(declared.has(required), `${required} is missing from the schema`).toBe(true);
    }
  });

  it("reads every variable it declares", () => {
    // NODE_ENV is read through `blank(process.env.NODE_ENV)` like the rest; if
    // a future variable is derived rather than read, add it here with a reason.
    const missing = [...declared].filter((key) => !read.has(key));
    expect(missing, `declared in the schema but never read from process.env: ${missing.join(", ")}`).toEqual([]);
  });

  it("reads nothing it has not declared", () => {
    const extra = [...read].filter((key) => !declared.has(key));
    expect(extra, `read from process.env but not in the schema: ${extra.join(", ")}`).toEqual([]);
  });

  it("names each variable consistently on both sides", () => {
    const mismatched = [
      ...block("const raw = {", "\n  };").matchAll(/([A-Z][A-Z0-9_]*):\s*blank\(process\.env\.([A-Z][A-Z0-9_]*)\)/g),
    ]
      .filter((m) => m[1] !== m[2])
      .map((m) => `${m[1]} reads ${m[2]}`);
    expect(mismatched, `the field and the variable disagree: ${mismatched.join(", ")}`).toEqual([]);
  });

  it("refuses the example session secret", () => {
    expect(source).toContain("PLACEHOLDER_SECRETS");
    expect(source).toContain("randomBytes(32)");
  });
});
