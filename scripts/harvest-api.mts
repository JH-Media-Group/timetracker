/**
 * Pull the invoice record straight from the Harvest API, and check the PDF
 * conversion against it.
 *
 *   HARVEST_ACCOUNT_ID=... HARVEST_ACCESS_TOKEN=... pnpm harvest:api
 *   ... pnpm harvest:api --payments      also fetch the payment ledger
 *
 * WHY THIS EXISTS
 *
 * `harvest-invoices.mts` reads rendered PDFs, because that was the only export
 * available when the migration started. It works, and it reconciles to the cent
 * against the totals the source system reports. But a PDF is a picture of the
 * data, and three things it can never carry are the ones the destination schema
 * needs most:
 *
 *   payment dates. The invoice prints a payments total and never a date, and
 *   the payments table on the other side will not take a row without one.
 *
 *   the project behind a line. The document embeds a project name inside a
 *   description string, which is a guess; the API says it outright.
 *
 *   the states. Written off, sent and late are not printed. The PDF parser
 *   infers them from the shape of the totals block, which works, but inference
 *   is not evidence.
 *
 * So this reads the same account through its own API and writes the same shape
 * of CSV, then compares the two files invoice by invoice. Two independent
 * routes to the same numbers is worth considerably more than either alone: the
 * PDF path proves the API export is complete, and the API path proves the PDF
 * parse is right.
 *
 * READ ONLY, AND STRUCTURALLY SO
 *
 * Every request goes through `get`, which is the only function here that
 * touches the network and hard-codes the method. There is no post, patch or
 * delete anywhere in the file, and `tests/harvest-api.test.ts` asserts that at
 * the source level, because this points at the live billing system of a working
 * business and a typo with a different verb would edit it.
 *
 * CREDENTIALS
 *
 * Read from the environment, never from a file in the repository and never from
 * an argument, because arguments end up in shell history. Nothing is printed:
 * the token is not logged, not written to the output, and not included in an
 * error message.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/* --------------------------------------------------------------- arguments */

const args = process.argv.slice(2);
const has = (name: string) => args.includes(name);
const flag = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : (args[i + 1] ?? fallback);
};

const OUT = flag("--out", "C:/Users/jason/Downloads/harvest_invoices_csv");
const COMPARE = flag("--compare", join(OUT, "invoices.csv"));
const WANT_PAYMENTS = has("--payments");
const LIMIT = Number(flag("--limit", "0")) || 0;

const ACCOUNT_ID = process.env.HARVEST_ACCOUNT_ID ?? "";
const TOKEN = process.env.HARVEST_ACCESS_TOKEN ?? "";

/* ------------------------------------------------------------------- money */

/** Harvest sends money as a JSON number of dollars. Integer cents from here on. */
function cents(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  // Round rather than truncate: 0.1 + 0.2 arithmetic upstream can leave a
  // dollar figure a hair under the cent it means.
  return Math.round(n * 100);
}

const dollars = (c: number | null) => (c == null ? "" : (c / 100).toFixed(2));

/* --------------------------------------------------------------------- csv */

const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
const row = (values: unknown[]) => values.map(cell).join(",");

/* ---------------------------------------------------------------- fetching */

/**
 * The only function in this file that speaks to the network, and it only ever
 * reads.
 *
 * Harvest allows 100 requests per 15 seconds and answers 429 with a Retry-After
 * when you exceed it. Honouring that header is the difference between a slow
 * run and a run that gets the token rate limited for everybody using it.
 */
async function get<T>(path: string): Promise<T> {
  const url = path.startsWith("http") ? path : `https://api.harvestapp.com/v2${path}`;

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Harvest-Account-Id": ACCOUNT_ID,
        // Harvest requires this and refuses anonymous-looking clients.
        "User-Agent": "Tally migration (internal reconciliation)",
        Accept: "application/json",
      },
    });

    if (res.status === 429 || res.status >= 500) {
      if (attempt >= 5) throw new Error(`${res.status} from Harvest after ${attempt} retries`);
      const retryAfter = Number(res.headers.get("retry-after") ?? "0");
      const waitMs = retryAfter > 0 ? retryAfter * 1000 : Math.min(30_000, 2 ** attempt * 1000);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    if (!res.ok) {
      /* Deliberately does not include the request headers or the body, either
         of which would put the token in a log or a terminal scrollback. */
      throw new Error(`${res.status} ${res.statusText} for ${url.replace(/\?.*$/, "")}`);
    }

    return (await res.json()) as T;
  }
}

/** Walk a paginated collection to the end. Harvest gives a `next_page` link. */
async function getAll<T>(path: string, key: string, label: string): Promise<T[]> {
  const out: T[] = [];
  let next: string | null = `${path}${path.includes("?") ? "&" : "?"}per_page=100`;
  let page = 0;

  while (next) {
    // Annotated rather than inferred: `next` is assigned back out of this, and
    // without the annotation the inference is circular.
    const body: Record<string, unknown> = await get<Record<string, unknown>>(next);
    const items = (body[key] ?? []) as T[];
    out.push(...items);
    page++;
    if (page % 5 === 0) console.log(`  ...${out.length} ${label}`);
    next = (body["links"] as { next?: string | null } | undefined)?.next ?? null;
    if (LIMIT && out.length >= LIMIT) break;
  }

  return LIMIT ? out.slice(0, LIMIT) : out;
}

