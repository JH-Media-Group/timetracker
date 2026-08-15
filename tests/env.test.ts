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

/**
 * The build-phase escape hatch, and its limits.
 *
 * `src/server/env.ts` skips validation when NEXT_PHASE says a build is running,
 * so the Docker image can be built without production secrets. That is a hole
 * in a fail-fast guard, and a hole in a guard is exactly the kind of thing this
 * repo keeps finding written in a comment and asserted nowhere. These are the
 * assertions.
 */
describe("the build-phase escape hatch", () => {
  const source = readFileSync(resolve(process.cwd(), "src/server/env.ts"), "utf8");

  it("keys only off NEXT_PHASE, which only a build sets", () => {
    const guard = /const IS_NEXT_BUILD = ([^;]+);/.exec(source);
    expect(guard, "IS_NEXT_BUILD is gone or renamed; this test needs updating").not.toBeNull();
    expect(guard![1]).toBe('process.env.NEXT_PHASE === "phase-production-build"');
  });

  /**
   * This test used to assert the opposite, and was wrong in a way that mattered.
   *
   * It forbade the guard from mentioning NODE_ENV, on the theory that widening
   * the condition would weaken it. That reasoning assumed `NEXT_PHASE` could
   * only be set by Next, which is false: it is an ordinary environment variable,
   * and an adversarial review booted the production image with it set and no
   * SESSION_SECRET, getting a healthy server signing sessions with zero bytes.
   *
   * NODE_ENV cannot be the discriminator either, because `next build` runs with
   * NODE_ENV=production too. So the defence is not the condition at all, it is
   * that the placeholder throws when read. That is what these now assert.
   */
  it("poisons the placeholder secret rather than trusting the condition", () => {
    expect(source).toMatch(/get SESSION_SECRET\(\)/);
    expect(source).toContain("sessionSecretIsPlaceholder");
    const getter = /get SESSION_SECRET\(\): string \{[\s\S]*?\n  \},/.exec(source)?.[0] ?? "";
    expect(getter, "the getter must throw, not warn and continue").toMatch(/throw new Error/);
  });

  it("only marks the placeholder when the environment supplied nothing", () => {
    const block = /function readForBuild\(\) \{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
    expect(block).toMatch(/sessionSecretIsPlaceholder = !blank\(process\.env\.SESSION_SECRET\)/);
    expect(block).toMatch(/databaseUrlIsPlaceholder = !blank\(process\.env\.DATABASE_URL\)/);
  });

  it("does not mutate process.env", () => {
    // Writing the stand-ins into the process environment changes global state
    // for everything in the process and any child it spawns, and it made the
    // credential scan flag `SESSION_SECRET = <identifier>` besides. The
    // stand-ins are passed into read() as fallbacks instead.
    const block = /function readForBuild\(\) \{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
    expect(block).not.toMatch(/process\.env\.\w+\s*=[^=]/);
    expect(block).toMatch(/return read\(BUILD_PLACEHOLDERS\)/);
  });

  /**
   * The hole the poisoned getter cannot see.
   *
   * A review signed in against the production image using the placeholder as a
   * real `SESSION_SECRET`, copied straight out of this file. The getter only
   * fires when env.ts substituted the value itself, so an operator pasting the
   * constant, or a deploy template filled in from it, got a working server
   * signing with a key published in the source.
   */
  it("refuses the build placeholder when it arrives as a real secret", async () => {
    expect(source).toMatch(/PLACEHOLDER_SECRETS = new Set\(\[[\s\S]*Buffer\.alloc\(32\)\.toString\("base64"\)[\s\S]*\]\)/);

    // And prove it, rather than trusting that the set is consulted.
    const zero = Buffer.alloc(32).toString("base64");
    const { execFileSync } = await import("node:child_process");
    const run = () =>
      execFileSync(process.execPath, ["-e", 'import("./src/server/env.ts").catch(e=>{console.error(e.message);process.exit(3)})'], {
        env: { ...process.env, SESSION_SECRET: zero, DATABASE_URL: "postgres://x:y@127.0.0.1:5432/z", NEXT_PHASE: "" },
        encoding: "utf8",
        stdio: "pipe",
      });
    expect(run, "the zero-byte placeholder must be rejected as a session secret").toThrow();
  });

  it("substitutes only the two variables a build cannot supply", () => {
    const block = /const BUILD_PLACEHOLDERS = \{[\s\S]*?\} as const;/.exec(source)?.[0] ?? "";
    const keys = [...block.matchAll(/^\s{2}([A-Z_]+):/gm)].map((m) => m[1]);
    expect(keys.sort()).toEqual(["DATABASE_URL", "SESSION_SECRET"]);
  });

  /**
   * The stand-in is generated, not written down, and that is load bearing.
   *
   * It used to be thirty-two zero bytes as a constant. A review copied the
   * constant out of this file, passed it as a real `SESSION_SECRET` to the
   * production image, and signed in: the poisoned getter only fires when env.ts
   * substituted the value itself, so a pasted one looks entirely legitimate.
   * Generating it per build removes the thing there was to copy.
   */
  it("generates the build stand-in rather than hard-coding one to copy", () => {
    const block = /const BUILD_PLACEHOLDERS = \{[\s\S]*?\} as const;/.exec(source)?.[0] ?? "";
    expect(block).toMatch(/SESSION_SECRET:\s*randomBytes\(32\)\.toString\("base64"\)/);
    expect(block, "a literal here is a key an operator can paste into a deployment").not.toMatch(
      /SESSION_SECRET:\s*"[A-Za-z0-9+/]{20,}={0,2}"/
    );
  });

  it("still refuses the old zero-byte constant, which is in the git history", () => {
    // Removing it from the file does not remove it from every clone and every
    // published page that quoted it.
    expect(source).toMatch(/PLACEHOLDER_SECRETS = new Set\(\[[\s\S]*Buffer\.alloc\(32\)\.toString\("base64"\)[\s\S]*\]\)/);
  });
});
