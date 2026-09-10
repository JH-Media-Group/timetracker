/* Synthetic invoice fixtures preserve parser edge cases; keep source invoices and operational results outside Git. */

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/* --------------------------------------------------------------- arguments */

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : (args[i + 1] ?? fallback);
};

const PACK = flag("--pack", "C:/Users/jason/Downloads/harvest_invoice_pack");
const OUT = flag("--out", "C:/Users/jason/Downloads/harvest_invoices_csv");
const LIMIT = Number(flag("--limit", "0")) || 0;

/* ------------------------------------------------------------------- money */

/* Synthetic invoice fixtures preserve parser edge cases; keep source invoices and operational results outside Git. */
function money(text: string): number | null {
  const m = text.match(/(-?)\$\s*([\d,]+)(?:\.(\d{2}))?/);
  if (!m) return null;
  const whole = Number(m[2]!.replace(/,/g, ""));
  const frac = Number(m[3] ?? "0");
  if (!Number.isFinite(whole) || !Number.isFinite(frac)) return null;
  const cents = whole * 100 + frac;
  return m[1] === "-" ? -cents : cents;
}

const dollars = (cents: number | null) => (cents == null ? "" : (cents / 100).toFixed(2));

/* --------------------------------------------------------------------- csv */

/** RFC 4180: quote everything, double the quotes inside. Notes contain both. */
const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
const row = (values: unknown[]) => values.map(cell).join(",");

/* ------------------------------------------------------------------ parsing */

export interface Line {
  itemType: string;
  description: string;
  quantity: string;
  unitPriceCents: number | null;
  amountCents: number | null;
}

export interface Invoice {
  file: string;
  number: string;
  client: string;
  subject: string;
  issueDate: string;
  dueDate: string;
  terms: string;
  poNumber: string;
  subtotalCents: number | null;
  taxCents: number | null;
  discountCents: number | null;
  paymentsCents: number | null;
  amountDueCents: number | null;
  lines: Line[];
  pages: number;
  /** Row-shaped lines whose item type this script does not recognise. */
  unknownTypes: string[];
}

/* Synthetic invoice fixtures preserve parser edge cases; keep source invoices and operational results outside Git. */
const ITEM_TYPES = "Service|Product|Direct Costs";

/**
 * A line item, or null when this is a continuation of the one above.
 *
 * The shape that identifies one: an item type, then a description, then three
 * columns of numbers at the end. A wrapped description has none of those
 * numbers, which is what makes the two distinguishable without measuring
 * columns.
 */
const LINE_ITEM = new RegExp(
  `^(${ITEM_TYPES})\\s{2,}(.*?)\\s{2,}(-?[\\d,]+\\.\\d{2})\\s{2,}(-?\\$[\\d,.]+)\\s{2,}(-?\\$[\\d,.]+)\\s*$`
);

/** The same row with no description, which Harvest emits for an unlabelled line. */
const LINE_ITEM_BARE = new RegExp(
  `^(${ITEM_TYPES})\\s{2,}(-?[\\d,]+\\.\\d{2})\\s{2,}(-?\\$[\\d,.]+)\\s{2,}(-?\\$[\\d,.]+)\\s*$`
);

/**
 * The tail of a row, with no opinion about what stands in front of it.
 *
 * Anything shaped like this is a line item whatever its type column says, so a
 * type this script has not been told about is caught and reported rather than
 * being appended to the description above it and quietly losing its money.
 */
const ROW_TAIL = /\s{2,}(-?[\d,]+\.\d{2})\s{2,}(-?\$[\d,.]+)\s{2,}(-?\$[\d,.]+)\s*$/;

/* Synthetic invoice fixtures preserve parser edge cases; keep source invoices and operational results outside Git. */
function totalFor(lines: string[], label: string): number | null {
  const pattern = new RegExp(`\\b${label}\\b(?:\\s*\\([^)]*\\))?\\s{2,}(-?\\$[\\d,.]+)`, "i");
  // Last wins: a multi-page invoice repeats nothing, but a description could
  // mention the word, and the totals block is always at the end.
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i]!.match(pattern);
    if (m) return money(m[1]!);
  }
  return null;
}