/* ------------------------------------------------------------------- shape */

interface ApiLineItem {
  id: number;
  kind: string;
  description: string | null;
  quantity: number;
  unit_price: number;
  amount: number;
  project?: { id: number; name: string } | null;
}

interface ApiInvoice {
  id: number;
  number: string;
  client: { id: number; name: string };
  subject: string | null;
  notes: string | null;
  purchase_order: string | null;
  currency: string;
  issue_date: string;
  due_date: string;
  payment_term: string | null;
  state: string;
  amount: number;
  due_amount: number;
  tax: number | null;
  tax_amount: number;
  tax2: number | null;
  tax2_amount: number;
  discount: number | null;
  discount_amount: number;
  sent_at: string | null;
  paid_at: string | null;
  paid_date: string | null;
  closed_at: string | null;
  line_items: ApiLineItem[];
}

interface ApiPayment {
  id: number;
  amount: number;
  paid_at: string | null;
  paid_date: string | null;
  notes: string | null;
  transaction_id: string | null;
}

/* -------------------------------------------------------------------- main */

async function main() {
  if (!ACCOUNT_ID || !TOKEN) {
    console.error(
      [
        "HARVEST_ACCOUNT_ID and HARVEST_ACCESS_TOKEN must both be set.",
        "",
        "Create a personal access token at https://id.getharvest.com/developers.",
        "Pass them in the environment for one command rather than storing them:",
        "",
        '  $env:HARVEST_ACCOUNT_ID="..."; $env:HARVEST_ACCESS_TOKEN="..."; pnpm harvest:api',
        "",
        "Do not put either value in a file inside this repository.",
      ].join("\n")
    );
    process.exitCode = 1;
    return;
  }

  mkdirSync(OUT, { recursive: true });

  console.log("reading invoices from the Harvest API");
  const invoices = await getAll<ApiInvoice>("/invoices", "invoices", "invoices");
  console.log(`read ${invoices.length} invoices`);

  /* ---- payments, only when asked ---------------------------------------- */

  const payments = new Map<number, ApiPayment[]>();
  if (WANT_PAYMENTS) {
    console.log("reading the payment ledger, one call per invoice");
    let n = 0;
    for (const inv of invoices) {
      const body = await get<{ invoice_payments: ApiPayment[] }>(`/invoices/${inv.id}/payments`);
      payments.set(inv.id, body.invoice_payments ?? []);
      if (++n % 250 === 0) console.log(`  ...${n}/${invoices.length}`);
    }
    const total = [...payments.values()].reduce((a, p) => a + p.length, 0);
    console.log(`read ${total} payment records`);
  }

  /* ---- write ------------------------------------------------------------ */

  const invoicesCsv = [
    row([
      "invoice_number", "client", "state", "subject", "issue_date", "due_date", "payment_term",
      "po_number", "currency", "line_count", "amount", "due_amount", "tax_amount",
      "tax2_amount", "discount_amount", "sent_at", "paid_date", "closed_at", "notes",
    ]),
    ...invoices.map((i) =>
      row([
        i.number, i.client.name, i.state, i.subject ?? "", i.issue_date, i.due_date,
        i.payment_term ?? "", i.purchase_order ?? "", i.currency, i.line_items.length,
        dollars(cents(i.amount)), dollars(cents(i.due_amount)), dollars(cents(i.tax_amount)),
        dollars(cents(i.tax2_amount)), dollars(cents(i.discount_amount)),
        i.sent_at ?? "", i.paid_date ?? "", i.closed_at ?? "", (i.notes ?? "").replace(/\s+/g, " ").trim(),
      ])
    ),
  ].join("\n");

  /* The project on a line is the field the PDF cannot supply at all, and the
     reason this route is worth taking even though the other one reconciles. */
  const linesCsv = [
    row([
      "invoice_number", "line_no", "kind", "description", "quantity", "unit_price", "amount",
      "project_id", "project_name",
    ]),
    ...invoices.flatMap((i) =>
      i.line_items.map((l, n) =>
        row([
          i.number, n + 1, l.kind, (l.description ?? "").replace(/\s+/g, " ").trim(),
          l.quantity, dollars(cents(l.unit_price)), dollars(cents(l.amount)),
          l.project?.id ?? "", l.project?.name ?? "",
        ])
      )
    ),
  ].join("\n");

  writeFileSync(join(OUT, "api_invoices.csv"), invoicesCsv + "\n", "utf8");
  writeFileSync(join(OUT, "api_invoice_lines.csv"), linesCsv + "\n", "utf8");

  if (WANT_PAYMENTS) {
    const paymentsCsv = [
      row(["invoice_number", "payment_no", "amount", "paid_date", "paid_at", "transaction_id", "notes"]),
      ...invoices.flatMap((i) =>
        (payments.get(i.id) ?? []).map((p, n) =>
          row([
            i.number, n + 1, dollars(cents(p.amount)), p.paid_date ?? "", p.paid_at ?? "",
            p.transaction_id ?? "", (p.notes ?? "").replace(/\s+/g, " ").trim(),
          ])
        )
      ),
    ].join("\n");
    writeFileSync(join(OUT, "api_invoice_payments.csv"), paymentsCsv + "\n", "utf8");
  }

  /* ---- totals ----------------------------------------------------------- */

  const invoiced = invoices.reduce((a, i) => a + (cents(i.amount) ?? 0), 0);
  const due = invoices.reduce((a, i) => a + (cents(i.due_amount) ?? 0), 0);
  const byState = new Map<string, number>();
  for (const i of invoices) byState.set(i.state, (byState.get(i.state) ?? 0) + 1);
  const withProject = invoices.reduce(
    (a, i) => a + i.line_items.filter((l) => l.project?.id).length,
    0
  );
  const allLines = invoices.reduce((a, i) => a + i.line_items.length, 0);

  console.log("");
  console.log(`invoices        ${invoices.length}`);
  console.log(`line items      ${allLines}, of which ${withProject} name a project`);
  console.log(`invoiced        ${dollars(invoiced)}`);
  console.log(`still due       ${dollars(due)}`);
  console.log(`states          ${[...byState].map(([s, n]) => `${s} ${n}`).join("   ")}`);
  console.log("");
  console.log(`out: ${OUT}`);

  /* ---- and the reason for doing it twice -------------------------------- */

  compare(invoices);
}

