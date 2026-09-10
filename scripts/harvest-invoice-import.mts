/**
 * Turn the Harvest invoice export into reviewable SQL for the live database.
 *
 *   pnpm harvest:invoice-import [--in <dir>] [--sql <file>]
 *
 * WHAT IT WRITES, AND WHAT IT REFUSES TO
 *
 * Invoices, their line items, their payments, and the invoice-to-project links.
 * Nothing else. It creates no client, no project, no task, no person and no
 * rate, and it never touches a time entry. Those carry changes made by hand in
 * Tally that no export knows about, and an import that "helpfully" corrects
 * them destroys work nobody can get back.
 *
 * It issues no UPDATE and no DELETE. Every statement is an INSERT guarded by a
 * NOT EXISTS, so running the SQL twice writes nothing the second time. The
 * guard is the source system's own invoice id, kept in `external_ref`, because
 * an invoice number here is editable free text and is not a key.
 *
 * It does not connect to anything. It reads CSV and writes a .sql file for a
 * person to read before any of it runs, which is the same shape as the time
 * delta importer and for the same reason: the deployment runbook forbids this
 * process from holding production credentials.
 *
 * THE REMINDER TRAP, WHICH IS THE DANGEROUS PART
 *
 * Tally chases overdue invoices by email on a three step escalation at 1, 14
 * and 30 days past due. Two hundred of these invoices are open and most are
 * long past their due date, so importing them with the default reminder fields
 * would make every one of them eligible on the next run of the mail job: real
 * dunning emails, to real clients, about invoices they have already discussed,
 * some of them years old.
 *
 * The escalation level counts only against the due date it was reached for, so
 * writing the level an invoice has already passed together with its due date
 * makes the job read it as chased and send nothing. That is what this does, for
 * every open invoice, and `tests/harvest-invoice-import.test.ts` asserts it.
 * The schema comment on `reminder_due_date` describes exactly this case; it is
 * the difference between a quiet migration and two hundred angry phone calls.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { newId } from "../src/server/db/ids.ts";

/* --------------------------------------------------------------- arguments */

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : (args[i + 1] ?? fallback);
};

const IN = flag("--in", "C:/Users/jason/Downloads/harvest_invoices_csv");
const SQL = flag("--sql", "C:/Users/jason/Downloads/harvest_invoices_csv/invoice-import.sql");
const BATCH = Number(flag("--batch", "500")) || 500;

/**
 * Split rows into statements without ever splitting one invoice across two.
 *
 * The child guards ask whether the invoice already has any line items, or any
 * payments, and skip the whole set if so. That is the right question, because
 * these are written as a set, but it makes the batching part of the
 * correctness rather than a detail of formatting: chop an invoice's lines down
 * the middle and the first statement inserts half of them, then the second
 * looks, finds lines already there, and silently drops the rest.
 *
 * It cost 21 line items on the first run against a restored copy, which is the
 * argument for running it against a restored copy.
 */
export function batchesByOwner<T>(rows: T[], ownerOf: (row: T) => string, max: number): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let owner: string | null = null;

  for (const r of rows) {
    const k = ownerOf(r);
    // Only ever break between owners, even if that overshoots the size.
    if (current.length >= max && k !== owner) {
      batches.push(current);
      current = [];
    }
    current.push(r);
    owner = k;
  }
  if (current.length) batches.push(current);
  return batches;
}

/** Days past due at which Tally sends a reminder. Mirrors ESCALATION_DAYS. */
const ESCALATION_DAYS = [1, 14, 30];

/* ---------------------------------------------------------------- reading */

