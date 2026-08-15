/**
 * The CSV reader, tested against the shapes that actually broke it.
 *
 * Every case here is one the Harvest export contains. The first version of the
 * import split on newlines and commas, read a note with an embedded newline as
 * three records, and reported the export's date range as "📸 Screenshots here".
 * That bug was invisible in the totals until someone read the log, which is the
 * argument for these being tests rather than a comment at the top of the file.
 */

import { describe, expect, it } from "vitest";
import { parseCsv, num, yes, cents } from "../scripts/lib/csv";

describe("parseCsv", () => {
  it("reads a plain file", () => {
    expect(parseCsv("a,b\n1,2\n3,4")).toEqual([
      { a: "1", b: "2" },
      { a: "3", b: "4" },
    ]);
  });

  it("keeps a quoted field's commas out of the column count", () => {
    const rows = parseCsv('Client,Notes\nAcme,"one, two, three"');
    expect(rows).toEqual([{ Client: "Acme", Notes: "one, two, three" }]);
  });

  it("keeps a quoted newline inside one record", () => {
    // The case that started this. Naive splitting turns this into two records,
    // and the second one has a note where a date should be.
    const rows = parseCsv('Date,Notes\n2016-01-21,"Some note\n📸 Screenshots here"\n2016-01-22,Fine');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.Date).toBe("2016-01-21");
    expect(rows[0]!.Notes).toBe("Some note\n📸 Screenshots here");
    expect(rows[1]!.Date).toBe("2016-01-22");
  });

  it("unescapes a doubled quote", () => {
    expect(parseCsv('a\n"He said ""hi"""')).toEqual([{ a: 'He said "hi"' }]);
  });

  it("treats CRLF as one break", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([{ a: "1", b: "2" }]);
  });

  it("strips a byte order mark from the first header", () => {
    // Otherwise the first column is named "﻿Date" and every lookup of "Date"
    // returns undefined, which reads downstream as "every row is blank".
    // Two things prevent it (the explicit strip and the header trim), so this
    // asserts the outcome rather than either mechanism.
    const rows = parseCsv("﻿Date,Hours\n2026-01-01,1.5");
    expect(rows[0]!.Date).toBe("2026-01-01");
  });

  it("does not invent a record from a trailing newline or a blank line", () => {
    expect(parseCsv("a\n1\n\n2\n")).toHaveLength(2);
  });

  /**
   * This test used to assert the opposite, and the assertion was the bug.
   *
   * Padding a short record looks tidy and hides the thing that caused it. A
   * single stray quote in an unquoted field absorbs a delimiter, shifts every
   * later column left, and drops the overflow off the end; `num("")` then turns
   * the missing value into 0, and a zero-hour, zero-rate entry lands with
   * nothing raised. A width mismatch means the parse already went wrong.
   */
  it("throws on a record narrower than the header", () => {
    expect(() => parseCsv("a,b,c\n1,2")).toThrow(/2 fields, header has 3/);
  });

  it("throws on a record wider than the header, rather than truncating it", () => {
    expect(() => parseCsv("a,b\n1,2,3")).toThrow(/3 fields, header has 2/);
  });

  it("names the record so a 56,000-line file can be searched", () => {
    // Record 2 is the first data row: humans count the header as line 1.
    expect(() => parseCsv("a,b\n1,2\n3")).toThrow(/record 3/);
  });

  it("throws when the file ends inside a quoted field", () => {
    expect(() => parseCsv('a,b\n1,"oops')).toThrow(/ends inside a quoted field/);
  });

  it("rejects a stray quote in an unquoted field", () => {
    // `1,6" pipe,3` used to yield {a:"1", b:'6 pipe,3', c:""}: the quote
    // vanished, the delimiter was absorbed, and the row lost a column. The
    // stray quote opens a run that never closes, so the unterminated-quote
    // check catches it first, which is the more accurate of the two errors.
    expect(() => parseCsv('a,b,c\n1,6" pipe,3')).toThrow(/ends inside a quoted field/);
  });
});

describe("num", () => {
  it("reads thousands separators", () => {
    // parseFloat("1,324.79") is 1. A number wrong by three orders of magnitude
    // that still looks like a number is worse than a throw.
    expect(num("1,324.79")).toBe(1324.79);
    expect(num("12,000.0")).toBe(12000);
  });

  it("treats absent and empty as zero", () => {
    expect(num(undefined)).toBe(0);
    expect(num("")).toBe(0);
    expect(num("   ")).toBe(0);
  });

  it("throws on something that is not a number at all", () => {
    expect(() => num("n/a")).toThrow(/Not a number/);
  });
});

describe("yes and cents", () => {
  it("reads Harvest's booleans", () => {
    expect(yes("Yes")).toBe(true);
    expect(yes("yes")).toBe(true);
    expect(yes("No")).toBe(false);
    expect(yes(undefined)).toBe(false);
  });

  it("rounds money once, to integer cents", () => {
    expect(cents("1,324.79")).toBe(132479);
    expect(cents("0.005")).toBe(1);
    expect(cents(undefined)).toBe(0);
  });
});