/** `Label   value` in the header block, where the value runs to end of line. */
function headerField(lines: string[], label: string): string {
  const pattern = new RegExp(`\\b${label}\\b\\s{2,}(.+?)\\s*$`);
  for (const line of lines) {
    const m = line.match(pattern);
    if (m) return m[1]!.trim();
  }
  return "";
}

export function parse(file: string, text: string): Invoice {
  /* Synthetic invoice fixtures preserve parser edge cases; keep source invoices and operational results outside Git. */
  const raw = text.split(/\r?\n|\f/);
  const lines = raw.filter((l) => l.trim().length > 0);

  const headerIndex = lines.findIndex((l) => /\bItem Type\b/.test(l) && /\bAmount\b/.test(l));
  const header = headerIndex === -1 ? lines : lines.slice(0, headerIndex);
  const body = headerIndex === -1 ? [] : lines.slice(headerIndex + 1);

  /* Synthetic invoice fixtures preserve parser edge cases; keep source invoices and operational results outside Git. */
  const rightColumn = /\s{2,}(Invoice ID|Issue Date|Due Date|PO Number)\b.*$/i;
  /*
    Stripped here rather than after the loop below. The wrapped remainder is
    appended to the end of this string, and a strip that ran afterwards would
    delete from "Invoice ID" to end of string and take the appended half with
    it. "Example County Economic / Development" arrived as "Example County Economic" for exactly that reason.
  */
  let client = headerField(header, "Invoice For").replace(rightColumn, "").trim();
  const forIndex = header.findIndex((l) => /\bInvoice For\b/.test(l));
  if (forIndex !== -1) {
    for (const line of header.slice(forIndex + 1)) {
      const left = line.split(/\s{4,}/).filter((p) => p.trim())[0]?.trim() ?? "";
      if (!left) continue;
      if (/^(Invoice ID|Issue Date|Due Date|Subject|PO Number|From)\b/i.test(left)) continue;
      if (/^\d{2}\/\d{2}\/\d{4}/.test(left)) continue;
      client += ` ${left}`;
    }
  }
  client = client.replace(/\s+/g, " ").trim();

  const dueRaw = headerField(header, "Due Date");
  const terms = dueRaw.match(/\(([^)]*)\)/)?.[1]?.replace(/\s+/g, " ").trim() ?? "";

  const items: Line[] = [];
  const unknownTypes: string[] = [];
  for (const line of body) {
    const full = line.match(LINE_ITEM);
    if (full) {
      items.push({
        itemType: full[1]!,
        description: full[2]!.trim(),
        quantity: full[3]!.replace(/,/g, ""),
        unitPriceCents: money(full[4]!),
        amountCents: money(full[5]!),
      });
      continue;
    }
    const bare = line.match(LINE_ITEM_BARE);
    if (bare) {
      items.push({
        itemType: bare[1]!,
        description: "",
        quantity: bare[2]!.replace(/,/g, ""),
        unitPriceCents: money(bare[3]!),
        amountCents: money(bare[4]!),
      });
      continue;
    }
    /*
      Shaped like a row but with a type we do not know. Falling through to the
      continuation branch is what hid "Direct Costs" for a whole pass, so this
      is collected and reported instead: the invoice is rejected by name, and
      the type it used is in the reason.
    */
    if (ROW_TAIL.test(line) && !/\b(Subtotal|Payments|Amount Due|Tax|Discount|Credit|Deposit)\b/i.test(line)) {
      const type = line.split(/\s{2,}/)[0]?.trim();
      if (type) unknownTypes.push(type);
      continue;
    }
    // A continuation of the description above, unless we are into the totals.
    if (items.length && !/\b(Subtotal|Payments|Amount Due|Tax|Discount|Credit|Deposit)\b/i.test(line)) {
      if (/^\s*Page \d+ of \d+\s*$/.test(line)) continue;
      // Some invoices repeat the column header on each page. Appended to the
      // row above it, it would read as part of somebody's description.
      if (/\bItem Type\b/.test(line) && /\bAmount\b/.test(line)) continue;
      const text = line.trim();
      if (text) items[items.length - 1]!.description += ` ${text}`;
    }
  }

  return {
    file,
    number: headerField(header, "Invoice ID"),
    client,
    subject: headerField(header, "Subject"),
    issueDate: headerField(header, "Issue Date"),
    dueDate: dueRaw.replace(/\s*\([^)]*\)\s*/, "").trim(),
    terms,
    poNumber: headerField(header, "PO Number"),
    subtotalCents: totalFor(lines, "Subtotal"),
    taxCents: totalFor(lines, "Tax"),
    discountCents: totalFor(lines, "Discount"),
    paymentsCents: totalFor(lines, "Payments"),
    amountDueCents: totalFor(lines, "Amount Due"),
    lines: items.map((l) => ({ ...l, description: l.description.trim() })),
    // Counted from the page breaks themselves. Not every invoice carries a
    // "Page n of m" footer, and the ones that do not were all reading as 1.
    pages: text.split("\f").filter((p) => p.trim().length > 0).length || 1,
    unknownTypes: [...new Set(unknownTypes)],
  };
}

