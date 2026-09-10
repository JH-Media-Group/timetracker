/**
 * Add new Harvest time to a Tally that is already live and being used.
 *
 *   pnpm harvest:delta [--dir "C:/Users/jason/Downloads"] [--since YYYY-MM-DD]
 *                      [--write] [--include-collisions]
 *
 * WHY THIS EXISTS ALONGSIDE harvest-import.mts
 *
 * The original importer loads a whole Harvest account into an empty database.
 * To stay correct when run twice it deletes every row it previously wrote and
 * re-inserts them, which is the only honest answer when the source carries no
 * ids: two entries by the same person on the same project, task and day are
 * both legitimate and indistinguishable, so matching on fields would collapse
 * them and not matching would double them.
 *
 * That is exactly wrong against a live system. On the database this was written
 * for it would have deleted 56,751 entries including the 1,213 behind a paid
 * invoice of $[private total removed], re-inserted them with no invoice link and no rate
 * lock, and put six figures of already-billed work back on the uninvoiced list.
 * It also rebuilds people and rewrites their rates from the people list, which
 * would have discarded eighteen rate records somebody had set by hand.
 *
 * So this script does the opposite of that one. **It only ever inserts.** It
 * issues no DELETE and no UPDATE, it never creates or changes a client, a
 * project, a task, a person or a rate, and if anything it needs is missing it
 * stops rather than inventing it.
 *
 * THE COLLISION PROBLEM, WHICH IS THE INTERESTING ONE
 *
 * The team kept working in Harvest after the first import while also entering
 * time in Tally, so the same work exists in both. On the first run of this
 * script, Person10 had five entries in Tally for 9 September totalling 6.22 hours
 * and Harvest had five totalling 6.23. Importing that adds a day of work that
 * was already there.
 *
 * No rule can tell "the same afternoon recorded twice" from "two afternoons"
 * with the data available. So the script does not guess: any person, day and
 * project that already has time in Tally is **held back and reported**, and a
 * human decides. `--include-collisions` overrides that, and exists so the
 * override is a deliberate word somebody typed rather than a default.
 */

import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { db, sql as pg } from "../src/server/db/client";
import * as s from "../src/server/db/schema";
import { newId } from "../src/server/db/ids";
import { readCsv, num, cents, yes } from "./lib/csv";

/* --------------------------------------------------------------- arguments */

const args = process.argv.slice(2);
const flag = (name: string, fallback = "") => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : (args[i + 1] ?? fallback);
};

const DIR = flag("--dir", "C:/Users/jason/Downloads");
const WRITE = args.includes("--write");
const INCLUDE_COLLISIONS = args.includes("--include-collisions");
/* Proceed with the rows that do resolve, having read the list of the ones that
   do not. Deliberately not the default: an unresolvable row usually means the
   export and the database disagree about something, and finding that out by
   silently dropping time is how hours go missing. */
const SKIP_UNRESOLVED = args.includes("--skip-unresolved");
/* Write the inserts out as SQL instead of connecting to the target.

   The live database listens only inside the droplet's Docker network, and
   reaching it from here would mean copying the production credentials onto a
   laptop. The runbook says never to do that, and it is right. So the rows are
   emitted as a single reviewable statement, carried over, and run through psql
   inside the container where authentication is already local.

   It is the better artifact anyway: somebody can read exactly what will
   execute before it does, which is not true of a script that connects. */
const SQL_OUT = flag("--sql", "");
const SINCE = flag("--since", "");

if (!/^\d{4}-\d{2}-\d{2}$/.test(SINCE)) {
  throw new Error("--since YYYY-MM-DD is required. It is the first day to import, and it bounds the blast radius.");
}

/* ------------------------------------------------------------------ helpers */

const fullName = (first?: string, last?: string) => `${first?.trim() ?? ""} ${last?.trim() ?? ""}`.trim();
const projectKey = (client: string, project: string) => `${client.trim()} >> ${project.trim()}`;

