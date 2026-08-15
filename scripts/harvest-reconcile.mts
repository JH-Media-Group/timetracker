/**
 * Prove the Harvest import landed correctly (TALLY-46, BACKEND_PRD §16.3).
 *
 *   pnpm harvest:reconcile [--dir "..."] [--billed-before YYYY-MM-DD] [--write]
 *
 * The import reporting "56,751 entries" says only that 56,751 rows were
 * inserted. It says nothing about whether they hold the right values, are
 * attached to the right project, or add up to what Harvest thinks. This does.
 *
 * Every check compares the CSV, read again from scratch, against what SQL now
 * returns. Anything that disagrees is printed with both figures rather than
 * summarised, because "3 projects differ" is not actionable and
 * "Example Client 04 / PRODUCT OWNER: 1,324.79 vs 1,300.00" is.
 *
 * WHAT AN ADVERSARIAL REVIEW BROKE, AND WHAT CHANGED
 *
 * The first version passed while two real corruptions sat in the data, and it
 * reported a headline figure no screen in the app can ever show. Each fix below
 * exists because a fault was injected into a clone of the database and the
 * checks said everything was fine.
 *
 *  - **Grouped by month, so a wrong day inside the right month was invisible.**
 *    Now grouped by day. A timezone error that shifts an entry by one day is
 *    exactly the class of bug this is for, and only a month boundary caught it.
 *  - **The billable flag went unverified on any entry with a zero rate**, which
 *    is 21% of them, because the only check that read the flag was a money sum.
 *    Now the billable and non-billable seconds are compared separately.
 *  - **Cost was never reconciled at all**, though it drives every profitability
 *    figure and the export carries it.
 *  - **The project list was read only to ask whether a project exists.** It also
 *    carries Harvest's own per-project totals, computed independently of the
 *    time report, so it is a free second opinion.
 *  - **Every query read the whole table.** One hand-entered row, or a seeded
 *    database, made all of it fail. Now scoped to the rows the importer owns.
 *  - **`--billed-before` made the run fail**, because the flag existed on the
 *    importer and not here.
 */

import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { writeFileSync, mkdirSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db, sql as pg } from "../src/server/db/client";
import { readCsv, num, yes } from "./lib/csv";

const args = process.argv.slice(2);
const flagValue = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? undefined : args[i + 1];
};
const DIR = flagValue("dir") ?? "C:/Users/jason/Downloads/harvest exports";
const WRITE = args.includes("--write");

/** Must match the import run, or the invoiced check compares different things. */
const BILLED_BEFORE = flagValue("billed-before");
if (BILLED_BEFORE && !/^\d{4}-\d{2}-\d{2}$/.test(BILLED_BEFORE)) {
  throw new Error(`--billed-before wants YYYY-MM-DD, got ${JSON.stringify(BILLED_BEFORE)}`);
}

const time = readCsv(`${DIR}/harvest_time_report.csv`);
const expenses = readCsv(`${DIR}/harvest_expense_report.csv`);
const projects = readCsv(`${DIR}/harvest_project_list.csv`);

/**
 * Only the rows the importer owns.
 *
 * Without this the reconciliation silently requires a database containing
 * nothing else, so `pnpm db:setup` (which seeds) followed by an import made
 * five of eight checks fail, and it could never be re-run after go-live. The
 * importer already scopes its own delete this way; this closes the asymmetry.
 */
const IMPORTED = sql`source = 'import'`;
const IMPORTED_EXPENSES = sql`external_ref->'harvest'->>'source' = 'expense_report'`;

const lines: string[] = [];
const say = (s = "") => {
  console.log(s);
  lines.push(s);
};

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  say(`${ok ? "- **PASS**" : "- **FAIL**"} ${name}${detail ? ` ${detail}` : ""}`);
};

const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const hours = (sec: number) => (sec / 3600).toFixed(2);

