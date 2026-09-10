/**
 * Turn the Harvest invoice PDFs into CSV, and prove the arithmetic while doing it.
 *
 *   pnpm harvest:invoices [--pack <dir>] [--out <dir>] [--clients <csv>] [--limit N]
 *
 * WHY THIS EXISTS
 *
 * Harvest has no CSV export for invoices. What it gives you is a folder of
 * rendered PDFs, which is a filing cabinet rather than data: you cannot total
 * it, search it, or reconcile it against anything. This produces the data once,
 * so the record survives the source system being switched off.
 *
 * It writes CSV and never touches the database. Whether any of this is later
 * loaded into Tally is a separate decision, and a separate program.
 *
 * WHAT MAKES IT TRUSTWORTHY
 *
 * Nobody is going to read a few thousand invoices to check a parser, so the
 * parser checks itself on every one of them:
 *
 *   the line amounts must add up to the subtotal
 *   subtotal, plus tax, plus discount, plus payments must equal the amount due
 *
 * An invoice that fails either goes to the rejects file with the reason and the
 * numbers, and stays out of the output. Money that does not add up is worse
 * than money that is missing, because the second kind gets noticed.
 *
 * Every defect found in this file so far shared one property: the run reported
 * success. A dropped row still produced an invoice and a missed discount still
 * produced a total. The checks are the only reason any of it surfaced, which is
 * also the argument for the checks having their own tests.
 *
 * The output is checkable against the source system's own reported totals, and
 * it reconciles to the cent. Note when doing that comparison that the subtotal
 * column here is BEFORE any discount and Harvest reports its total after, so
 * the two differ by the discounts and that is not an error.
 *
 * HOW IT READS THEM
 *
 * `pdftotext -table`, not `-layout`. On a simple invoice the two agree. On a
 * real one, where descriptions wrap over three lines, `-layout` puts the
 * quantities and amounts in a column of their own and the descriptions in a
 * block underneath, so a line-by-line read pairs the wrong number with the
 * wrong work. `-table` keeps each row on its own line and indents the
 * continuations, which is the whole reason this parse is possible without a
 * PDF library.
 *
 * Money is integer cents from the first parse to the last write, per the money
 * rule this repository runs on. Parsing "$1,234.56" into a float and adding
 * thousands of them is how a reconciliation ends up a few cents out with
 * nobody able to say where.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
const CLIENTS = flag("--clients", "C:/Users/jason/Downloads/harvest_client_list.csv");

/**
 * The known client names, lowercased for lookup, mapped to their real spelling.
 *
 * The source system's own client export, used to settle where a client name
 * ends and a contact or a street address begins. Without it the parser has to
 * guess, and the guess was wrong on a couple of dozen invoices whose client
 * name would then have matched nothing on the way in.
 *
 * Empty is a supported state: the run still works, it just resolves every
 * client from the first line and says so in the summary.
 */
export const knownClients = new Map<string, string>();

/** Seed the client list directly. Used by the tests, which have no CSV. */
export function setKnownClients(names: string[]): void {
  knownClients.clear();
  for (const n of names) knownClients.set(n.toLowerCase(), n);
}

/* ------------------------------------------------------------------- money */

/** "$1,234.56" and "-$1,234.56" as integer cents. Null when there is no money here. */
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

/**
 * The first field of every record in a CSV, quoting respected.
 *
 * Splitting the file on newlines and taking everything before the first comma
 * is the obvious version and it is wrong here, because a quoted address field
 * contains newlines. On this client list that invented six clients out of
 * address fragments: "Sample Person 02", "Livingston", and "Atlanta" twice.
 *
 * None of them matched anything, so the run looked clean. That is the danger:
 * an invented name that happened to equal the opening words of a real client
 * would have quietly attached somebody's invoices to the wrong account. A
 * parser used to decide what is real cannot itself be a guess.
 */
export function firstFields(text: string): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;
  let onFirst = true;
  let started = false;

  const endRecord = () => {
    if (onFirst && (started || field)) out.push(field);
    field = "";
    onFirst = true;
    started = false;
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c !== '"') { field += c; continue; }
      if (text[i + 1] === '"') { field += '"'; i++; continue; }
      quoted = false;
      continue;
    }
    if (c === '"') { quoted = true; started = true; continue; }
    if (c === ",") {
      if (onFirst) { out.push(field); onFirst = false; }
      field = "";
      started = true;
      continue;
    }
    if (c === "\r") continue;
    if (c === "\n") { endRecord(); continue; }
    field += c;
    started = true;
  }
  endRecord();
  return out;
}