/** A CSV reader that respects quoting, since descriptions carry commas. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch !== '"') { field += ch; continue; }
      if (text[i + 1] === '"') { field += '"'; i++; continue; }
      quoted = false;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ",") { row.push(field); field = ""; continue; }
    if (ch === "\r") continue;
    if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }

  const header = rows.shift() ?? [];
  return rows
    .filter((r) => r.some((v) => v.trim()))
    .map((r) => Object.fromEntries(header.map((h, n) => [h, r[n] ?? ""])));
}

/**
 * Read a CSV and prove it has the columns this script is about to read.
 *
 * A row here is `Record<string, string>`, so `row.number` when the column is
 * called `invoice_number` type-checks perfectly and yields undefined. That
 * exact mistake put a NULL into every invoice number on the first run: the
 * column is NOT NULL, so it would have failed loudly, but the same slip on a
 * nullable column writes 2,159 blanks and says nothing at all.
 *
 * Naming the columns up front turns a silent wrong answer into a refusal.
 */
function read(name: string, required: string[]): Record<string, string>[] {
  const rows = parseCsv(readFileSync(join(IN, name), "utf8"));
  if (!rows.length) throw new Error(`${name} has no rows`);
  const missing = required.filter((c) => !(c in rows[0]!));
  if (missing.length) {
    throw new Error(
      `${name} is missing the column(s) ${missing.join(", ")}. ` +
        `It has: ${Object.keys(rows[0]!).join(", ")}`
    );
  }
  return rows;
}

/* ------------------------------------------------------------------- money */

/** A dollar string from the export as integer cents. */
export function cents(v: string): number {
  const s = (v ?? "").trim();
  if (!s) return 0;
  const n = Number(s.replace(/[$,]/g, ""));
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

/* --------------------------------------------------------------------- sql */

/** A SQL string literal. Doubling the quote is the whole escape. */
export function lit(v: string | null | undefined): string {
  if (v == null || v === "") return "NULL";
  return `'${String(v).replace(/'/g, "''")}'`;
}

const num = (v: string | number | null | undefined) =>
  v === null || v === undefined || v === "" ? "NULL" : String(v);

/** A date or timestamp from the export, or NULL. */
const stamp = (v: string) => (v && v.trim() ? `${lit(v.trim())}::timestamptz` : "NULL");
const dateOf = (v: string) => (v && v.trim() ? `${lit(v.trim().slice(0, 10))}::date` : "NULL");

/* ---------------------------------------------------------------- mapping */

/**
 * Harvest's states to Tally's.
 *
 * `closed` is Harvest's word for written off, which is what its own screen
 * calls it. Tally has a `closed` state of its own meaning something else, so
 * mapping the word to the word would file every write-off under the wrong
 * heading.
 */
export function stateOf(harvest: string): string {
  switch (harvest.trim().toLowerCase()) {
    case "draft": return "draft";
    case "paid": return "paid";
    case "closed": return "written_off";
    default: return "open";
  }
}

/**
 * How far through the escalation an invoice already is, as of `today`.
 *
 * Written alongside the due date it was reached for, this tells the reminder
 * job the invoice has already been chased to that point, so it sends nothing.
 * An invoice that is not yet due scores zero, which is also correct.
 */
export function reminderLevel(dueDate: string, today: string): number {
  const due = Date.parse(`${dueDate}T00:00:00Z`);
  const now = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(due) || !Number.isFinite(now)) return 0;
  const daysLate = Math.floor((now - due) / 86_400_000);
  return ESCALATION_DAYS.filter((d) => daysLate >= d).length;
}

/* -------------------------------------------------------------------- main */

