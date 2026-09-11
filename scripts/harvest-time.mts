/**
 * Pull time entries straight from the Harvest API, in the shape the delta
 * importer reads.
 *
 *   pnpm harvest:time --from 2026-09-10 [--to 2026-09-11] [--dir <folder>]
 *
 * WHY THIS EXISTS
 *
 * `harvest-delta.mts` reads `harvest_time_report.csv`, a file somebody exports
 * by hand from the Harvest UI. That was the only route in when the migration
 * started, and it has two problems for a daily catch-up: the export is a manual
 * step, and it is a snapshot, so an export taken at ten in the morning does not
 * contain the rest of that day. Yesterday's time asked for today is exactly the
 * case it gets wrong.
 *
 * The API has no such boundary. This asks for a date range and writes the same
 * CSV the importer already knows how to read, so the importer is unchanged and
 * its collision handling, its refusal to invent entities, and its guarded SQL
 * all still apply.
 *
 * READ ONLY, AND STRUCTURALLY SO
 *
 * Every request goes through `get`, which is the only function here that
 * touches the network and hard-codes the method. There is no post, patch or
 * delete anywhere in the file, and `tests/harvest-api.test.ts` asserts that at
 * the source level. This points at the live time record of a working business,
 * and a typo with a different verb would edit it.
 *
 * CREDENTIALS come from the environment only, and nothing here prints them.
 */

import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/* --------------------------------------------------------------- arguments */

const args = process.argv.slice(2);
const flag = (name: string, fallback = "") => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : (args[i + 1] ?? fallback);
};

const FROM = flag("--from");
const TO = flag("--to", FROM);
const DIR = flag("--dir", ".tmp/harvest-time");

const isDay = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);
if (!isDay(FROM) || !isDay(TO)) {
  throw new Error("--from YYYY-MM-DD is required, and --to must be a date if given.");
}
if (TO < FROM) throw new Error("--to is before --from.");

const TOKEN = process.env.HARVEST_ACCESS_TOKEN ?? process.env.HARVEST_TOKEN ?? "";
const ACCOUNT_ID = process.env.HARVEST_ACCOUNT_ID ?? "";
if (!TOKEN || !ACCOUNT_ID) {
  throw new Error(
    "Set HARVEST_TOKEN (or HARVEST_ACCESS_TOKEN) and HARVEST_ACCOUNT_ID in the environment."
  );
}

/* ---------------------------------------------------------------- the read */

async function get<T>(path: string): Promise<T> {
  const url = path.startsWith("http") ? path : `https://api.harvestapp.com/v2${path}`;

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Harvest-Account-Id": ACCOUNT_ID,
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

    // Never includes the request headers or body, either of which would put the
    // token into a terminal scrollback.
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url.replace(/\?.*$/, "")}`);

    return (await res.json()) as T;
  }
}

interface HarvestTimeEntry {
  spent_date: string;
  hours: number;
  notes: string | null;
  billable: boolean;
  billable_rate: number | null;
  cost_rate: number | null;
  is_billed: boolean;
  user: { id: number; name: string } | null;
  client: { id: number; name: string } | null;
  project: { id: number; name: string } | null;
  task: { id: number; name: string } | null;
}

async function all(): Promise<HarvestTimeEntry[]> {
  const out: HarvestTimeEntry[] = [];
  let next: string | null = `/time_entries?from=${FROM}&to=${TO}&per_page=100`;

  while (next) {
    const body: Record<string, unknown> = await get<Record<string, unknown>>(next);
    out.push(...((body["time_entries"] ?? []) as HarvestTimeEntry[]));
    next = (body["links"] as { next?: string | null } | undefined)?.next ?? null;
  }
  return out;
}

/* ---------------------------------------------------------------- the write */

/** One CSV field, RFC 4180. Quoted whenever it could otherwise be misread. */
const field = (value: string | number | null | undefined): string => {
  const text = value == null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/*
  The columns `harvest-delta.mts` reads, in the order the Harvest UI export
  writes them. The importer looks each one up by header name, so the order is
  courtesy rather than contract, but a file that opens looking like the export
  it replaces is easier to check by eye.

  The name goes in one column. The importer joins first and last with a space
  and trims, and the database side builds its key the same way, so a full name
  in the first column and nothing in the second produces exactly the key it
  would have produced from a split name. Splitting on a space here would invent
  a rule about middle names that nothing else in the system has.
*/
const HEADERS = [
  "Date",
  "First Name",
  "Last Name",
  "Client",
  "Project",
  "Task",
  "Hours",
  "Notes",
  "Billable?",
  "Invoiced?",
  "Billable Rate",
  "Cost Rate",
] as const;

async function main() {
  console.log(`Reading Harvest time entries from ${FROM} to ${TO}`);
  const entries = await all();
  console.log(`  ${entries.length} entries`);

  const missing = entries.filter((e) => !e.user || !e.project || !e.client || !e.task);
  if (missing.length) {
    // Not fatal here: the importer refuses unresolved rows by name, and this
    // says so earlier and more plainly.
    console.log(`  ! ${missing.length} entries are missing a person, client, project or task`);
  }

  const lines = [HEADERS.join(",")];
  let hours = 0;

  for (const e of entries) {
    hours += e.hours ?? 0;
    lines.push(
      [
        field(e.spent_date),
        field(e.user?.name ?? ""),
        field(""),
        field(e.client?.name ?? ""),
        field(e.project?.name ?? ""),
        field(e.task?.name ?? ""),
        field(e.hours ?? 0),
        field(e.notes ?? ""),
        field(e.billable ? "Yes" : "No"),
        field(e.is_billed ? "Yes" : "No"),
        field(e.billable_rate ?? ""),
        field(e.cost_rate ?? ""),
      ].join(",")
    );
  }

  mkdirSync(DIR, { recursive: true });
  const out = join(DIR, "harvest_time_report.csv");
  writeFileSync(out, lines.join("\n") + "\n", "utf8");

  const byDay = new Map<string, { rows: number; hours: number }>();
  for (const e of entries) {
    const seen = byDay.get(e.spent_date) ?? { rows: 0, hours: 0 };
    seen.rows += 1;
    seen.hours += e.hours ?? 0;
    byDay.set(e.spent_date, seen);
  }

  console.log("");
  for (const [day, seen] of [...byDay.entries()].sort()) {
    console.log(`  ${day}  ${seen.rows} rows  ${seen.hours.toFixed(2)}h`);
  }
  console.log("");
  console.log(`Wrote ${out}: ${entries.length} rows, ${hours.toFixed(2)} hours.`);
  console.log(`Next: pnpm harvest:delta --dir "${DIR}" --since ${FROM} --sql <file>`);
}

await main();
