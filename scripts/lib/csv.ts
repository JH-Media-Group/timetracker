/**
 * A CSV reader, for the Harvest export files.
 *
 * Written rather than installed because the alternative is a dependency that
 * only the import script uses, and the format we have to read is small and
 * fully specified by RFC 4180.
 *
 * It has to be a real parser, not a line splitter. The Harvest time report
 * contains notes with embedded newlines and commas:
 *
 *     2016-01-21,Example Client 08,...,"Some note
 *     📸 Screenshots here",...
 *
 * so `wc -l` overcounts the records and splitting on "\n" or "," corrupts them.
 * The first attempt at reading this file did exactly that and reported a date
 * range of "📸 Screenshots here", which is how the problem was noticed.
 */

import { readFileSync } from "node:fs";

export type Row = Record<string, string>;

/**
 * Parse CSV text into rows keyed by the header names.
 *
 * Handles quoted fields, escaped quotes (`""`), embedded commas and newlines,
 * and both CRLF and LF line endings. Values arrive trimmed of surrounding
 * whitespace but not of meaningful interior content.
 */
export function parseCsv(text: string): Row[] {
  // A byte order mark on the first header would otherwise become part of the
  // first column's name, and every lookup of it would silently return undefined.
  //
  // The header trim below also removes it, because U+FEFF counts as whitespace
  // to String.trim(). This line is the explicit half of that pair, kept because
  // relying on an obscure corner of trim() to carry the whole case is the sort
  // of thing that survives until someone changes the trim. tests/csv.test.ts
  // asserts the outcome, so it holds if either half goes.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;

  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;

    if (quoted) {
      if (c === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      record.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      // A CRLF is one break, not two.
      if (c === "\r" && input[i + 1] === "\n") i++;
      record.push(field);
      field = "";
      // A blank line between records is not a record.
      if (record.length > 1 || record[0] !== "") records.push(record);
      record = [];
    } else {
      field += c;
    }
  }

  // Whatever is buffered when the file ends is the last record, unless the file
  // ended with a newline and there is nothing left.
  if (field !== "" || record.length) {
    record.push(field);
    if (record.length > 1 || record[0] !== "") records.push(record);
  }

  const [header, ...rest] = records;
  if (!header) return [];

  const keys = header.map((h) => h.trim());
  return rest.map((values) => {
    const row: Row = {};
    keys.forEach((key, i) => {
      row[key] = (values[i] ?? "").trim();
    });
    return row;
  });
}

export const readCsv = (path: string): Row[] => parseCsv(readFileSync(path, "utf8"));

/**
 * Harvest writes numbers with thousands separators: `"1,324.79"`, `"12,000.0"`.
 *
 * Parsing those with `Number()` gives NaN, and `parseFloat` gives 1 for
 * "1,324.79", which is worse: it is a plausible number that is wrong by three
 * orders of magnitude and would not look obviously broken in a total.
 */
export function num(value: string | undefined): number {
  if (!value) return 0;
  const cleaned = value.replace(/,/g, "").trim();
  if (cleaned === "") return 0;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) throw new Error(`Not a number: ${JSON.stringify(value)}`);
  return n;
}

/** Harvest writes booleans as Yes and No. */
export const yes = (value: string | undefined): boolean => value?.trim().toLowerCase() === "yes";

/** Money as integer cents, rounded once, from a decimal string. */
export const cents = (value: string | undefined): number => Math.round(num(value) * 100);