/**
 * The PDF conversion against the API, invoice by invoice.
 *
 * Two independent readings of the same account. Where they agree, the number is
 * about as well established as it can get without a third. Where they disagree,
 * one of them is wrong and this says which invoice to look at.
 *
 * The amounts are compared after discount on both sides, because the PDF file's
 * subtotal column is before it and Harvest's `amount` is after.
 */
function compare(invoices: ApiInvoice[]): void {
  let pdf: string[];
  try {
    pdf = readFileSync(COMPARE, "utf8").split(/\r?\n/).filter((l) => l.trim());
  } catch {
    console.log("");
    console.log(`no PDF-derived file at ${COMPARE}, skipping the comparison`);
    return;
  }

  const header = pdf[0]!.split('","').map((h) => h.replace(/^"|"$/g, ""));
  const at = (name: string) => header.indexOf(name);
  const iNum = at("invoice_number");
  const iSub = at("subtotal");
  const iDisc = at("discount");
  const iDue = at("amount_due");
  const iState = at("state");
  if (iNum === -1 || iSub === -1) {
    console.log("");
    console.log("the PDF-derived file does not have the columns this expects, skipping");
    return;
  }

  const fromPdf = new Map<string, { amount: number; due: number; state: string }>();
  for (const line of pdf.slice(1)) {
    const f = line.split('","').map((v) => v.replace(/^"|"$/g, ""));
    const sub = Math.round(Number(f[iSub] || 0) * 100);
    const disc = iDisc === -1 ? 0 : Math.round(Number(f[iDisc] || 0) * 100);
    fromPdf.set(f[iNum]!, {
      amount: sub + disc,
      due: iDue === -1 ? 0 : Math.round(Number(f[iDue] || 0) * 100),
      state: iState === -1 ? "" : (f[iState] ?? ""),
    });
  }

  const onlyApi: string[] = [];
  const amountDiffs: string[] = [];
  const dueDiffs: string[] = [];
  const stateDiffs: string[] = [];
  // The two vocabularies are not identical: the API distinguishes sent from
  // late, and the document cannot, so both map to open before comparing.
  const asOurs = (s: string) => (s === "draft" || s === "sent" || s === "open" ? "open" : s === "closed" ? "written off" : s);

  for (const inv of invoices) {
    const mine = fromPdf.get(inv.number);
    if (!mine) { onlyApi.push(inv.number); continue; }
    if (mine.amount !== (cents(inv.amount) ?? 0)) amountDiffs.push(inv.number);
    if (mine.due !== (cents(inv.due_amount) ?? 0)) dueDiffs.push(inv.number);
    if (mine.state && asOurs(inv.state) !== mine.state) stateDiffs.push(inv.number);
  }
  const apiNumbers = new Set(invoices.map((i) => i.number));
  const onlyPdf = [...fromPdf.keys()].filter((n) => !apiNumbers.has(n));

  const show = (label: string, list: string[]) => {
    console.log(`  ${list.length === 0 ? "OK " : "!! "}${label}: ${list.length}`);
    if (list.length) console.log(`       ${list.slice(0, 10).join(", ")}${list.length > 10 ? ", ..." : ""}`);
  };

  console.log("");
  console.log("--- the PDF conversion against the API ---");
  console.log(`  invoices in both: ${invoices.length - onlyApi.length}`);
  show("in the API but not in the PDF output", onlyApi);
  show("in the PDF output but not in the API", onlyPdf);
  show("amount differs (both after discount)", amountDiffs);
  show("amount due differs", dueDiffs);
  show("state differs", stateDiffs);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}

export { cents, compare };
