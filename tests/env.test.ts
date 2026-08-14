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
import { proxyConfigurationError } from "../src/server/proxy-check";

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

/**
 * The proxy configuration rule.
 *
 * Two bugs live here, and both were shipped before being caught.
 *
 * The first: `TRUST_PROXY` unset in production means `clientIp()` returns null
 * for every request, so sign-in gets no per-address limit and `sessions.ip`
 * records nothing. Neither symptom announces itself.
 *
 * The second was the fix for the first. Asserting it at module load also
 * asserted it during `next build`, which runs with `NODE_ENV=production` and
 * imports every route module: the build failed with "Failed to collect page
 * data for /api/v1/auth/providers". A build is not a deployment. The check now
 * lives in `src/instrumentation.ts`, which Next runs on server start and not
 * during the build, and the rule itself lives in a module with no imports so
 * that file can be bundled for the edge runtime.
 */
describe("proxy configuration", () => {
  it("is satisfied outside production, whatever the value", () => {
    expect(proxyConfigurationError("development", undefined)).toBeNull();
    expect(proxyConfigurationError("test", undefined)).toBeNull();
  });

  it("is satisfied in production when the answer is given either way", () => {
    expect(proxyConfigurationError("production", "1")).toBeNull();
    expect(proxyConfigurationError("production", "0")).toBeNull();
  });

  it("refuses production with no answer", () => {
    expect(proxyConfigurationError("production", undefined)).toMatch(/TRUST_PROXY must be set/);
    expect(proxyConfigurationError("production", "")).toMatch(/TRUST_PROXY must be set/);
  });

  /**
   * The instrumentation hook is what runs it, and it must not reach anything
   * that cannot be bundled for the edge runtime. Importing `env.ts` there pulls
   * in dotenv, which needs node's `crypto`, and the build fails outright.
   */
  it("is checked from instrumentation, which imports nothing heavy", () => {
    const hook = readFileSync(`${process.cwd()}/src/instrumentation.ts`, "utf8");
    expect(hook, "the startup check has to actually call the rule").toContain("proxyConfigurationError");
    expect(hook, "importing env.ts here breaks the edge bundle").not.toMatch(/from ["']@\/server\/env["']/);

    const rule = readFileSync(`${process.cwd()}/src/server/proxy-check.ts`, "utf8");
    expect(rule, "the rule module must stay import-free so it bundles for edge").not.toMatch(/^\s*import\s/m);
  });

  /** And the value has to be one the reader understands. */
  it("declares TRUST_PROXY as a closed set, not a free string", () => {
    expect(
      source,
      'TRUST_PROXY is read as `v === "1" || v === "true"`, so a free string lets ' +
        "TRUST_PROXY=yes look configured while meaning false"
    ).toMatch(/TRUST_PROXY:\s*z[\s\S]{0,120}?\.enum\(/);
  });
});