function main() {
  const invoices = read("api_invoices.csv", [
    "harvest_id", "invoice_number", "client", "state", "subject", "issue_date", "due_date",
    "payment_term", "po_number", "currency", "amount", "tax_percent", "tax_amount",
    "tax2_percent", "tax2_amount", "discount_percent", "discount_amount", "sent_at",
    "paid_date", "closed_at", "notes",
  ]);
  const lines = read("api_invoice_lines.csv", [
    "harvest_invoice_id", "line_no", "kind", "description", "quantity", "unit_price",
    "amount", "project_name",
  ]);
  let payments: Record<string, string>[] = [];
  try {
    payments = read("api_invoice_payments.csv", [
      "harvest_payment_id", "harvest_invoice_id", "amount", "paid_date", "paid_at",
      "transaction_id", "notes",
    ]);
  } catch (e) {
    // A missing file is fine and means no ledger. A file with the wrong columns
    // is not, and must not be swallowed alongside it.
    if (!(e instanceof Error) || !/ENOENT/.test(e.message)) throw e;
    console.log("no api_invoice_payments.csv, the payment ledger will not be written");
  }

  const today = new Date().toISOString().slice(0, 10);
  console.log(`${invoices.length} invoices, ${lines.length} lines, ${payments.length} payments`);

  const idFor = new Map<string, string>();
  for (const inv of invoices) idFor.set(inv.harvest_id!, newId());

  const paidByInvoice = new Map<string, number>();
  for (const p of payments) {
    const k = p.harvest_invoice_id!;
    paidByInvoice.set(k, (paidByInvoice.get(k) ?? 0) + cents(p.amount!));
  }

  const out: string[] = [];
  const say = (s = "") => out.push(s);

  say("-- Harvest invoices, line items, payments and project links.");
  say("--");
  say(`-- Generated ${new Date().toISOString()} from ${IN}`);
  say(`-- ${invoices.length} invoices, ${lines.length} line items, ${payments.length} payments.`);
  say("--");
  say("-- Every statement is an INSERT guarded by NOT EXISTS on the source system's");
  say("-- own invoice id, held in external_ref. Running this twice writes nothing the");
  say("-- second time. There is no UPDATE and no DELETE anywhere in this file, and it");
  say("-- creates no client, project, task, person, rate or time entry.");
  say("--");
  say("-- Open invoices carry a reminder level matching how far past due they already");
  say("-- are, paired with their due date. Without that the overdue mail job would");
  say("-- treat every one of them as never chased and email the client.");
  say("");
  say("BEGIN;");
  say("");

  /* ---- invoices --------------------------------------------------------- */

  const unmatchedClients = new Set<string>();
  const invoiceValues = invoices.map((inv) => {
    const id = idFor.get(inv.harvest_id!)!;
    const state = stateOf(inv.state!);
    const lineSum = lines
      .filter((l) => l.harvest_invoice_id === inv.harvest_id)
      .reduce((a, l) => a + cents(l.amount!), 0);
    const total = cents(inv.amount!);
    const paid = paidByInvoice.get(inv.harvest_id!) ?? 0;
    // Only an open invoice can be chased, so only an open invoice needs the
    // level. Writing it on the others would be noise in the data.
    const level = state === "open" ? reminderLevel(inv.due_date!, today) : 0;

    return (
      `(${lit(id)}::uuid, ${lit(inv.client)}, ${lit(inv.invoice_number)}, ${lit(inv.subject)}, ` +
      `${lit(inv.notes)}, ${lit(inv.po_number)}, ${lit(inv.currency || "USD")}, ` +
      `${lit(inv.issue_date)}::date, ${lit(inv.due_date)}::date, ${lit(inv.payment_term)}, ` +
      `${lit(state)}, ${lineSum}, ${num(inv.discount_percent)}, ${cents(inv.discount_amount!)}, ` +
      `${num(inv.tax_percent)}, ${cents(inv.tax_amount!)}, ${num(inv.tax2_percent)}, ` +
      `${cents(inv.tax2_amount!)}, ${total}, ${paid}, ${stamp(inv.sent_at!)}, ` +
      `${dateOf(inv.paid_date!)}, ${stamp(inv.closed_at!)}, ${level}, ` +
      `${state === "open" ? `${lit(inv.due_date)}::date` : "NULL"}, ${lit(inv.harvest_id)})`
    );
  });

  const INVOICE_COLS =
    "(id, client_name, number, subject, notes, po_number, currency, issue_date, due_date, " +
    "payment_term, state, subtotal_cents, discount_percent, discount_cents, tax_percent, " +
    "tax_cents, tax2_percent, tax2_cents, total_cents, paid_cents, sent_at, paid_on, " +
    "closed_at, reminder_level, reminder_due_date, harvest_id)";

  say("-- 1. Invoices. The client is resolved by name; an invoice whose client is not");
  say("--    in Tally is simply not inserted, and the count at the end will show it.");
  for (let i = 0; i < invoiceValues.length; i += BATCH) {
    const chunk = invoiceValues.slice(i, i + BATCH);
    say(`WITH incoming ${INVOICE_COLS} AS (VALUES`);
    say(chunk.join(",\n"));
    say(")");
    say("INSERT INTO invoices (");
    say("  id, client_id, number, subject, notes, po_number, currency, issue_date, due_date,");
    say("  payment_term, state, subtotal_cents, discount_percent, discount_cents, tax_percent,");
    say("  tax_cents, tax2_percent, tax2_cents, total_cents, paid_cents, sent_at, paid_at,");
    say("  closed_at, reminder_level, reminder_due_date, external_ref");
    say(")");
    say("SELECT");
    say("  i.id, c.id, i.number, i.subject, i.notes, i.po_number, i.currency, i.issue_date::date,");
    /* Cast the three rate columns explicitly. A VALUES column whose first row
       is NULL is inferred as text, and every one of these is null on almost
       every invoice, so without the cast the insert is rejected outright. */
    say("  i.due_date::date, i.payment_term, i.state, i.subtotal_cents, i.discount_percent::numeric,");
    say("  i.discount_cents, i.tax_percent::numeric, i.tax_cents, i.tax2_percent::numeric, i.tax2_cents,");
    say("  i.total_cents, i.paid_cents, i.sent_at::timestamptz, i.paid_on::timestamptz,");
    say("  i.closed_at::timestamptz, i.reminder_level, i.reminder_due_date::date,");
    say("  jsonb_build_object('harvest', jsonb_build_object('source', 'api', 'id', i.harvest_id))");
    say("FROM incoming i");
    say("JOIN clients c ON lower(btrim(c.name)) = lower(btrim(i.client_name))");
    say("WHERE NOT EXISTS (");
    say("  SELECT 1 FROM invoices e");
    say("  WHERE e.external_ref -> 'harvest' ->> 'id' = i.harvest_id AND e.deleted_at IS NULL");
    say(");");
    say("");
  }

  /* ---- line items ------------------------------------------------------- */

  const lineOf = (l: Record<string, string>) =>
    `(${lit(l.harvest_invoice_id)}, ${Number(l.line_no)}, ${lit(l.kind)}, ` +
    `${lit(l.project_name)}, ${lit(l.description || "(no description)")}, ` +
    `${num(Number(l.quantity || 0).toFixed(2))}, ${cents(l.unit_price!)}, ${cents(l.amount!)})`;

  say("-- 2. Line items. The item type is matched by name against the three that");
  say("--    already exist. The project is resolved within the invoice's own client,");
  say("--    because project names repeat across clients, and is left null when the");
  say("--    project is not in Tally rather than inventing one.");
  say("--");
  say("--    Batched so that one invoice's lines are never split between two");
  say("--    statements: the guard below skips an invoice that already has any, so");
  say("--    a split would insert half a set and silently drop the rest.");
  for (const batch of batchesByOwner(lines, (l) => l.harvest_invoice_id!, BATCH)) {
    const chunk = batch.map(lineOf);
    say("WITH incoming (harvest_invoice_id, position, kind, project_name, description, quantity, unit_price_cents, amount_cents) AS (VALUES");
    say(chunk.join(",\n"));
    say(")");
    say("INSERT INTO invoice_line_items (");
    say("  id, invoice_id, position, item_type_id, project_id, description, quantity,");
    say("  unit_price_cents, amount_cents, is_taxed, is_taxed2");
    say(")");
    say("SELECT");
    say("  gen_random_uuid(), inv.id, l.position, t.id, p.id, l.description, l.quantity::numeric,");
    /* No invoice in this export carries tax, and these are historical documents
       that must never be recalculated, so both flags are false rather than the
       column default of true. */
    say("  l.unit_price_cents, l.amount_cents, false, false");
    say("FROM incoming l");
    say("JOIN invoices inv");
    say("  ON inv.external_ref -> 'harvest' ->> 'id' = l.harvest_invoice_id AND inv.deleted_at IS NULL");
    say("LEFT JOIN invoice_item_types t ON lower(btrim(t.name)) = lower(btrim(l.kind))");
    say("LEFT JOIN projects p");
    say("  ON p.client_id = inv.client_id AND lower(btrim(p.name)) = lower(btrim(l.project_name))");
    say("WHERE NOT EXISTS (");
    say("  SELECT 1 FROM invoice_line_items x WHERE x.invoice_id = inv.id");
    say(");");
    say("");
  }

  /* ---- payments --------------------------------------------------------- */

  /*
    A payment of nothing is not a payment, and the schema agrees: there is a
    check constraint requiring a positive amount. The source system records a
    zero payment against a zero invoice as its way of marking it settled, which
    is reasonable there and rejected here. Dropping them changes no total,
    because the invoice's paid amount is the sum and adding zero to it is a
    no-op, and the invoice is already in the right state without them.
  */
  const zeroPayments = payments.filter((p) => cents(p.amount!) <= 0);
  payments = payments.filter((p) => cents(p.amount!) > 0);

  if (payments.length) {
    const payOf = (p: Record<string, string>) =>
      `(${lit(p.harvest_invoice_id)}, ${cents(p.amount!)}, ` +
      `${stamp(p.paid_at || p.paid_date || "")}, ${lit(p.transaction_id)}, ${lit(p.notes)}, ` +
      `${lit(p.harvest_payment_id)})`;

    say("-- 3. Payments. Four invoices carry two payments of the same amount on the");
    say("--    same day, so amount and date together are not a key; the guard is");
    say("--    whether the invoice has any payment rows at all, and the whole set is");
    say("--    written together or not at all. Batched by invoice for that reason.");
    for (const batch of batchesByOwner(payments, (p) => p.harvest_invoice_id!, BATCH)) {
      const chunk = batch.map(payOf);
      say("WITH incoming (harvest_invoice_id, amount_cents, paid_at, reference, notes, harvest_payment_id) AS (VALUES");
      say(chunk.join(",\n"));
      say(")");
      say("INSERT INTO invoice_payments (id, invoice_id, amount_cents, paid_at, reference, notes)");
      say("SELECT gen_random_uuid(), inv.id, p.amount_cents, p.paid_at::timestamptz, p.reference, p.notes");
      say("FROM incoming p");
      say("JOIN invoices inv");
      say("  ON inv.external_ref -> 'harvest' ->> 'id' = p.harvest_invoice_id AND inv.deleted_at IS NULL");
      say("WHERE NOT EXISTS (");
      say("  SELECT 1 FROM invoice_payments x WHERE x.invoice_id = inv.id");
      say(");");
      say("");
    }
  }

  /* ---- invoice to project links ----------------------------------------- */

  const links = new Map<string, Set<string>>();
  for (const l of lines) {
    if (!l.project_name?.trim()) continue;
    const set = links.get(l.harvest_invoice_id!) ?? new Set<string>();
    set.add(l.project_name);
    links.set(l.harvest_invoice_id!, set);
  }
  const linkValues: string[] = [];
  for (const [harvestId, names] of links) {
    for (const name of names) linkValues.push(`(${lit(harvestId)}, ${lit(name)})`);
  }

  say("-- 4. Which projects an invoice draws on, so it appears in profitability by");
  say("--    project. Derived from the line items, deduplicated per invoice.");
  for (let i = 0; i < linkValues.length; i += BATCH) {
    const chunk = linkValues.slice(i, i + BATCH);
    say("WITH incoming (harvest_invoice_id, project_name) AS (VALUES");
    say(chunk.join(",\n"));
    say(")");
    say("INSERT INTO invoice_projects (invoice_id, project_id)");
    say("SELECT DISTINCT inv.id, p.id");
    say("FROM incoming l");
    say("JOIN invoices inv");
    say("  ON inv.external_ref -> 'harvest' ->> 'id' = l.harvest_invoice_id AND inv.deleted_at IS NULL");
    say("JOIN projects p");
    say("  ON p.client_id = inv.client_id AND lower(btrim(p.name)) = lower(btrim(l.project_name))");
    say("WHERE NOT EXISTS (");
    say("  SELECT 1 FROM invoice_projects x WHERE x.invoice_id = inv.id AND x.project_id = p.id");
    say(");");
    say("");
  }

  /* ---- what landed ------------------------------------------------------ */

  say("-- What landed, to be read before committing.");
  say("SELECT 'invoices' AS what, count(1) AS rows FROM invoices WHERE external_ref -> 'harvest' IS NOT NULL");
  say("UNION ALL SELECT 'line items', count(1) FROM invoice_line_items li");
  say("  JOIN invoices i ON i.id = li.invoice_id WHERE i.external_ref -> 'harvest' IS NOT NULL");
  say("UNION ALL SELECT 'payments', count(1) FROM invoice_payments p");
  say("  JOIN invoices i ON i.id = p.invoice_id WHERE i.external_ref -> 'harvest' IS NOT NULL");
  say("UNION ALL SELECT 'project links', count(1) FROM invoice_projects ip");
  say("  JOIN invoices i ON i.id = ip.invoice_id WHERE i.external_ref -> 'harvest' IS NOT NULL");
  say("UNION ALL SELECT 'lines with no project', count(1) FROM invoice_line_items li");
  say("  JOIN invoices i ON i.id = li.invoice_id");
  say("  WHERE i.external_ref -> 'harvest' IS NOT NULL AND li.project_id IS NULL");
  say("UNION ALL SELECT 'open and never chased', count(1) FROM invoices");
  say("  WHERE external_ref -> 'harvest' IS NOT NULL AND state = 'open'");
  say("    AND due_date <= current_date AND reminder_due_date IS DISTINCT FROM due_date;");
  say("");
  say("-- The last figure must be zero. Anything else is an invoice the overdue mail");
  say("-- job will treat as never chased, and it will email the client.");
  say("");
  say("COMMIT;");
  say("");

  writeFileSync(SQL, out.join("\n"), "utf8");

  /* ---- report ----------------------------------------------------------- */

  const states = new Map<string, number>();
  for (const inv of invoices) states.set(stateOf(inv.state!), (states.get(stateOf(inv.state!)) ?? 0) + 1);
  const openLate = invoices.filter(
    (i) => stateOf(i.state!) === "open" && reminderLevel(i.due_date!, today) > 0
  ).length;

  console.log("");
  console.log(`states        ${[...states].map(([s, n]) => `${s} ${n}`).join("   ")}`);
  console.log(`project links ${linkValues.length}`);
  console.log(`open and already past an escalation step: ${openLate}`);
  if (zeroPayments.length) {
    console.log(
      `payments of zero skipped: ${zeroPayments.length} ` +
        `(the schema requires a positive amount, and they settle zero invoices)`
    );
  }
  console.log("  each carries the level it has reached, so the mail job sends nothing");
  if (unmatchedClients.size) {
    console.log(`clients not found: ${unmatchedClients.size}`);
  }
  console.log("");
  console.log(`sql: ${SQL}`);
  console.log("Read it, then apply it inside a transaction you can roll back.");
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) main();