/** Read the client list, if there is one. The header row is dropped. */
function loadClients(path: string): number {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return 0;
  }

  for (const raw of firstFields(text).slice(1)) {
    const name = raw.replace(/\s+/g, " ").trim();
    if (name) knownClients.set(name.toLowerCase(), name);
  }
  return knownClients.size;
}

/* --------------------------------------------------------------------- csv */

/** RFC 4180: quote everything, double the quotes inside. Notes contain both. */
const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
const row = (values: unknown[]) => values.map(cell).join(",");

/* ------------------------------------------------------------------ parsing */

/**
 * What became of an invoice, as far as the printed document can say.
 *
 * Harvest prints the Subtotal and Payments rows only when a payment exists.
 * With no payment it prints the line items and jumps straight to Amount Due,
 * which means an unpaid invoice and a written-off one have the same shape and
 * differ only in the figure: an unpaid invoice still asks for the line total,
 * a written-off one asks for nothing.
 *
 * That was worth learning from the source system rather than guessing. Reading
 * "no subtotal, no payment, nothing due" as a broken parse rejected every
 * write-off in the pack, and the guess about why was wrong as well.
 */
export type InvoiceState = "paid" | "open" | "written off";

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
  /** Derived from the totals block. See `InvoiceState`. */
  state: InvoiceState;
  /** Whether the client name was settled against the client list or guessed. */
  clientSource: "first line" | "client list";
  /**
   * The Notes block, which is where the explanations live.
   *
   * A note saying an invoice was combined with another one is the only account
   * of why that document looks wrong, and a note recording an agreed discount
   * is the only account of why another is short. Dropping the block would
   * throw that away, and it is recoverable from nowhere else.
   */
  notes: string;
}

/**
 * The item-type column, counted across the whole pack rather than guessed from
 * a few documents.
 *
 * "Direct Costs" was missed on the first pass because the list was written from
 * reading a handful of invoices. It is the type that carries discounts and
 * credits, so the invoices using it read high by the value of the credit, and
 * one of them read at half its true value. Guessing a vocabulary from a sample
 * is how that happens; counting it is cheap.
 */
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

