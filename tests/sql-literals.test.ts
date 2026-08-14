/**
 * No Date goes into a raw `sql` template.
 *
 * This is the fourth time the same bug has been written. A JS `Date`
 * interpolated into drizzle's `sql` tag reaches the postgres driver as an
 * object it cannot serialise, and the query throws `ERR_INVALID_ARG_TYPE: the
 * "string" argument must be of type string`. It is not a type error, so
 * TypeScript is happy; it is not a syntax error, so the build is happy; and it
 * only fires when that particular line runs.
 *
 * Where it has bitten so far:
 *
 *   - `stopTimer`, found in development because stopping a timer is something
 *     you do constantly.
 *   - `purgeDeadSessions`, which nothing called, so nothing found it until the
 *     nightly sweep got a caller.
 *   - the rolling session touch, which runs at most once an hour per session.
 *     Every session in every test and every sweep was too fresh to reach it, so
 *     it survived three adversarial reviews and a production build, and then
 *     500ed every authenticated request the first time somebody stayed signed
 *     in for an hour.
 *
 * The pattern is that the guard has to be structural, because the bug hides in
 * the code paths that run least often. `${value.toISOString()}::timestamptz` is
 * the only correct form: text, with an explicit cast so Postgres knows what it
 * received.
 */

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { readdirSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ROOT = join(process.cwd(), "src");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/** Locals that hold a Date, by how they were declared in the same file. */
function dateLocals(source: string): Set<string> {
  const names = new Set<string>();
  // `const x = new Date(...)`, `const x = ctx.now()`, `let x: Date | null`
  for (const m of source.matchAll(/\b(?:const|let)\s+(\w+)\s*(?::\s*Date[^=]*)?=\s*new Date\(/g)) {
    names.add(m[1]!);
  }
  for (const m of source.matchAll(/\b(?:const|let)\s+(\w+)\s*=\s*\w*\.?now\(\)/g)) {
    names.add(m[1]!);
  }
  // A local reassigned from `.toISOString()` is a string, whatever it is called.
  for (const m of source.matchAll(/\b(?:const|let)\s+(\w+)\s*=\s*[^;]*\.toISOString\(\)/g)) {
    names.delete(m[1]!);
  }
  return names;
}

interface Offence {
  file: string;
  line: number;
  variable: string;
  fragment: string;
}

const offences: Offence[] = [];

for (const file of sourceFiles(ROOT)) {
  const source = readFileSync(file, "utf8");
  if (!source.includes("sql`")) continue;

  const dates = dateLocals(source);
  if (dates.size === 0) continue;

  for (const template of source.matchAll(/sql`(?:[^`\\]|\\.)*`/gs)) {
    for (const interpolation of template[0].matchAll(/\$\{([^}]+)\}/g)) {
      const expression = interpolation[1]!.trim();
      // Anything that ends in a call is producing its own value; only a bare
      // identifier can be the Date itself.
      if (!/^\w+$/.test(expression)) continue;
      if (!dates.has(expression)) continue;

      offences.push({
        file: relative(process.cwd(), file).replace(/\\/g, "/"),
        line: source.slice(0, template.index! + interpolation.index!).split("\n").length,
        variable: expression,
        fragment: template[0].replace(/\s+/g, " ").slice(0, 90),
      });
    }
  }
}

describe("raw sql templates", () => {
  it("has templates to check", () => {
    // A regex that silently matches nothing would pass this file forever.
    const withTemplates = sourceFiles(ROOT).filter((f) => readFileSync(f, "utf8").includes("sql`"));
    expect(withTemplates.length).toBeGreaterThan(3);
  });

  it("never interpolates a Date", () => {
    const report = offences
      .map((o) => `  ${o.file}:${o.line}  \${${o.variable}}  in  ${o.fragment}`)
      .join("\n");

    expect(
      offences,
      "a Date in a raw sql template reaches the driver as an object it cannot " +
        "serialise, and the query throws at runtime. Use " +
        "`${value.toISOString()}::timestamptz`:\n" +
        report
    ).toEqual([]);
  });
});