/** Harvest writes dates as YYYY-MM-DD in this export. Anything else is a bug worth stopping for. */
function day(value?: string): string | null {
  const v = value?.trim() ?? "";
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

/** A Postgres string literal. Doubling the quote is the whole of the escaping. */
const lit = (v: string | null | undefined) => (v == null ? "NULL" : `'${v.replace(/'/g, "''")}'`);

async function main() {
  console.log(`Reading ${DIR}`);
  const timeRows = readCsv(`${DIR}/harvest_time_report.csv`);
  console.log(`  harvest_time_report.csv: ${timeRows.length} rows`);

  const windowRows = timeRows.filter((r) => {
    const d = day(r.Date);
    return d !== null && d >= SINCE;
  });
  console.log(`  on or after ${SINCE}: ${windowRows.length}`);
  if (!windowRows.length) {
    console.log("Nothing to do.");
    return;
  }

  /* ---- resolve everything against the database exactly as it stands ------ */

  const clientRows = await db.select({ id: s.clients.id, name: s.clients.name }).from(s.clients);
  const projectRows = await db
    .select({ id: s.projects.id, name: s.projects.name, clientName: s.clients.name })
    .from(s.projects)
    .innerJoin(s.clients, eq(s.clients.id, s.projects.clientId));
  const userRows = await db
    .select({ id: s.users.id, first: s.users.firstName, last: s.users.lastName })
    .from(s.users);
  const projectTaskRows = await db
    .select({ id: s.projectTasks.id, projectId: s.projectTasks.projectId, taskName: s.tasks.name })
    .from(s.projectTasks)
    .innerJoin(s.tasks, eq(s.tasks.id, s.projectTasks.taskId));

  const projectIdByKey = new Map(projectRows.map((p) => [projectKey(p.clientName, p.name), p.id]));
  const userIdByName = new Map(userRows.map((u) => [fullName(u.first, u.last), u.id]));
  const projectTaskId = new Map(projectTaskRows.map((pt) => [`${pt.projectId}::${pt.taskName.trim()}`, pt.id]));

  console.log(
    `  live reference: ${clientRows.length} clients, ${projectRows.length} projects, ` +
      `${userRows.length} people, ${projectTaskRows.length} project tasks`
  );

  /* ---- what is already in the window, for collision detection ------------ */

  const existing = await db
    .select({ userId: s.timeEntries.userId, projectId: s.timeEntries.projectId, spentOn: s.timeEntries.spentOn })
    .from(s.timeEntries)
    .where(and(gte(s.timeEntries.spentOn, SINCE), isNull(s.timeEntries.deletedAt)));

  const occupied = new Set(existing.map((e) => `${e.userId}|${e.projectId}|${e.spentOn}`));
  console.log(`  live entries already in the window: ${existing.length}`);

  /* ---- build the insert, refusing to invent anything --------------------- */

  const unresolved: string[] = [];
  const collisions = new Map<string, { rows: number; hours: number; label: string }>();
  const inserts: (typeof s.timeEntries.$inferInsert)[] = [];
  let hours = 0;

  for (const r of windowRows) {
    const spentOn = day(r.Date)!;
    const who = fullName(r["First Name"], r["Last Name"]);
    const pid = projectIdByKey.get(projectKey(r.Client ?? "", r.Project ?? ""));
    const uid = userIdByName.get(who);

    /*
      Collision before resolution, and the order matters.

      A row that is held back is not going to be inserted, so whether its task
      happens to be assigned to that project is beside the point. Checking
      resolution first made two of Person03's rows abort the entire run over a
      task link that was never going to be used, because the same person, day
      and project was already held as a collision.
    */
    if (uid && pid) {
      const slot = `${uid}|${pid}|${spentOn}`;
      if (occupied.has(slot) && !INCLUDE_COLLISIONS) {
        const key = `${who}|${spentOn}|${r.Project}`;
        const seen = collisions.get(key) ?? { rows: 0, hours: 0, label: `${who}  ${spentOn}  ${r.Project}` };
        seen.rows += 1;
        seen.hours += num(r.Hours);
        collisions.set(key, seen);
        continue;
      }
    }

    const ptid = pid ? projectTaskId.get(`${pid}::${(r.Task ?? "").trim()}`) : undefined;

    if (!pid || !uid || !ptid) {
      unresolved.push(
        `${spentOn} ${who}: ${r.Client} / ${r.Project} / ${r.Task}` +
          `${!uid ? "  [no such person]" : ""}${!pid ? "  [no such project]" : ""}` +
          `${pid && !ptid ? "  [task not on that project]" : ""}`
      );
      continue;
    }

    const duration = Math.round(num(r.Hours) * 3600);
    hours += num(r.Hours);

    inserts.push({
      id: newId(),
      userId: uid,
      projectId: pid,
      projectTaskId: ptid,
      spentOn,
      durationSeconds: duration,
      notes: r.Notes?.trim() || null,
      isBillable: yes(r["Billable?"]),
      /* The export carries the rate Harvest charged, and it is the truth about
         what this hour was worth. Re-resolving from the project would produce
         zero for the thirty-nine active projects that have no rate set. */
      billableRateCents: cents(r["Billable Rate"]),
      costRateCents: cents(r["Cost Rate"]),
      /* Harvest records THAT an entry was invoiced, never which invoice, so the
         link cannot be rebuilt. The flag keeps it off the uninvoiced list
         without inventing an invoice. */
      billedExternally: yes(r["Invoiced?"]),
      timesAreInferred: true,
      source: "import",
      externalRef: { harvest: { source: "time_report", delta: SINCE } },
    });
  }

  /* ---- report ------------------------------------------------------------ */

  console.log("");
  if (unresolved.length) {
    const verb = SKIP_UNRESOLVED ? "SKIPPING" : "REFUSING TO RUN:";
    console.log(`${verb} ${unresolved.length} rows name something this database does not have.`);
    for (const line of unresolved.slice(0, 20)) console.log(`   ${line}`);
    if (unresolved.length > 20) console.log(`   ...and ${unresolved.length - 20} more`);
    console.log("");
    if (!SKIP_UNRESOLVED) {
      console.log("Nothing was written. Create what is missing, fix the export, or pass --skip-unresolved.");
      process.exitCode = 1;
      return;
    }
  }

  if (collisions.size) {
    const rows = [...collisions.values()].reduce((a, c) => a + c.rows, 0);
    const held = [...collisions.values()].reduce((a, c) => a + c.hours, 0);
    console.log(`HELD BACK: ${collisions.size} person/day/project combinations already have time in Tally.`);
    console.log(`  ${rows} rows, ${held.toFixed(2)} hours. Somebody has to say which version is right.`);
    for (const c of [...collisions.values()].sort((a, b) => a.label.localeCompare(b.label))) {
      console.log(`   ${c.label}  (${c.rows} harvest rows, ${c.hours.toFixed(2)}h)`);
    }
    console.log("");
  }

  console.log(`TO INSERT: ${inserts.length} entries, ${hours.toFixed(2)} hours`);
  const billable = inserts.filter((i) => i.isBillable).length;
  const rated = inserts.filter((i) => (i.billableRateCents ?? 0) > 0).length;
  console.log(`  billable: ${billable}   carrying a rate: ${rated}   already invoiced in Harvest: ${inserts.filter((i) => i.billedExternally).length}`);

  if (SQL_OUT) {
    /*
      One statement, and the anti-join is the collision guard.

      Doing it this way rather than checking in TypeScript and then inserting
      means the check and the write are the same operation, evaluated against
      the rows as they are at that instant. Somebody saving a timesheet while
      this runs cannot land between the two, because there is no between.
    */
    const cols =
      "id, user_id, project_id, project_task_id, spent_on, duration_seconds, notes, " +
      "is_billable, billable_rate_cents, cost_rate_cents, billed_externally, " +
      "times_are_inferred, source, external_ref";

    const values = inserts
      .map(
        (r) =>
          `(${lit(r.id as string)}::uuid, ${lit(r.userId as string)}::uuid, ${lit(r.projectId as string)}::uuid, ` +
          `${lit(r.projectTaskId as string)}::uuid, ${lit(r.spentOn as string)}::date, ${r.durationSeconds}, ` +
          `${lit((r.notes as string | null) ?? null)}, ${r.isBillable}, ${r.billableRateCents}, ${r.costRateCents}, ` +
          `${r.billedExternally}, ${r.timesAreInferred}, 'import', ${lit(JSON.stringify(r.externalRef))}::jsonb)`
      )
      .join(",\n    ");

    const sqlText = [
      "-- Generated by scripts/harvest-delta.mts. Review before running.",
      `-- ${inserts.length} time entries, ${hours.toFixed(2)} hours, on or after ${SINCE}.`,
      "-- Each row inserts only if that person, day and project has no live time,",
      "-- so running this twice adds nothing and a concurrent save cannot be lost.",
      "BEGIN;",
      `WITH incoming (${cols}) AS (VALUES`,
      `    ${values}`,
      ")",
      `INSERT INTO time_entries (${cols})`,
      `SELECT ${cols.split(", ").map((c) => `i.${c}`).join(", ")} FROM incoming i`,
      "WHERE NOT EXISTS (",
      "  SELECT 1 FROM time_entries te",
      "  WHERE te.user_id = i.user_id AND te.project_id = i.project_id",
      "    AND te.spent_on = i.spent_on AND te.deleted_at IS NULL",
      ");",
      "COMMIT;",
      "",
    ].join("\n");

    const { writeFileSync } = await import("node:fs");
    writeFileSync(SQL_OUT, sqlText, "utf8");
    console.log("");
    console.log(`Wrote ${SQL_OUT}: ${inserts.length} inserts, guarded row by row.`);
    return;
  }

  if (!WRITE) {
    console.log("");
    console.log("Dry run. Nothing was written. Add --write to commit.");
    return;
  }

  /*
    The collision check runs again inside the transaction, against the rows as
    they are at the moment of writing.

    The read above happens seconds earlier and outside any transaction, so
    somebody saving a timesheet in that gap would have their day filled in
    underneath us and get a duplicate. Small window, real consequence, and the
    fix costs one query. This is what makes the script safe to run while people
    are working rather than only safe at a quiet hour.
  */
  let written = 0;
  const raced: string[] = [];

  await db.transaction(async (tx) => {
    const nowOccupied = new Set(
      (
        await tx
          .select({ userId: s.timeEntries.userId, projectId: s.timeEntries.projectId, spentOn: s.timeEntries.spentOn })
          .from(s.timeEntries)
          .where(and(gte(s.timeEntries.spentOn, SINCE), isNull(s.timeEntries.deletedAt)))
      ).map((e) => `${e.userId}|${e.projectId}|${e.spentOn}`)
    );

    const final = INCLUDE_COLLISIONS
      ? inserts
      : inserts.filter((row) => {
          const slot = `${row.userId}|${row.projectId}|${row.spentOn}`;
          if (nowOccupied.has(slot)) {
            raced.push(slot);
            return false;
          }
          return true;
        });

    for (let i = 0; i < final.length; i += 500) {
      await tx.insert(s.timeEntries).values(final.slice(i, i + 500));
    }
    written = final.length;
  });

  console.log("");
  if (raced.length) {
    console.log(
      `${raced.length} rows were dropped at the last moment: somebody filled in that ` +
        `person, day and project while this was running. Re-run to see them listed.`
    );
  }
  console.log(`Written: ${written} entries.`);
}

main()
  .then(() => pg.end())
  .catch(async (e) => {
    console.error(e);
    await pg.end();
    process.exit(1);
  });