/**
 * `Label   $1,234.56` anywhere on the line, right-aligned in the totals block.
 *
 * The label may carry its own rate in brackets, since a discount prints as
 * "Discount (0.9415%)" and a tax as "Tax (8.5%)". Requiring the money to follow
 * the word itself read those as absent, and an absent discount does not
 * announce itself: the invoice simply failed its own identity check by exactly
 * the amount that had gone missing.
 */
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
  /*
    A form feed separates pages, and JavaScript does not count it as a line
    break the way some other languages do. Splitting on \n alone leaves \f
    glued to the first row of every continuation page, so that row fails to
    match at column 0 and is read as a description continuation instead.

    One line item disappears per page break, silently, and the invoice still
    looks like an invoice. The only reason it surfaced is that the totals are
    checked against the lines, which is the argument for checking them.
  */
  const raw = text.split(/\r?\n|\f/);
  const lines = raw.filter((l) => l.trim().length > 0);

  const headerIndex = lines.findIndex((l) => /\bItem Type\b/.test(l) && /\bAmount\b/.test(l));
  const header = headerIndex === -1 ? lines : lines.slice(0, headerIndex);
  const body = headerIndex === -1 ? [] : lines.slice(headerIndex + 1);

  /*
    The "Invoice For" block, which is the hardest thing on the page to read.

    It is a left column of one to four lines. The first is the start of the
    client name. What follows may be the rest of a wrapped client name, or a
    contact person, or a street address, and the layout does not distinguish
    them: a two-line client name and a client with a named contact underneath
    are the same shape.

    Appending everything gets the wrapped names right and corrupts the rest.
    Taking only the first line does the reverse. Since nothing in the text
    separates the cases, the parser stops guessing and asks a list: every
    prefix is offered to the known client names and the longest one that
    matches wins. With no list, or no match in it, the first line is used and
    the invoice is marked so the run can report how many resolved that way.
  */
  const rightColumn = /\s{2,}(Invoice ID|Issue Date|Due Date|PO Number)\b.*$/i;
  const forIndex = header.findIndex((l) => /\bInvoice For\b/.test(l));
  const parts = [headerField(header, "Invoice For").replace(rightColumn, "").trim()];
  if (forIndex !== -1) {
    for (const line of header.slice(forIndex + 1)) {
      const left = line.split(/\s{4,}/).filter((p) => p.trim())[0]?.trim() ?? "";
      if (!left) continue;
      if (/^(Invoice ID|Issue Date|Due Date|Subject|PO Number|From)\b/i.test(left)) continue;
      if (/^\d{2}\/\d{2}\/\d{4}/.test(left)) continue;
      parts.push(left);
    }
  }

  const tidy = (v: string) => v.replace(/\s+/g, " ").trim();
  let client = tidy(parts[0] ?? "");
  let clientSource: "first line" | "client list" = "first line";
  for (let take = parts.length; take >= 1; take--) {
    const candidate = tidy(parts.slice(0, take).join(" "));
    if (knownClients.has(candidate.toLowerCase())) {
      client = knownClients.get(candidate.toLowerCase())!;
      clientSource = "client list";
      break;
    }
  }

  const dueRaw = headerField(header, "Due Date");
  const terms = dueRaw.match(/\(([^)]*)\)/)?.[1]?.replace(/\s+/g, " ").trim() ?? "";

  /*
    The line items stop where the totals begin, and everything past that point
    is somebody's explanation rather than work.

    Running the item loop to the end of the document meant the Notes block fell
    into the continuation branch and was appended to the last line item, so a
    quarter of the pack carried a description with somebody's bookkeeping note
    stuck on the end. Every one of them still added up, because notes have no
    money in them and the totals check could not see it.
  */
  const TOTALS_START = /\b(Subtotal|Amount Due)\b\s*(?:\([^)]*\))?\s{2,}-?\$/i;
  const totalsAt = body.findIndex((l) => TOTALS_START.test(l));
  const itemLines = totalsAt === -1 ? body : body.slice(0, totalsAt);

  // The Notes block, from its own heading to the end, less the page footer.
  const notesAt = body.findIndex((l, i) => i >= (totalsAt === -1 ? 0 : totalsAt) && /^\s*Notes\s*$/.test(l));
  const notes =
    notesAt === -1
      ? ""
      : body
          .slice(notesAt + 1)
          .filter((l) => !/^\s*Page \d+ of \d+\s*$/.test(l))
          .map((l) => l.trim())
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();

  const items: Line[] = [];
  const unknownTypes: string[] = [];
  for (const line of itemLines) {
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

  const payments = totalFor(lines, "Payments");
  const amountDue = totalFor(lines, "Amount Due");
  const lineSum = items.reduce((a, l) => a + (l.amountCents ?? 0), 0);

  /*
    Anything still owed is open, whatever has been paid against it so far.
    Nothing owed against a non-zero invoice with no payment printed is a
    write-off: something cleared the balance and it was not money. Everything
    else is settled, including an overpayment, which shows as a credit.
  */
  const state: InvoiceState =
    amountDue == null || amountDue > 0
      ? "open"
      : amountDue === 0 && lineSum !== 0 && !payments
        ? "written off"
        : "paid";

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
    paymentsCents: payments,
    amountDueCents: amountDue,
    state,
    lines: items.map((l) => ({ ...l, description: l.description.trim() })),
    // Counted from the page breaks themselves. Not every invoice carries a
    // "Page n of m" footer, and the ones that do not were all reading as 1.
    pages: text.split("\f").filter((p) => p.trim().length > 0).length || 1,
    unknownTypes: [...new Set(unknownTypes)],
    clientSource,
    notes,
  };
}

/* ---------------------------------------------------------------- checking */

/**
 * The subtotal to check the lines against, and where it came from.
 *
 * Harvest prints the Subtotal row only when a payment exists, so a large
 * minority of invoices do not carry one. Treating that as "no subtotal" and
 * skipping the check meant those were published unverified while the run
 * reported nothing wrong, which is worse than a failure: no answer, and no
 * question either.
 *
 * Where nothing has been paid and nothing adjusted, the amount due is the same
 * number the subtotal would have been, so the lines can still be checked. The
 * exception is a write-off, where the amount due has been cleared by something
 * the document does not print. Those have no printed total of any kind and are
 * reported as such rather than being quietly counted as checked.
 */