/* ---------------------------------------------------------------- checking */

/* Synthetic invoice fixtures preserve parser edge cases; keep source invoices and operational results outside Git. */
function checkableSubtotal(inv: Invoice): { cents: number | null; source: "document" | "amount due" } {
  if (inv.subtotalCents != null) return { cents: inv.subtotalCents, source: "document" };
  const adjusted = inv.taxCents != null || inv.discountCents != null || inv.paymentsCents != null;
  if (!adjusted && inv.amountDueCents != null) return { cents: inv.amountDueCents, source: "amount due" };
  return { cents: null, source: "document" };
}

/** Every reason this invoice is not trustworthy enough to publish. */
export function problems(inv: Invoice): string[] {
  const out: string[] = [];
  if (!inv.number) out.push("no invoice number");
  if (!inv.client) out.push("no client");
  if (inv.amountDueCents == null) out.push("no amount due");
  if (inv.unknownTypes.length) {
    out.push(`unrecognised item type: ${inv.unknownTypes.join(", ")}`);
  }

  const lineSum = inv.lines.reduce((a, l) => a + (l.amountCents ?? 0), 0);
  const anyLineUnparsed = inv.lines.some((l) => l.amountCents == null);
  if (anyLineUnparsed) out.push("a line item has no amount");

  const { cents: subtotal, source } = checkableSubtotal(inv);

  if (inv.lines.length && !anyLineUnparsed) {
    // No total to check against is itself a failure. An invoice that cannot be
    // checked has not passed.
    if (subtotal == null) {
      out.push("no subtotal and no plain amount due to check the lines against");
    } else if (lineSum !== subtotal) {
      /* Synthetic invoice fixtures preserve parser edge cases; keep source invoices and operational results outside Git. */
      out.push(
        source === "document"
          ? `lines total ${dollars(lineSum)} but subtotal says ${dollars(subtotal)}`
          : `lines total ${dollars(lineSum)} but the invoice prints no subtotal, no payment and an amount due of ${dollars(subtotal)}`
      );
    }
  }

  if (inv.amountDueCents != null && subtotal != null) {
    /* Payments arrive negative, and so does a discount when Harvest prints one,
       so the identity is a sum rather than a subtraction. */
    const expected =
      subtotal + (inv.taxCents ?? 0) + (inv.discountCents ?? 0) + (inv.paymentsCents ?? 0);
    if (expected !== inv.amountDueCents) {
      out.push(`subtotal and payments imply ${dollars(expected)} but amount due says ${dollars(inv.amountDueCents)}`);
    }
  }

  return out;
}

/* -------------------------------------------------------------------- main */

