/**
 * The base profile matrix in BACKEND_PRD §7.2 agrees with the code.
 *
 * That table is the document people read to answer "who can see cost rates",
 * and until this file existed nothing compared it to `BASE_PROFILES`. It had
 * drifted: rate editing shipped for Project Manager and the two rate rows
 * still read as though only Administrator held them, so the PRD described a
 * product where a manager cannot price their own project.
 *
 * The repo's rule is that a rule stated in prose gets a check in the same
 * commit. This is that check for the one table where being wrong is a
 * permissions answer rather than a typo.
 *
 * Only rows naming a literal capability are compared. Group rows ("time own",
 * "invoice:*") stand for several capabilities and are deliberately vaguer than
 * the code; asserting on them would mean encoding the grouping here, which is
 * a second place to drift.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BASE_PROFILES, type BaseProfileKey, type Capability } from "@/server/auth/capabilities";

/** Column order in the table, left to right after the label column. */
const COLUMNS: BaseProfileKey[] = [
  "member",
  "project_manager",
  "people_admin",
  "accounting",
  "executive_manager",
  "administrator",
];

interface Row {
  capability: string;
  cells: string[];
}

function matrixRows(): Row[] {
  const prd = readFileSync(join(process.cwd(), "docs/BACKEND_PRD.md"), "utf8");
  const header = "| Capability group | Member | Project Mgr |";
  const start = prd.indexOf(header);
  expect(start, "the §7.2 matrix header moved or was reworded").toBeGreaterThan(-1);

  const rows: Row[] = [];
  for (const line of prd.slice(start).split(/\r?\n/).slice(2)) {
    if (!line.startsWith("|")) break; // the table ends at the first non-row
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    expect(cells.length, `wrong column count in: ${line}`).toBe(COLUMNS.length + 1);
    rows.push({ capability: cells[0]!, cells: cells.slice(1) });
  }
  return rows;
}

/** A tick, or a reach word, both mean the profile holds it. Empty means it does not. */
function holds(cell: string): boolean {
  if (cell === "") return false;
  expect(["\u2713", "team", "all"], `unexpected cell "${cell}"`).toContain(cell);
  return true;
}

describe("BACKEND_PRD §7.2 base profile matrix", () => {
  const rows = matrixRows();

  it("is a table this test can actually read", () => {
    // Guards the parse itself: a rename that made every row unmatched would
    // otherwise leave this file passing with nothing to compare.
    expect(rows.length).toBeGreaterThanOrEqual(10);
    expect(rows.filter((r) => r.capability.includes(":") && !r.capability.endsWith("*")).length)
      .toBeGreaterThanOrEqual(8);
  });

  for (const row of rows) {
    // Group labels ("time own", "invoice:*") cover several capabilities each.
    if (!/^[a-z_]+:[a-z_]+$/.test(row.capability)) continue;
    const capability = row.capability as Capability;

    it(`${capability} matches BASE_PROFILES`, () => {
      for (const [index, key] of COLUMNS.entries()) {
        const profile = BASE_PROFILES[key];
        const documented = holds(row.cells[index]!);
        const actual = profile.capabilities.includes(capability);
        expect(
          actual,
          `${profile.name}: the PRD says ${documented ? "holds" : "does not hold"} ` +
            `${capability}, the code says ${actual ? "holds" : "does not hold"}`
        ).toBe(documented);
      }
    });

    it(`${capability} uses a reach word only where the profile has reach`, () => {
      for (const [index, key] of COLUMNS.entries()) {
        const cell = row.cells[index]!;
        if (cell !== "team" && cell !== "all") continue;
        expect(
          BASE_PROFILES[key].othersScope,
          `${BASE_PROFILES[key].name}: the cell reads "${cell}" but othersScope is ` +
            `"${BASE_PROFILES[key].othersScope}"`
        ).toBe(cell);
      }
    });
  }
});