function checkableSubtotal(
  inv: Invoice
): { cents: number | null; source: "document" | "amount due" | "line items" } {
  if (inv.subtotalCents != null) return { cents: inv.subtotalCents, source: "document" };

  /*
    A write-off's own total is unrecoverable from the paper: the amount due is
    zero and no subtotal was printed. The line items are the only figure there
    is, so they are used, and `source` says so. That makes the lines-versus-
    subtotal check circular for these, which is why the run counts them
    separately instead of adding them to the verified total.
  */
  if (inv.state === "written off") {
    return { cents: inv.lines.reduce((a, l) => a + (l.amountCents ?? 0), 0), source: "line items" };
  }

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
      /* The source belongs in the message. "Subtotal says nothing" would send
         somebody looking for a subtotal the document never printed. */
      out.push(
        source === "document"
          ? `lines total ${dollars(lineSum)} but subtotal says ${dollars(subtotal)}`
          : `lines total ${dollars(lineSum)} but the invoice prints no subtotal and an amount due of ${dollars(subtotal)}`
      );
    }
  }

  /*
    Subtotal plus tax plus discount plus payments equals the amount due, where
    payments and discounts arrive negative, so the identity is a sum rather
    than a subtraction.

    A write-off is exempt, and has to be. What cleared its balance was a
    decision, not a payment, and Harvest prints no record of it on the invoice.
    Holding it to the identity would fail every write-off in the pack for the
    crime of having been written off.
  */
  if (inv.amountDueCents != null && subtotal != null && inv.state !== "written off") {
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
  const known = loadClients(CLIENTS);
  console.log(
    known
      ? `${known} client names from ${CLIENTS}`
      : `no client list at ${CLIENTS}, client names will be read from the first line only`
  );

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
      "file", "invoice_number", "client", "client_source", "state", "subject", "issue_date",
      "due_date", "terms", "po_number", "line_count", "pages", "subtotal", "subtotal_source",
      "tax", "discount", "payments", "amount_due", "notes",
    ]),
    /*
      `subtotal` is always populated and is always the figure the lines were
      checked against, so summing the column totals the pack. `subtotal_source`
      says where it came from: the printed row, the amount due on an invoice
      with nothing paid and nothing adjusted, or the line items on a write-off
      that printed no total at all. A blank column would have been more
      faithful to the paper and less useful to everything downstream.

      Note for anyone reconciling this against the source system: this column
      is the figure BEFORE any discount. Harvest's own invoiced total is after
      it, so the two differ by the discounts and that is not an error.
    */
    ...good.map((i) => {
      const { cents, source } = checkableSubtotal(i);
      return row([
        i.file, i.number, i.client, i.clientSource, i.state, i.subject, i.issueDate, i.dueDate,
        i.terms, i.poNumber, i.lines.length, i.pages,
        dollars(cents), source, dollars(i.taxCents), dollars(i.discountCents),
        dollars(i.paymentsCents), dollars(i.amountDueCents), i.notes,
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

  /*
    The client name is the one field that has to match something outside this
    file for the data to be loadable, so its resolution is reported rather than
    assumed. A name that fell back to the first line is a name that may carry a
    contact or a street address with it.
  */
  const guessed = good.filter((i) => i.clientSource === "first line");
  console.log();
  console.log(`client names settled against the list : ${good.length - guessed.length}`);
  console.log(`client names taken from the first line: ${guessed.length}`);
  if (guessed.length) {
    const names = [...new Set(guessed.map((i) => i.client))].sort();
    for (const n of names.slice(0, 15)) {
      console.log(`   ${n}`);
    }
    if (names.length > 15) console.log(`   ... and ${names.length - 15} more`);
  }

  /*
    States, and how much of the total is actually verified.

    A write-off's line items cannot be checked against anything, because the
    document prints no total for them. Counting those inside "checked" would
    overstate what this run proves, so they are named separately. The figure to
    quote when somebody asks how much of this was verified is the first one.
  */
  const byState = { paid: 0, open: 0, "written off": 0 } as Record<InvoiceState, number>;
  for (const i of good) byState[i.state]++;
  const unverifiable = good.filter((i) => checkableSubtotal(i).source === "line items");
  const unverifiableCents = unverifiable.reduce(
    (a, i) => a + i.lines.reduce((b, l) => b + (l.amountCents ?? 0), 0),
    0
  );

  console.log("");
  console.log(`paid ${byState.paid}   open ${byState.open}   written off ${byState["written off"]}`);
  console.log(
    `checked against a printed total: ${good.length - unverifiable.length} invoices, ` +
      `${dollars(invoiced - unverifiableCents)}`
  );
  if (unverifiable.length) {
    console.log(
      `not checkable, no total printed : ${unverifiable.length} written off, ` +
        `${dollars(unverifiableCents)}`
    );
  }

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