async function main() {
  say(`# Harvest import reconciliation`);
  say();
  say(`Source: \`${DIR}\``);
  say(`Checked against the local database after \`pnpm harvest:import\`, over rows the importer owns.`);
  if (BILLED_BEFORE) say(`Run with \`--billed-before ${BILLED_BEFORE}\`.`);
  say();

  /* ---- 1. totals ----------------------------------------------------- */

  say(`## Totals`);
  say();

  const csvSeconds = time.reduce((a, r) => a + Math.round(num(r.Hours) * 3600), 0);
  const csvBillableCents = time
    .filter((r) => yes(r["Billable?"]))
    .reduce((a, r) => a + Math.round(num(r["Billable Amount"]) * 100), 0);
  const csvCostCents = time.reduce((a, r) => a + Math.round(num(r["Cost Amount"]) * 100), 0);

  const [t] = await db.execute<Record<string, string>>(sql`
    SELECT COALESCE(SUM(duration_seconds), 0)::text AS seconds,
           COUNT(*)::text AS entries,
           COALESCE(SUM(CASE WHEN is_billable
                             THEN ROUND(duration_seconds::numeric * billable_rate_cents / 3600)
                             ELSE 0 END), 0)::text AS billable_per_row,
           COALESCE(ROUND(SUM(CASE WHEN is_billable
                                   THEN duration_seconds::numeric * billable_rate_cents
                                   ELSE 0 END) / 3600), 0)::text AS billable_aggregated,
           COALESCE(SUM(ROUND(duration_seconds::numeric * cost_rate_cents / 3600)), 0)::text AS cost_per_row,
           COALESCE(SUM(CASE WHEN is_billable THEN duration_seconds ELSE 0 END), 0)::text AS billable_seconds
      FROM time_entries WHERE ${IMPORTED}
  `);

  check("Entry count", Number(t!.entries) === time.length, `Harvest ${time.length.toLocaleString()}, Tally ${Number(t!.entries).toLocaleString()}`);
  check("Total tracked seconds", Number(t!.seconds) === csvSeconds, `Harvest ${hours(csvSeconds)}h, Tally ${hours(Number(t!.seconds))}h`);

  /**
   * Harvest rounds each row, so matching Harvest means rounding each row. That
   * is the correct comparison here and it is NOT how the app computes money.
   */
  const drift = Math.abs(Number(t!.billable_per_row) - csvBillableCents);
  check(
    "Billable value, recomputed from the rate snapshots, rounded per row as Harvest does",
    drift === 0,
    `Harvest ${money(csvBillableCents)}, Tally ${money(Number(t!.billable_per_row))}${drift ? `, out by ${money(drift)}` : ""}`
  );
  check(
    "Cost value, recomputed from the cost snapshots",
    Math.abs(Number(t!.cost_per_row) - csvCostCents) === 0,
    `Harvest ${money(csvCostCents)}, Tally ${money(Number(t!.cost_per_row))}`
  );

  const aggregated = Number(t!.billable_aggregated);
  const perRow = Number(t!.billable_per_row);
  say();
  say(`**The app will show ${money(aggregated)}, not ${money(perRow)}, and both are correct.**`);
  say(`BACKEND_PRD §3.6 requires aggregating then dividing once, so Tally computes`);
  say(`\`ROUND(SUM(seconds × rate) / 3600)\`. Harvest rounded each row and added the results.`);
  say(`Over ${time.length.toLocaleString()} entries the two methods differ by ${money(Math.abs(perRow - aggregated))}.`);
  say(`The per-row figure above proves the import matches Harvest. This one is what the`);
  say(`screens will read. Comparing the report to a screen without knowing that looks like a defect.`);

  /* ---- 2. per project per day ---------------------------------------- */

  say();
  say(`## Hours per project per day`);
  say();

  const csvByKey = new Map<string, number>();
  for (const r of time) {
    const key = `${r.Client}||${r.Project}||${r.Date}`;
    csvByKey.set(key, (csvByKey.get(key) ?? 0) + Math.round(num(r.Hours) * 3600));
  }

  const dbRows = await db.execute<Record<string, string>>(sql`
    SELECT c.name AS client, p.name AS project,
           to_char(t.spent_on, 'YYYY-MM-DD') AS day,
           SUM(t.duration_seconds)::text AS seconds
      FROM time_entries t
      JOIN projects p ON p.id = t.project_id
      JOIN clients  c ON c.id = p.client_id
     WHERE t.${IMPORTED}
     GROUP BY c.name, p.name, day
  `);
  const dbByKey = new Map(dbRows.map((r) => [`${r.client}||${r.project}||${r.day}`, Number(r.seconds)]));

  const mismatched: string[] = [];
  for (const [key, seconds] of csvByKey) {
    const got = dbByKey.get(key);
    if (got !== seconds) mismatched.push(`${key.replace(/\|\|/g, " / ")}: Harvest ${hours(seconds)}h, Tally ${got == null ? "absent" : hours(got) + "h"}`);
  }
  for (const key of dbByKey.keys()) if (!csvByKey.has(key)) mismatched.push(`${key.replace(/\|\|/g, " / ")}: in Tally, not in Harvest`);

  check(
    `Every project and **day** agrees to the second`,
    mismatched.length === 0,
    `${csvByKey.size.toLocaleString()} combinations checked${mismatched.length ? `, ${mismatched.length} differ` : ""}`
  );
  for (const m of mismatched.slice(0, 20)) say(`    - ${m}`);
  if (mismatched.length > 20) say(`    - ...and ${mismatched.length - 20} more`);

  /* ---- 3. billable split --------------------------------------------- */

  say();
  say(`## The billable flag`);
  say();

  const csvBillableSeconds = time
    .filter((r) => yes(r["Billable?"]))
    .reduce((a, r) => a + Math.round(num(r.Hours) * 3600), 0);

  check(
    "Billable and non-billable hours split the same way",
    Number(t!.billable_seconds) === csvBillableSeconds,
    `Harvest ${hours(csvBillableSeconds)}h billable, Tally ${hours(Number(t!.billable_seconds))}h`
  );
  say();
  say(`Checked as hours, not only as money. 21% of billable entries carry a zero rate, so a`);
  say(`money total cannot see their flag at all: flipping one to non-billable used to pass every check.`);

  /* ---- 4. per person -------------------------------------------------- */

  say();
  say(`## Hours per person, all time`);
  say();

  const csvByPerson = new Map<string, number>();
  for (const r of time) {
    const name = `${r["First Name"]} ${r["Last Name"]}`.trim();
    csvByPerson.set(name, (csvByPerson.get(name) ?? 0) + Math.round(num(r.Hours) * 3600));
  }
  const dbPeople = await db.execute<Record<string, string>>(sql`
    SELECT (u.first_name || ' ' || u.last_name) AS name, SUM(t.duration_seconds)::text AS seconds
      FROM time_entries t JOIN users u ON u.id = t.user_id
     WHERE t.${IMPORTED} GROUP BY name
  `);
  const dbPersonMap = new Map(dbPeople.map((r) => [r.name.trim(), Number(r.seconds)]));
  const peopleOff = [...csvByPerson.entries()]
    .filter(([n, s]) => dbPersonMap.get(n) !== s)
    .map(([n, s]) => `${n}: Harvest ${hours(s)}h, Tally ${hours(dbPersonMap.get(n) ?? 0)}h`);
  check(`Every person's all-time total agrees`, peopleOff.length === 0, `${csvByPerson.size} people`);
  for (const p of peopleOff.slice(0, 20)) say(`    - ${p}`);

  /* ---- 5. expenses ----------------------------------------------------- */

  say();
  say(`## Expenses`);
  say();

  const csvExpenseCents = expenses.reduce((a, r) => a + Math.round(num(r.Amount) * 100), 0);
  const [e] = await db.execute<Record<string, string>>(sql`
    SELECT COUNT(*)::text AS n, COALESCE(SUM(total_cents), 0)::text AS total
      FROM expenses WHERE ${IMPORTED_EXPENSES}
  `);
  check("Expense count", Number(e!.n) === expenses.length, `Harvest ${expenses.length}, Tally ${e!.n}`);
  check("Expense value", Number(e!.total) === csvExpenseCents, `Harvest ${money(csvExpenseCents)}, Tally ${money(Number(e!.total))}`);

  /* ---- 6. the project list as an independent second opinion ------------ */

  say();
  say(`## Harvest's own per-project totals`);
  say();

  const dbProjects = await db.execute<Record<string, string | boolean>>(sql`
    SELECT c.name AS client, p.name AS project, (p.archived_at IS NOT NULL) AS archived,
           COALESCE(SUM(t.duration_seconds), 0)::text AS seconds,
           COALESCE(SUM(CASE WHEN t.is_billable
                             THEN ROUND(t.duration_seconds::numeric * t.billable_rate_cents / 3600)
                             ELSE 0 END), 0)::text AS billable,
           COALESCE(SUM(ROUND(t.duration_seconds::numeric * t.cost_rate_cents / 3600)), 0)::text AS cost
      FROM projects p
      JOIN clients c ON c.id = p.client_id
      LEFT JOIN time_entries t ON t.project_id = p.id AND t.${IMPORTED}
     GROUP BY c.name, p.name, p.archived_at
  `);
  const byProject = new Map(dbProjects.map((r) => [`${r.client}||${r.project}`, r]));

  const liveMissing = projects.map((r) => `${r.Client}||${r.Project}`).filter((k) => {
    const row = byProject.get(k);
    return !row || row.archived === true;
  });
  check("Every project on Harvest's current list exists and is not archived", liveMissing.length === 0, `${projects.length} listed`);
  for (const m of liveMissing.slice(0, 20)) say(`    - ${m.replace("||", " / ")}`);

  /**
   * The list's totals are computed by Harvest from its own database, not from
   * the time report, so agreeing with them is a genuinely independent check.
   * Projects with no time are skipped: the list reports zero for them and so
   * does the join, which proves nothing.
   */
  const listOff: string[] = [];
  for (const r of projects) {
    const row = byProject.get(`${r.Client}||${r.Project}`);
    if (!row || Number(row.seconds) === 0) continue;
    const wantSeconds = Math.round(num(r["Total Hours"]) * 3600);
    const wantBillable = Math.round(num(r["Billable Amount"]) * 100);
    const wantCost = Math.round(num(r["Team Costs"]) * 100);
    if (Number(row.seconds) !== wantSeconds) listOff.push(`${r.Client} / ${r.Project}: hours ${hours(wantSeconds)} vs ${hours(Number(row.seconds))}`);
    else if (Number(row.billable) !== wantBillable) listOff.push(`${r.Client} / ${r.Project}: billable ${money(wantBillable)} vs ${money(Number(row.billable))}`);
    else if (Number(row.cost) !== wantCost) listOff.push(`${r.Client} / ${r.Project}: cost ${money(wantCost)} vs ${money(Number(row.cost))}`);
  }
  const withTime = projects.filter((r) => Number(byProject.get(`${r.Client}||${r.Project}`)?.seconds ?? 0) > 0).length;
  check("Hours, billable value and cost agree with the project list", listOff.length === 0, `${withTime} projects with time`);
  for (const m of listOff.slice(0, 20)) say(`    - ${m}`);

  /* ---- 7. invoiced ------------------------------------------------------ */

  say();
  say(`## Invoiced work`);
  say();

  const csvInvoiced = time.filter(
    (r) => yes(r["Invoiced?"]) || (BILLED_BEFORE !== undefined && r.Date! < BILLED_BEFORE)
  ).length;
  const [inv] = await db.execute<Record<string, string>>(sql`
    SELECT COUNT(*)::text AS n FROM time_entries WHERE ${IMPORTED} AND billed_externally
  `);
  check(
    BILLED_BEFORE ? `Entries invoiced, or dated before ${BILLED_BEFORE}, are locked` : "Entries Harvest marks invoiced are locked in Tally",
    Number(inv!.n) === csvInvoiced,
    `Harvest ${csvInvoiced.toLocaleString()}, Tally ${Number(inv!.n).toLocaleString()}`
  );
  if (!BILLED_BEFORE) {
    say();
    say(`Run with the same \`--billed-before\` the import used, or this check compares different things.`);
  }

  say();
  say(`**Four of the six checks in §16.3 cannot run.** Invoice count, invoiced total, paid total and`);
  say(`the uninvoiced-per-client comparison all need invoice records, and the export contains`);
  say(`invoices only as PDFs. They are skipped, not passed.`);

  /* ---- 8. things a human should look at --------------------------------- */

  say();
  say(`## For a human`);
  say();

  const tiha = [...csvByPerson.entries()].filter(([n]) => n.toLowerCase().startsWith("tih"));
  if (tiha.length > 1) {
    say(`- **Two spellings of one name are imported as two people**, with`);
    for (const [n, sec] of tiha) say(`  ${(sec / 3600).toFixed(0)}h as "${n}"`);
    say(`  They are almost certainly one person. Merging on a guess is the kind of change that is`);
    say(`  invisible afterwards, so the importer leaves it to a decision.`);
    say();
  }
  const [historyOnly] = await db.execute<Record<string, string>>(sql`
    SELECT COUNT(*)::text AS n FROM users WHERE email LIKE '%@imported.invalid'
  `);
  say(`- **${historyOnly!.n} people exist only in history** and have no email in the export. They are`);
  say(`  archived, hold an \`@imported.invalid\` address that can never receive mail, and have no`);
  say(`  password, so none of them is a usable account.`);
  say();
  const [archivedProjects] = await db.execute<Record<string, string>>(sql`
    SELECT COUNT(*)::text AS n FROM projects WHERE archived_at IS NOT NULL
  `);
  say(`- **${archivedProjects!.n} projects were created archived** because they appear in the time`);
  say(`  report but not on Harvest's current project list. Their history is intact; they simply do`);
  say(`  not clutter the active list.`);

  say();
  say(failures === 0 ? `## Result: every check that can run, passed.` : `## Result: ${failures} check(s) failed.`);

  if (WRITE) {
    mkdirSync("docs/migration", { recursive: true });
    // The local date, not the UTC one. toISOString() names the file for
    // tomorrow all evening in a US timezone, which reads as a report from a run
    // that has not happened.
    const now = new Date();
    const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const path = `docs/migration/reconciliation-${stamp}.md`;
    writeFileSync(path, lines.join("\n") + "\n", "utf8");
    console.log(`\nWritten to ${path}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .then(async () => {
    await pg.end().catch(() => {});
    if (failures) process.exitCode = 1;
  });