function main() {
  const files = readdirSync(PACK).filter((f) => f.toLowerCase().endsWith(".pdf")).sort();
  const chosen = LIMIT ? files.slice(0, LIMIT) : files;
  console.log(`${files.length} PDFs in ${PACK}${LIMIT ? `, reading ${chosen.length}` : ""}`);

  mkdirSync(OUT, { recursive: true });

  const good: Invoice[] = [];
  const rejects: { file: string; why: string }[] = [];
  let done = 0;

  for (const file of chosen) {
    done++;
    if (done % 250 === 0) console.log(`  ...${done}/${chosen.length}`);

    let text: string;
    try {
      text = execFileSync("pdftotext", ["-table", join(PACK, file), "-"], {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      });
    } catch (e) {
      rejects.push({ file, why: `could not read the PDF: ${e instanceof Error ? e.message : String(e)}` });
      continue;
    }

    if (!text.trim()) {
      rejects.push({ file, why: "no text in the PDF, it may be a scan" });
      continue;
    }

    const invoice = parse(file, text);
    const why = problems(invoice);
    if (why.length) rejects.push({ file, why: why.join("; ") });
    else good.push(invoice);
  }

  /* ---- write ------------------------------------------------------------- */

  const invoicesCsv = [
    row([
      "file", "invoice_number", "client", "subject", "issue_date", "due_date", "terms",
      "po_number", "line_count", "pages", "subtotal", "subtotal_source", "tax", "discount",
      "payments", "amount_due",
    ]),
    /*
      `subtotal` is always populated and is always the figure the lines were
      checked against, so summing the column totals the pack. `subtotal_source`
      says whether the document printed it or whether Harvest left it off an
      invoice with no adjustments, where the amount due is the same number. A
      blank column would have been more faithful to the paper and less useful
      to everything downstream; this is both.
    */
    ...good.map((i) => {
      const { cents, source } = checkableSubtotal(i);
      return row([
        i.file, i.number, i.client, i.subject, i.issueDate, i.dueDate, i.terms, i.poNumber,
        i.lines.length, i.pages,
        dollars(cents), source, dollars(i.taxCents), dollars(i.discountCents),
        dollars(i.paymentsCents), dollars(i.amountDueCents),
      ]);
    }),
  ].join("\n");

  const linesCsv = [
    row(["invoice_number", "line_no", "item_type", "description", "quantity", "unit_price", "amount"]),
    ...good.flatMap((i) =>
      i.lines.map((l, n) =>
        row([i.number, n + 1, l.itemType, l.description, l.quantity, dollars(l.unitPriceCents), dollars(l.amountCents)])
      )
    ),
  ].join("\n");

  const rejectsCsv = [row(["file", "why"]), ...rejects.map((r) => row([r.file, r.why]))].join("\n");

  writeFileSync(join(OUT, "invoices.csv"), invoicesCsv + "\n", "utf8");
  writeFileSync(join(OUT, "invoice_lines.csv"), linesCsv + "\n", "utf8");
  writeFileSync(join(OUT, "invoice_rejects.csv"), rejectsCsv + "\n", "utf8");

  /* ---- reconcile --------------------------------------------------------- */

  const lineCount = good.reduce((a, i) => a + i.lines.length, 0);
  const due = good.reduce((a, i) => a + (i.amountDueCents ?? 0), 0);
  const invoiced = good.reduce((a, i) => a + (checkableSubtotal(i).cents ?? 0), 0);

  console.log("");
  console.log(`read      ${chosen.length}`);
  console.log(`written   ${good.length} invoices, ${lineCount} line items`);
  console.log(`rejected  ${rejects.length}`);
  console.log(`accounted ${good.length + rejects.length} ${good.length + rejects.length === chosen.length ? "(matches)" : "(DOES NOT MATCH)"}`);
  console.log("");
  console.log(`subtotals add to  ${dollars(invoiced)}`);
  console.log(`amounts due add to ${dollars(due)}`);
  console.log("");
  console.log(`out: ${OUT}`);

  if (rejects.length) {
    console.log("");
    console.log("Rejected, most common reasons:");
    const buckets = new Map<string, number>();
    for (const r of rejects) {
      const kind = r.why.replace(/[\d,.$-]+/g, "N").slice(0, 70);
      buckets.set(kind, (buckets.get(kind) ?? 0) + 1);
    }
    for (const [kind, n] of [...buckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      console.log(`   ${String(n).padStart(5)}  ${kind}`);
    }
  }
}

/*
  Only when run as a program. `parse` and `problems` are imported by
  tests/harvest-invoices.test.ts, and an import that converted 2,159 PDFs as a
  side effect would make the suite depend on a folder in somebody's Downloads.
*/
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) main();
