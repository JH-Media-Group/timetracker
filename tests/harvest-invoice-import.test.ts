/**
 * The invoice importer only inserts, and it must not wake the mail job.
 *
 * `scripts/harvest-invoice-import.mts` writes SQL aimed at the live database of
 * a working business. Two of its properties are worth more than the rest, and
 * neither is visible in the output:
 *
 *   It writes invoices and their children and nothing else. Clients, projects,
 *   tasks, people, rates and time entries carry changes made by hand in Tally
 *   that no export knows about, and an import that "corrects" them destroys
 *   work nobody can get back.
 *
 *   It writes the escalation level every open invoice has already passed. Tally
 *   chases overdue invoices by email at 1, 14 and 30 days past due, and most of
 *   these invoices are long past all three. Import them as never chased and the
 *   next run of the mail job sends real dunning emails to real clients about
 *   invoices some of which are years old and already settled between people.
 *
 * The second one has no failure mode that looks like a failure. The import
 * succeeds, the numbers reconcile, and the damage happens later and elsewhere.
 * That is exactly the shape this repository has learned to write a check for.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withoutComments } from "./support/client-surface";
import {
  batchesByOwner,
  cents,
  lit,
  parseCsv,
  reminderLevel,
  stateOf,
} from "../scripts/harvest-invoice-import.mts";
import { ESCALATION_DAYS } from "../src/server/services/invoice-reminders";

const SCRIPT = join(process.cwd(), "scripts/harvest-invoice-import.mts");
const source = readFileSync(SCRIPT, "utf8");
const code = withoutComments(source);

describe("the Harvest invoice importer", () => {
  it("emits no update, no delete and no upsert", () => {
    const forbidden = [
      { pattern: /\bDELETE\s+FROM\b/i, what: "a delete" },
      { pattern: /\bUPDATE\s+[a-z_]+\s+SET\b/i, what: "an update" },
      { pattern: /\bON\s+CONFLICT\b/i, what: "an upsert" },
      { pattern: /\bTRUNCATE\b/i, what: "a truncate" },
      { pattern: /\bDROP\s+(TABLE|DATABASE)\b/i, what: "a drop" },
    ];

    const found = forbidden.filter(({ pattern }) => pattern.test(code)).map(({ what }) => what);
    expect(
      found,
      "This SQL is aimed at a live billing database. Insert is the only verb it may use."
    ).toEqual([]);
  });

  it("inserts into invoices and their children, and nothing else", () => {
    const targets = [...code.matchAll(/INSERT INTO ([a-z_]+)/g)].map((m) => m[1]);

    expect(targets.length, "no insert found at all, so this test proves nothing").toBeGreaterThan(0);
    expect(
      [...new Set(targets)].sort(),
      "People, projects, tasks, rates and time entries hold work done by hand in " +
        "Tally. An invoice import has no business writing to any of them."
    ).toEqual(["invoice_line_items", "invoice_payments", "invoice_projects", "invoices"]);
  });

  it("maps a Harvest write-off to Tally's written_off, not to its closed", () => {
    /*
      Both systems have a state called "closed" and they do not mean the same
      thing. Mapping the word to the word files every write-off under a heading
      that means something else, and the money still adds up afterwards.
    */
    expect(stateOf("closed")).toBe("written_off");
    expect(stateOf("draft")).toBe("draft");
    expect(stateOf("paid")).toBe("paid");
    expect(stateOf("open")).toBe("open");
    // Harvest's own UI distinguishes sent from late; the API does not, and
    // neither does Tally, which derives lateness from the due date.
    expect(stateOf("sent")).toBe("open");
    expect(stateOf("late")).toBe("open");
  });

  it("computes the escalation level an overdue invoice has already passed", () => {
    // Read from the service rather than restated, so a change to the schedule
    // cannot leave the importer quietly one step behind it.
    expect(ESCALATION_DAYS).toEqual([1, 14, 30]);

    expect(reminderLevel("2026-01-10", "2026-01-01")).toBe(0); // not yet due
    expect(reminderLevel("2026-01-01", "2026-01-01")).toBe(0); // due today
    expect(reminderLevel("2026-01-01", "2026-01-02")).toBe(1); // one day late
    expect(reminderLevel("2026-01-01", "2026-01-15")).toBe(2); // fourteen
    expect(reminderLevel("2026-01-01", "2026-01-31")).toBe(3); // thirty
    expect(reminderLevel("2020-01-01", "2026-01-01")).toBe(3); // years late, still three
  });

  it("writes the reminder level with the due date it was reached against", () => {
    /*
      The level alone is not enough and the schema says so: it counts only
      against the due date it was reached for, so a level stored without its
      date reads as belonging to a different schedule and the escalation starts
      from zero. Both have to be written, and only for open invoices.
    */
    expect(code).toMatch(/reminder_level/);
    expect(code).toMatch(/reminder_due_date/);
    expect(
      code,
      "the level must be paired with the invoice's own due date"
    ).toMatch(/state === "open" \? `\$\{lit\(inv\.due_date\)\}::date` : "NULL"/);
  });

  it("never splits one invoice's children across two statements", () => {
    /*
      The child guards skip an invoice that already has any line items or any
      payments, which is right because they are written as a set. It makes the
      batching part of the correctness: split a set down the middle and the
      first statement inserts half, then the second finds rows already there
      and drops the rest. That cost 21 line items on the first real run.
    */
    const rows = [
      { inv: "a" }, { inv: "a" }, { inv: "b" }, { inv: "b" }, { inv: "b" },
      { inv: "c" }, { inv: "d" }, { inv: "d" },
    ];

    for (const size of [1, 2, 3, 4, 7, 100]) {
      const batches = batchesByOwner(rows, (r) => r.inv, size);
      expect(batches.flat(), `size ${size} lost or reordered rows`).toEqual(rows);

      const seen = new Set<string>();
      for (const batch of batches) {
        const owners = new Set(batch.map((r) => r.inv));
        for (const o of owners) {
          expect(seen.has(o), `owner ${o} appears in two batches at size ${size}`).toBe(false);
          seen.add(o);
        }
      }
    }
  });

  it("escapes a quote in a description rather than breaking out of the literal", () => {
    // Descriptions are somebody's free text and they contain apostrophes.
    expect(lit("O'Brien")).toBe("'O''Brien'");
    expect(lit("'; DROP TABLE invoices; --")).toBe("'''; DROP TABLE invoices; --'");
    expect(lit("")).toBe("NULL");
    expect(lit(null)).toBe("NULL");
  });

  it("reads money as integer cents", () => {
    expect(cents("1234.56")).toBe(123_456);
    expect(cents("-20.00")).toBe(-2_000);
    expect(cents("1,234.56")).toBe(123_456);
    expect(cents("")).toBe(0);
  });

  it("reads a CSV whose fields contain commas, quotes and newlines", () => {
    const csv = [
      "a,b,c",
      '1,"has, a comma",3',
      '4,"has ""quotes""",6',
      '7,"has',
      'a newline",9',
    ].join("\n");

    expect(parseCsv(csv)).toEqual([
      { a: "1", b: "has, a comma", c: "3" },
      { a: "4", b: 'has "quotes"', c: "6" },
      { a: "7", b: "has\na newline", c: "9" },
    ]);
  });
});
