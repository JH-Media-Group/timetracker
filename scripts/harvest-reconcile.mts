/**
 * Prove the Harvest import landed correctly (TALLY-46, BACKEND_PRD §16.3).
 *
 *   pnpm harvest:reconcile [--dir "..."] [--write]
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
 * §16.3 lists six checks. Four of them are about invoices, which this export
 * does not contain in any structured form, so they are reported as skipped
 * rather than silently dropped.
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

const time = readCsv(`${DIR}/harvest_time_report.csv`);
const expenses = readCsv(`${DIR}/harvest_expense_report.csv`);
const projects = readCsv(`${DIR}/harvest_project_list.csv`);

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

async function main() {
  say(`# Harvest import reconciliation`);
  say();
  say(`Source: \`${DIR}\``);
  say(`Checked against the local database after \`pnpm harvest:import\`.`);
  say();

  /* ---- 1. totals ----------------------------------------------------- */

  say(`## Totals`);
  say();

  const csvSeconds = time.reduce((a, r) => a + Math.round(num(r.Hours) * 3600), 0);
  const csvBillableCents = time
    .filter((r) => yes(r["Billable?"]))
    .reduce((a, r) => a + Math.round(num(r["Billable Amount"]) * 100), 0);

  const [dbTotals] = await db.execute<{ seconds: string; entries: string; billable: string }>(sql`
    SELECT COALESCE(SUM(duration_seconds), 0)::text AS seconds,
           COUNT(*)::text AS entries,
           COALESCE(SUM(CASE WHEN is_billable
                             THEN ROUND(duration_seconds::numeric * billable_rate_cents / 3600)
                             ELSE 0 END), 0)::text AS billable
      FROM time_entries
  `);

  check(
    "Entry count",
    Number(dbTotals!.entries) === time.length,
    `Harvest ${time.length.toLocaleString()}, Tally ${Number(dbTotals!.entries).toLocaleString()}`
  );
  check(
    "Total tracked seconds",
    Number(dbTotals!.seconds) === csvSeconds,
    `Harvest ${(csvSeconds / 3600).toFixed(2)}h, Tally ${(Number(dbTotals!.seconds) / 3600).toFixed(2)}h`
  );

  /**
   * Billable value is recomputed from the stored rate rather than compared to
   * the stored amount, so this tests the snapshot rather than a copied total.
   * Harvest rounds each row; so does the SQL, which is why they can be equal.
   */
  const billableDrift = Math.abs(Number(dbTotals!.billable) - csvBillableCents);
  check(
    "Billable value, recomputed from the rate snapshots",
    billableDrift === 0,
    `Harvest ${money(csvBillableCents)}, Tally ${money(Number(dbTotals!.billable))}${billableDrift ? `, out by ${money(billableDrift)}` : ""}`
  );

  /* ---- 2. per project per month --------------------------------------- */

  say();
  say(`## Hours per project per month`);
  say();

  const csvByKey = new Map<string, number>();
  for (const r of time) {
    const key = `${r.Client}||${r.Project}||${(r.Date ?? "").slice(0, 7)}`;
    csvByKey.set(key, (csvByKey.get(key) ?? 0) + Math.round(num(r.Hours) * 3600));
  }

  const dbRows = await db.execute<{ client: string; project: string; month: string; seconds: string }>(sql`
    SELECT c.name AS client, p.name AS project,
           to_char(t.spent_on, 'YYYY-MM') AS month,
           SUM(t.duration_seconds)::text AS seconds
      FROM time_entries t
      JOIN projects p ON p.id = t.project_id
      JOIN clients  c ON c.id = p.client_id
     GROUP BY c.name, p.name, month
  `);

  const dbByKey = new Map(dbRows.map((r) => [`${r.client}||${r.project}||${r.month}`, Number(r.seconds)]));

  const mismatched: string[] = [];
  for (const [key, seconds] of csvByKey) {
    const got = dbByKey.get(key);
    if (got !== seconds) {
      mismatched.push(`${key.replace(/\|\|/g, " / ")}: Harvest ${(seconds / 3600).toFixed(2)}h, Tally ${got == null ? "absent" : (got / 3600).toFixed(2) + "h"}`);
    }
  }
  for (const key of dbByKey.keys()) {
    if (!csvByKey.has(key)) mismatched.push(`${key.replace(/\|\|/g, " / ")}: in Tally, not in Harvest`);
  }

  check(
    `Every project and month agrees to the second`,
    mismatched.length === 0,
    `${csvByKey.size.toLocaleString()} combinations checked${mismatched.length ? `, ${mismatched.length} differ` : ""}`
  );
  for (const m of mismatched.slice(0, 20)) say(`    - ${m}`);
  if (mismatched.length > 20) say(`    - ...and ${mismatched.length - 20} more`);

  /* ---- 3. per person all time ----------------------------------------- */

  say();
  say(`## Hours per person, all time`);
  say();

  const csvByPerson = new Map<string, number>();
  for (const r of time) {
    const name = `${r["First Name"]} ${r["Last Name"]}`.trim();
    csvByPerson.set(name, (csvByPerson.get(name) ?? 0) + Math.round(num(r.Hours) * 3600));
  }

  const dbPeople = await db.execute<{ name: string; seconds: string }>(sql`
    SELECT (u.first_name || ' ' || u.last_name) AS name, SUM(t.duration_seconds)::text AS seconds
      FROM time_entries t JOIN users u ON u.id = t.user_id
     GROUP BY name
  `);
  const dbPersonMap = new Map(dbPeople.map((r) => [r.name.trim(), Number(r.seconds)]));

  const peopleOff: string[] = [];
  for (const [name, seconds] of csvByPerson) {
    if (dbPersonMap.get(name) !== seconds) {
      peopleOff.push(`${name}: Harvest ${(seconds / 3600).toFixed(2)}h, Tally ${((dbPersonMap.get(name) ?? 0) / 3600).toFixed(2)}h`);
    }
  }
  check(`Every person's all-time total agrees`, peopleOff.length === 0, `${csvByPerson.size} people`);
  for (const p of peopleOff.slice(0, 20)) say(`    - ${p}`);

  /* ---- 4. expenses ----------------------------------------------------- */

  say();
  say(`## Expenses`);
  say();

  const csvExpenseCents = expenses.reduce((a, r) => a + Math.round(num(r.Amount) * 100), 0);
  const [dbExp] = await db.execute<{ n: string; total: string }>(sql`
    SELECT COUNT(*)::text AS n, COALESCE(SUM(total_cents), 0)::text AS total FROM expenses
  `);
  check("Expense count", Number(dbExp!.n) === expenses.length, `Harvest ${expenses.length}, Tally ${dbExp!.n}`);
  check(
    "Expense value",
    Number(dbExp!.total) === csvExpenseCents,
    `Harvest ${money(csvExpenseCents)}, Tally ${money(Number(dbExp!.total))}`
  );

  /* ---- 5. current projects are present and live ------------------------ */

  say();
  say(`## Current projects`);
  say();

  const dbProjects = await db.execute<{ client: string; project: string; archived: boolean }>(sql`
    SELECT c.name AS client, p.name AS project, (p.archived_at IS NOT NULL) AS archived
      FROM projects p JOIN clients c ON c.id = p.client_id
  `);
  const liveKeys = new Set(dbProjects.filter((r) => !r.archived).map((r) => `${r.client}||${r.project}`));

  const missingLive = projects
    .map((r) => `${r.Client}||${r.Project}`)
    .filter((k) => !liveKeys.has(k));

  check(
    "Every project on Harvest's current list exists and is not archived",
    missingLive.length === 0,
    `${projects.length} listed`
  );
  for (const m of missingLive.slice(0, 20)) say(`    - ${m.replace("||", " / ")}`);

  /* ---- 6. billed-externally, which replaces the invoice checks ---------- */

  say();
  say(`## Invoiced work`);
  say();

  const csvInvoiced = time.filter((r) => yes(r["Invoiced?"])).length;
  const [dbInvoiced] = await db.execute<{ n: string }>(sql`
    SELECT COUNT(*)::text AS n FROM time_entries WHERE billed_externally
  `);
  check(
    "Entries Harvest marks invoiced are locked in Tally",
    Number(dbInvoiced!.n) === csvInvoiced,
    `Harvest ${csvInvoiced.toLocaleString()}, Tally ${Number(dbInvoiced!.n).toLocaleString()}`
  );

  say();
  say(`**Four of the six checks in §16.3 cannot run.** Invoice count, invoiced total, paid total and`);
  say(`the uninvoiced-per-client comparison all need invoice records, and the export contains`);
  say(`invoices only as PDFs. They are skipped, not passed.`);

  /* ---- 7. things a human should look at --------------------------------- */

  say();
  say(`## For a human`);
  say();

  say(`- **"Sample Person 16" and "Sample Person 18" are imported as two people**, with`);
  const tiha = [...csvByPerson.entries()].filter(([n]) => n.toLowerCase().startsWith("tih"));
  for (const [n, sec] of tiha) say(`  ${(sec / 3600).toFixed(0)}h as "${n}"`);
  say(`  They are almost certainly one person. Merging on a guess is the kind of change that is`);
  say(`  invisible afterwards, so the importer leaves it to a decision.`);
  say();
  const [historyOnly] = await db.execute<{ n: string }>(sql`
    SELECT COUNT(*)::text AS n FROM users WHERE email LIKE '%@imported.invalid'
  `);
  say(`- **${historyOnly!.n} people exist only in history** and have no email in the export. They are`);
  say(`  archived, hold an \`@imported.invalid\` address that can never receive mail, and have no`);
  say(`  password, so none of them is a usable account.`);
  say();
  const [archivedProjects] = await db.execute<{ n: string }>(sql`
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
