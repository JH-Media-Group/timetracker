/**
 * Every writer of the settings row declares itself.
 *
 * The settings row is cached for five seconds per process, and two things have
 * to happen wherever it is written:
 *
 *   1. `ctx._buffers.settingsWritten = true`, so **this** transaction stops
 *      reading a cached row it can now see past.
 *   2. `runAfterCommit(ctx, invalidateSettings)`, so every **later** reader
 *      stops reading the row this write replaced.
 *
 * Two of the three writers did both. `nextNumber` did neither, and nothing
 * noticed, because the rule lived in prose next to the two that complied. That
 * is the shape this repo keeps rediscovering: a rule stated where the compliant
 * code is, and no executable check that the next call site follows it.
 *
 * It was not harmless. `nextNumber` moves `invoice_next_seq`, so a numbering
 * change landing inside the cache window read a stale sequence as its `before`,
 * `assertSequenceIsFree` compared the request against a number already drawn,
 * and the counter went back onto an invoice that exists. The next invoice for
 * that client collides on the unique index.
 *
 * A grep test rather than a runtime one, deliberately: the failure it guards
 * against is a *new* call site, which by definition no runtime test covers yet.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(process.cwd(), "src");

/** Statements that write the settings row, however they are spelled. */
const WRITE_PATTERNS = [
  // Drizzle: .update(s.settings) / .update(schema.settings)
  /\.update\(\s*(?:s|schema)\.settings\s*\)/g,
  // Raw SQL, which is how the sequence bump is written.
  /UPDATE\s+settings\b/gi,
];

/**
 * Files allowed to write it without declaring, with the reason.
 *
 * Empty on purpose. An entry here is a decision somebody has to defend in
 * review, which is the point of making it a list rather than a condition.
 */
const EXEMPT = new Map<string, string>();

function sourceFiles(): string[] {
  return globSync("**/*.ts", { cwd: ROOT })
    .map((f) => join(ROOT, f))
    .filter((f) => !f.endsWith(".d.ts"));
}

describe("settings writers", () => {
  it("all declare settingsWritten and invalidate after commit", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles()) {
      const text = readFileSync(file, "utf8");
      const rel = relative(process.cwd(), file).replace(/\\/g, "/");

      // `settings.ts` defines the mechanism; it is the one file that is allowed
      // to mention these without being a caller of them.
      if (rel.endsWith("src/server/services/settings.ts")) continue;

      const writes = WRITE_PATTERNS.some((re) => {
        re.lastIndex = 0;
        return re.test(text);
      });
      if (!writes) continue;

      if (EXEMPT.has(rel)) continue;

      const declares = text.includes("settingsWritten = true");
      const invalidates = /runAfterCommit\(\s*\w+\s*,\s*invalidateSettings\s*\)/.test(text);

      if (!declares || !invalidates) {
        offenders.push(
          `  ${rel} writes the settings row but ` +
            [!declares && "does not set _buffers.settingsWritten", !invalidates && "does not invalidate after commit"]
              .filter(Boolean)
              .join(" and ")
        );
      }
    }

    expect(
      offenders,
      "a settings write that does not declare itself serves a stale row to this transaction, " +
        "to every reader for the next five seconds, or both:\n" +
        offenders.join("\n")
    ).toEqual([]);
  });

  it("finds the writers it is supposed to be checking", () => {
    // A grep test that matches nothing passes for ever. This asserts the
    // pattern still finds the call sites we know about, so a rename to
    // `db.update(settings)` cannot quietly empty the check.
    const found = sourceFiles().filter((file) => {
      const text = readFileSync(file, "utf8");
      return WRITE_PATTERNS.some((re) => {
        re.lastIndex = 0;
        return re.test(text);
      });
    });

    const names = found.map((f) => relative(process.cwd(), f).replace(/\\/g, "/"));
    expect(names).toContain("src/server/services/settings.ts");
    expect(names).toContain("src/server/services/invoice-config.ts");
    expect(names).toContain("src/server/services/invoices.ts");
  });
});
