/**
 * Import the real Harvest account from its CSV exports (TALLY-46).
 *
 *   pnpm harvest:import [--dir "C:/Users/jason/Downloads/harvest exports"] [--dry]
 *                       [--dev-password] [--billed-before YYYY-MM-DD]
 *
 * BACKEND_PRD §16 describes this against the Harvest API. We do not have API
 * credentials; we have seven CSVs. §16.0 records the difference. The important
 * consequence is that **the CSVs carry no Harvest ids**, so the upsert key the
 * PRD specifies does not exist and natural keys stand in: a client is its name,
 * a project is its client plus its name, a person is their full name, a task is
 * its name. That is what makes a second run update rather than duplicate.
 *
 * THE SHAPE OF THE PROBLEM
 *
 * The files disagree about scope. The client, project and people lists are a
 * snapshot of what is current; the time report is ten years of history. It
 * references 356 projects where the list has 40, and 56 people where the list
 * has 11. Importing only the lists would drop most of the history on the floor,
 * so entities are created from whichever file mentions them and anything absent
 * from a current list is created **archived**.
 *
 * SAFETY
 *
 * Everything happens in one transaction. A failure leaves the database exactly
 * as it was rather than half-populated, which matters because the reconciliation
 * at the end is the only thing that can tell you the import was right, and it
 * cannot run against a partial load.
 */

import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { readdirSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import { db, sql as pg } from "../src/server/db/client";
import * as s from "../src/server/db/schema";
import { newId } from "../src/server/db/ids";
import { hashPassword } from "../src/server/auth/password";
import { readCsv, num, cents, yes, type Row } from "./lib/csv";

/* --------------------------------------------------------------- arguments */

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const DIR = flag("dir") ?? "C:/Users/jason/Downloads/harvest exports";
const DRY = args.includes("--dry");

/**
 * Give the imported accounts the local development password.
 *
 * Off by default and refused outside development. The import itself has no
 * business setting credentials: real accounts should arrive through an invite
 * or SSO. But a local database of real data that nobody can sign in to is not
 * useful, and the alternative is doing it by hand with a SQL client, which is
 * worse.
 *
 * Only accounts with a real email get one. The history-only accounts keep their
 * `@imported.invalid` address and no password, so they stay unusable.
 */
const DEV_PASSWORD = args.includes("--dev-password");
if (DEV_PASSWORD && process.env.NODE_ENV === "production") {
  throw new Error("--dev-password is a development convenience and is refused in production.");
}

/**
 * Treat everything before a date as already billed: `--billed-before 2026-01-01`.
 *
 * Harvest's `Invoiced?` column is only true for work invoiced through Harvest,
 * and most of this account's ten years was not. Mapped literally it produces an
 * Uninvoiced screen showing $[private total removed] of open work, $[private total removed] of it from 2019 to
 * 2025 and none of it collectable. That figure is wrong in the direction that
 * gets acted on, which is worse than being obviously absent.
 *
 * The cutoff is a business fact only Jason has, so it is off by default and the
 * literal mapping stands until he names a date. It sets the same
 * `billed_externally` flag, so nothing downstream needs to know the difference:
 * the rows stay locked (§4.10) and out of the uninvoiced report (§4.11).
 */
const BILLED_BEFORE = flag("billed-before");
if (BILLED_BEFORE && !/^\d{4}-\d{2}-\d{2}$/.test(BILLED_BEFORE)) {
  throw new Error(`--billed-before wants YYYY-MM-DD, got ${JSON.stringify(BILLED_BEFORE)}`);
}
let preCutoff = 0;
const billedExternally = (r: Row, spentOn: string): boolean => {
  if (yes(r["Invoiced?"])) return true;
  if (BILLED_BEFORE && spentOn < BILLED_BEFORE) {
    preCutoff++;
    return true;
  }
  return false;
};

/* ------------------------------------------------------------------ source */

const file = (name: string) => `${DIR}/${name}`;
const load = (name: string): Row[] => {
  try {
    return readCsv(file(name));
  } catch {
    console.log(`  (${name} is absent, skipping)`);
    return [];
  }
};

console.log(`Reading ${DIR}`);
console.log(readdirSync(DIR).filter((f) => f.endsWith(".csv")).join(", "));

const clientRows = load("harvest_client_list.csv");
const contactRows = load("harvest_contact_list.csv");
const peopleRows = load("harvest_people_list.csv");
const projectRows = load("harvest_project_list.csv");
const taskRows = load("harvest_task_list.csv");
const timeRows = load("harvest_time_report.csv");
const expenseRows = load("harvest_expense_report.csv");

console.log(
  `\nParsed: ${timeRows.length} time, ${expenseRows.length} expenses, ${clientRows.length} clients, ` +
    `${projectRows.length} projects, ${peopleRows.length} people, ${taskRows.length} tasks\n`
);

/* ------------------------------------------------------------------ naming */

const fullName = (first: string | undefined, last: string | undefined) =>
  `${(first ?? "").trim()} ${(last ?? "").trim()}`.trim();

/**
 * An address for somebody who only exists in history.
 *
 * `users.email` is required and unique, and the export gives no email for the
 * 45 people who appear only in the time report. `.invalid` is reserved by
 * RFC 2606 and can never resolve, so this can never reach a real inbox and
 * nobody can sign in as one of these accounts.
 */
const placeholderEmail = (name: string) =>
  `${name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "")}@imported.invalid`;

/** Harvest's permission words, mapped to our profiles. */
const profileFor = (permission: string): string => {
  const p = permission.trim().toLowerCase();
  if (p === "owner" || p === "administrator") return "administrator";
  if (p === "manager") return "project_manager";
  return "member";
};

/** Harvest's Budget By column, mapped to our budget dimensions. */
const budgetBy = (value: string): { by: string; isFees: boolean } => {
  const v = value.trim().toLowerCase();
  if (v === "hours") return { by: "project_hours", isFees: false };
  if (v.includes("dollar") || v.includes("usd")) return { by: "project_fees", isFees: true };
  return { by: "none", isFees: false };
};

/**
 * A calendar day from Harvest's export.
 *
 * Dates arrive as `YYYY-MM-DD` and are already the day the work was recorded
 * against, so they are taken verbatim. Turning them into a Date and back would
 * drag them through a timezone and can move them by one, which is the bug
 * `tests/date-guard.test.ts` exists to prevent elsewhere.
 */
const day = (value: string | undefined): string | null => {
  const v = (value ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
};

/** Harvest's `Started At` is a wall-clock time on the entry's own day. */
function stamp(spentOn: string, clock: string | undefined): Date | null {
  const t = (clock ?? "").trim();
  if (!t) return null;
  const m = /^(\d{1,2}):(\d{2})\s*(am|pm)?$/i.exec(t);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2]);
  const suffix = m[3]?.toLowerCase();
  if (suffix === "pm" && hour !== 12) hour += 12;
  if (suffix === "am" && hour === 12) hour = 0;
  const [y, mo, d] = spentOn.split("-").map(Number);
  return new Date(Date.UTC(y!, mo! - 1, d!, hour, minute));
}

/* -------------------------------------------------------------------- main */

const counts: Record<string, number> = {};
const notes: string[] = [];
const bump = (k: string, by = 1) => (counts[k] = (counts[k] ?? 0) + by);

async function main() {
  const startedAt = Date.now();

  const devHash = DEV_PASSWORD ? await hashPassword("tally-dev-password") : null;

  await db.transaction(async (tx) => {
    /* ---- profiles, which everything else hangs off --------------------- */

    const profiles = await tx.select().from(s.permissionProfiles);
    const profileByKey = new Map(profiles.map((p) => [p.baseKey, p.id]));
    const memberProfile = profileByKey.get("member");
    if (!memberProfile) throw new Error("No base permission profiles. Run pnpm db:migrate first.");

    /* ---- people -------------------------------------------------------- */

    const existingUsers = await tx.select().from(s.users);
    const userByName = new Map(existingUsers.map((u) => [fullName(u.firstName, u.lastName), u]));
    const userByEmail = new Map(existingUsers.map((u) => [u.email.toLowerCase(), u]));

    /** Everyone the export mentions anywhere, listed or not. */
    const namesInHistory = new Set<string>();
    for (const r of timeRows) namesInHistory.add(fullName(r["First Name"], r["Last Name"]));
    for (const r of expenseRows) namesInHistory.add(fullName(r["First name"], r["Last name"]));
    namesInHistory.delete("");

    const listedNames = new Set(peopleRows.map((r) => fullName(r["First Name"], r["Last Name"])));

    const userIdByName = new Map<string, string>();

    for (const r of peopleRows) {
      const name = fullName(r["First Name"], r["Last Name"]);
      const email = r.Email?.trim().toLowerCase();
      if (!name || !email) continue;

      const existing = userByEmail.get(email) ?? userByName.get(name);
      const values = {
        email,
        firstName: r["First Name"]!.trim(),
        lastName: r["Last Name"]!.trim(),
        employmentType: yes(r.Employee) ? "employee" : "contractor",
        weeklyCapacitySeconds: Math.round(num(r.Capacity) * 3600) || 144000,
        isOwner: r.Permissions?.trim().toLowerCase() === "owner",
        profileId: profileByKey.get(profileFor(r.Permissions ?? "")) ?? memberProfile,
        externalRef: { harvest: { source: "people_list", name } },
      };

      /* An existing password is never overwritten: a re-import must not lock
         somebody out of an account they already use. */
      const withPassword = devHash ? { ...values, passwordHash: devHash } : values;

      if (existing) {
        await tx
          .update(s.users)
          .set({ ...(existing.passwordHash ? values : withPassword), archivedAt: null })
          .where(eq(s.users.id, existing.id));
        userIdByName.set(name, existing.id);
        bump("users updated");
      } else {
        const id = newId();
        await tx.insert(s.users).values({ id, ...withPassword });
        userIdByName.set(name, id);
        bump(devHash ? "users created (with the dev password)" : "users created");
      }

      /* Current rates, so entries made from today forward have one. The
         historical entries carry their own snapshot and do not consult this. */
      const userId = userIdByName.get(name)!;
      await tx.delete(s.userRates).where(eq(s.userRates.userId, userId));
      for (const [kind, raw] of [["billable", r["Billable Rate"]], ["cost", r["Cost Rate"]]] as const) {
        if (!raw?.trim()) continue;
        await tx.insert(s.userRates).values({ id: newId(), userId, kind, amountCents: cents(raw) });
        bump("rate periods");
      }
    }

    /**
     * Everybody else: archived, unreachable, and present only so their history
     * has an owner. Dropping them would drop the time with them.
     */
    for (const name of namesInHistory) {
      if (listedNames.has(name) || userIdByName.has(name)) continue;
      const existing = userByName.get(name);
      if (existing) {
        userIdByName.set(name, existing.id);
        continue;
      }
      const [first, ...rest] = name.split(" ");
      const id = newId();
      await tx.insert(s.users).values({
        id,
        email: placeholderEmail(name),
        firstName: first ?? name,
        lastName: rest.join(" ") || "-",
        employmentType: "contractor",
        profileId: memberProfile,
        archivedAt: new Date(),
        externalRef: { harvest: { source: "time_report", name, note: "history only, no email in export" } },
      });
      userIdByName.set(name, id);
      bump("users created (history only)");
    }

    /* ---- clients ------------------------------------------------------- */

    const existingClients = await tx.select().from(s.clients);
    const clientIdByName = new Map(existingClients.map((c) => [c.name, c.id]));

    const clientNames = new Set<string>(clientRows.map((r) => r["Client Name"]!.trim()).filter(Boolean));
    for (const r of timeRows) if (r.Client) clientNames.add(r.Client.trim());
    for (const r of expenseRows) if (r.Client) clientNames.add(r.Client.trim());
    for (const r of projectRows) if (r.Client) clientNames.add(r.Client.trim());

    const listedClients = new Map(clientRows.map((r) => [r["Client Name"]!.trim(), r]));

    for (const name of clientNames) {
      if (!name) continue;
      const listed = listedClients.get(name);
      const address = listed?.Address?.trim() || null;

      const existingId = clientIdByName.get(name);
      if (existingId) {
        await tx.update(s.clients).set({ address, archivedAt: null }).where(eq(s.clients.id, existingId));
        bump("clients updated");
        continue;
      }
      const id = newId();
      await tx.insert(s.clients).values({
        id,
        name,
        address,
        externalRef: { harvest: { source: listed ? "client_list" : "referenced", name } },
      });
      clientIdByName.set(name, id);
      bump("clients created");
    }

    /* ---- contacts ------------------------------------------------------ */

    for (const r of contactRows) {
      const clientId = clientIdByName.get(r.Client?.trim() ?? "");
      if (!clientId) continue;
      const email = r.Email?.trim() || null;
      const [existing] = await tx
        .select()
        .from(s.clientContacts)
        .where(and(eq(s.clientContacts.clientId, clientId), eq(s.clientContacts.firstName, r["First Name"]!.trim())))
        .limit(1);
      if (existing) continue;
      await tx.insert(s.clientContacts).values({
        id: newId(),
        clientId,
        firstName: r["First Name"]?.trim() || "-",
        lastName: r["Last Name"]?.trim() || "-",
        email,
        title: r.Title?.trim() || null,
        phoneOffice: r["Office Phone"]?.trim() || null,
        phoneMobile: r["Mobile Phone"]?.trim() || null,
        isPrimary: yes(r["Invoice Email Default"]),
        externalRef: { harvest: { source: "contact_list" } },
      });
      bump("contacts created");
    }

    /* ---- tasks --------------------------------------------------------- */

    const existingTasks = await tx.select().from(s.tasks);
    const taskIdByName = new Map(existingTasks.map((t) => [t.name, t.id]));

    const taskNames = new Set<string>(taskRows.map((r) => r["Task name"]!.trim()).filter(Boolean));
    for (const r of timeRows) if (r.Task) taskNames.add(r.Task.trim());
    const listedTasks = new Map(taskRows.map((r) => [r["Task name"]!.trim(), r]));

    for (const name of taskNames) {
      if (!name) continue;
      const listed = listedTasks.get(name);
      const active = listed ? yes(listed["Active?"]) : false;
      const existingId = taskIdByName.get(name);
      if (existingId) {
        await tx.update(s.tasks).set({ archivedAt: active ? null : new Date() }).where(eq(s.tasks.id, existingId));
        bump("tasks updated");
        continue;
      }
      const id = newId();
      await tx.insert(s.tasks).values({
        id,
        name,
        isDefaultBillable: listed ? yes(listed.Billable) : true,
        archivedAt: active ? null : new Date(),
        externalRef: { harvest: { source: listed ? "task_list" : "time_report" } },
      });
      taskIdByName.set(name, id);
      bump("tasks created");
    }

    /* ---- projects ------------------------------------------------------ */

    const existingProjects = await tx.select().from(s.projects);
    const projectKey = (client: string, name: string) => `${client}||${name}`;
    const projectIdByKey = new Map<string, string>();
    for (const p of existingProjects) {
      const clientName = [...clientIdByName.entries()].find(([, id]) => id === p.clientId)?.[0];
      if (clientName) projectIdByKey.set(projectKey(clientName, p.name), p.id);
    }

    const projectKeys = new Set<string>();
    for (const r of projectRows) projectKeys.add(projectKey(r.Client!.trim(), r.Project!.trim()));
    for (const r of timeRows) if (r.Client && r.Project) projectKeys.add(projectKey(r.Client.trim(), r.Project.trim()));
    for (const r of expenseRows) if (r.Client && r.Project) projectKeys.add(projectKey(r.Client.trim(), r.Project.trim()));

    const listedProjects = new Map(projectRows.map((r) => [projectKey(r.Client!.trim(), r.Project!.trim()), r]));

    for (const key of projectKeys) {
      const [clientName, name] = key.split("||");
      const clientId = clientIdByName.get(clientName!);
      if (!clientId || !name) continue;

      const listed = listedProjects.get(key);
      const budget = listed ? budgetBy(listed["Budget By"] ?? "") : { by: "none", isFees: false };
      const budgetAmount = listed ? num(listed.Budget) : 0;

      const values = {
        clientId,
        name,
        code: listed?.["Project Code"]?.trim() || null,
        startsOn: day(listed?.["Start Date"]),
        endsOn: day(listed?.["End Date"]),
        notes: listed?.["Project Notes"]?.trim() || null,
        budgetBy: budget.by,
        budgetSeconds: budget.by === "project_hours" && budgetAmount ? Math.round(budgetAmount * 3600) : null,
        budgetFeeCents: budget.isFees && budgetAmount ? Math.round(budgetAmount * 100) : null,
        /* Not in the current list means not a current project. It exists so its
           history has somewhere to live. */
        archivedAt: listed ? null : new Date(),
        externalRef: { harvest: { source: listed ? "project_list" : "history", client: clientName, name } },
      };

      const existingId = projectIdByKey.get(key);
      if (existingId) {
        await tx.update(s.projects).set(values).where(eq(s.projects.id, existingId));
        bump("projects updated");
      } else {
        const id = newId();
        await tx.insert(s.projects).values({ id, ...values, billingType: "time_and_materials", billBy: "project" });
        projectIdByKey.set(key, id);
        bump(listed ? "projects created" : "projects created (history only)");
      }
    }

    /* ---- project tasks -------------------------------------------------- */

    /* A time entry points at a project_task, not a task, so every pair the
       history uses has to exist. */
    const existingPairs = await tx.select().from(s.projectTasks);
    const pairKey = (projectId: string, taskId: string) => `${projectId}|${taskId}`;
    const projectTaskId = new Map(existingPairs.map((p) => [pairKey(p.projectId, p.taskId), p.id]));

    const wantedPairs = new Set<string>();
    for (const r of timeRows) {
      const pid = projectIdByKey.get(projectKey(r.Client?.trim() ?? "", r.Project?.trim() ?? ""));
      const tid = taskIdByName.get(r.Task?.trim() ?? "");
      if (pid && tid) wantedPairs.add(pairKey(pid, tid));
    }

    const newPairs: (typeof s.projectTasks.$inferInsert)[] = [];
    for (const key of wantedPairs) {
      if (projectTaskId.has(key)) continue;
      const [projectId, taskId] = key.split("|");
      const id = newId();
      newPairs.push({ id, projectId: projectId!, taskId: taskId! });
      projectTaskId.set(key, id);
    }
    for (let i = 0; i < newPairs.length; i += 1000) {
      await tx.insert(s.projectTasks).values(newPairs.slice(i, i + 1000));
    }
    bump("project tasks created", newPairs.length);

    /* ---- project members ------------------------------------------------ */

    /* The export has no assignment file, so membership is inferred from who
       actually booked time. That is a truer statement than an empty list. */
    const existingMembers = await tx.select().from(s.projectMembers);
    const memberKey = (p: string, u: string) => `${p}|${u}`;
    const members = new Set(existingMembers.map((m) => memberKey(m.projectId, m.userId)));

    const wantedMembers = new Set<string>();
    for (const r of timeRows) {
      const pid = projectIdByKey.get(projectKey(r.Client?.trim() ?? "", r.Project?.trim() ?? ""));
      const uid = userIdByName.get(fullName(r["First Name"], r["Last Name"]));
      if (pid && uid) wantedMembers.add(memberKey(pid, uid));
    }

    const newMembers: (typeof s.projectMembers.$inferInsert)[] = [];
    for (const key of wantedMembers) {
      if (members.has(key)) continue;
      const [projectId, userId] = key.split("|");
      newMembers.push({ id: newId(), projectId: projectId!, userId: userId! });
    }
    for (let i = 0; i < newMembers.length; i += 1000) {
      await tx.insert(s.projectMembers).values(newMembers.slice(i, i + 1000));
    }
    bump("project members created", newMembers.length);

    /* ---- expense categories --------------------------------------------- */

    const existingCategories = await tx.select().from(s.expenseCategories);
    const categoryIdByName = new Map(existingCategories.map((c) => [c.name, c.id]));
    for (const name of new Set(expenseRows.map((r) => r.Category?.trim()).filter(Boolean) as string[])) {
      if (categoryIdByName.has(name)) continue;
      const id = newId();
      await tx.insert(s.expenseCategories).values({
        id,
        name,
        externalRef: { harvest: { source: "expense_report" } },
      });
      categoryIdByName.set(name, id);
      bump("expense categories created");
    }

    /* ---- time entries ---------------------------------------------------- */

    /**
     * The whole history is replaced rather than merged.
     *
     * Without Harvest ids there is no key that identifies one entry, and two
     * entries by the same person on the same project, task and day are both
     * legitimate and indistinguishable. Matching on the fields would collapse
     * them; not matching would double them on a second run. Replacing every
     * imported entry is the only version that is correct twice.
     *
     * Only rows this importer created are removed. Anything typed into Tally
     * directly is left alone, which is what `source = 'import'` marks. That
     * value is one of the five the schema's own CHECK constraint allows, rather
     * than a sixth invented for this script.
     */
    const wiped = await tx.delete(s.timeEntries).where(eq(s.timeEntries.source, "import")).returning({ id: s.timeEntries.id });
    if (wiped.length) bump("previously imported entries removed", wiped.length);

    const entries: (typeof s.timeEntries.$inferInsert)[] = [];
    let skipped = 0;

    for (const r of timeRows) {
      const spentOn = day(r.Date);
      const pid = projectIdByKey.get(projectKey(r.Client?.trim() ?? "", r.Project?.trim() ?? ""));
      const tid = taskIdByName.get(r.Task?.trim() ?? "");
      const uid = userIdByName.get(fullName(r["First Name"], r["Last Name"]));
      const ptid = pid && tid ? projectTaskId.get(pairKey(pid, tid)) : undefined;

      if (!spentOn || !pid || !ptid || !uid) {
        skipped++;
        continue;
      }

      const startedAt = stamp(spentOn, r["Started At"]);
      let endedAt = stamp(spentOn, r["Ended At"]);

      /**
       * A session that ran past midnight ends on the following day.
       *
       * 355 entries have an end time earlier than their start, which the
       * `time_entries_clock_ordered` constraint rightly refuses. They are not
       * corrupt: they are overnight sessions, and the export writes both times
       * as wall clocks against the start day.
       *
       * This is not a guess. Reading them as overnight reproduces the recorded
       * `Hours` to within a rounding error on **all 355**, which is the check
       * that turns an interpretation into a fact.
       */
      if (startedAt && endedAt && endedAt < startedAt) {
        endedAt = new Date(endedAt.getTime() + 86_400_000);
        bump("overnight sessions, end moved to the next day");
      }

      entries.push({
        id: newId(),
        userId: uid,
        projectId: pid,
        projectTaskId: ptid,
        spentOn,
        durationSeconds: Math.round(num(r.Hours) * 3600),
        notes: r.Notes?.trim() || null,
        isBillable: yes(r["Billable?"]),
        billableRateCents: cents(r["Billable Rate"]),
        costRateCents: cents(r["Cost Rate"]),
        /* Harvest records THAT an entry was invoiced, never which invoice, so
           the link cannot be rebuilt. The flag locks the row and keeps the
           uninvoiced figure honest without inventing invoices (§16.2). */
        billedExternally: billedExternally(r, spentOn),
        startedAt,
        endedAt,
        timesAreInferred: !startedAt,
        source: "import",
        externalRef: { harvest: { source: "time_report" } },
      });
    }

    for (let i = 0; i < entries.length; i += 2000) {
      await tx.insert(s.timeEntries).values(entries.slice(i, i + 2000));
      if (i % 20000 === 0 && i) console.log(`  ...${i} entries`);
    }
    bump("time entries", entries.length);
    if (skipped) notes.push(`${skipped} time rows skipped: a client, project, task or person could not be resolved.`);

    /* ---- expenses -------------------------------------------------------- */

    /* Expenses have no `source` column, so the external reference is what says
       an importer put them there. Same rule: only remove our own. */
    const wipedExpenses = await tx
      .delete(s.expenses)
      .where(sql`${s.expenses.externalRef} -> 'harvest' IS NOT NULL`)
      .returning({ id: s.expenses.id });
    if (wipedExpenses.length) bump("previously imported expenses removed", wipedExpenses.length);

    let skippedExpenses = 0;
    for (const r of expenseRows) {
      const spentOn = day(r.Date);
      const pid = projectIdByKey.get(projectKey(r.Client?.trim() ?? "", r.Project?.trim() ?? ""));
      const uid = userIdByName.get(fullName(r["First name"], r["Last name"]));
      const cid = categoryIdByName.get(r.Category?.trim() ?? "");
      if (!spentOn || !pid || !uid || !cid) {
        skippedExpenses++;
        continue;
      }
      await tx.insert(s.expenses).values({
        id: newId(),
        userId: uid,
        projectId: pid,
        categoryId: cid,
        spentOn,
        totalCents: cents(r.Amount),
        units: r.Units?.trim() ? String(num(r.Units)) : null,
        notes: r.Notes?.trim() || null,
        isBillable: yes(r.Billable),
        isReimbursable: yes(r.Reimbursable),
        billedExternally: billedExternally(r, spentOn),
        externalRef: { harvest: { source: "expense_report" } },
      });
      bump("expenses");
    }
    if (skippedExpenses) notes.push(`${skippedExpenses} expense rows skipped: a reference could not be resolved.`);
    if (preCutoff)
      notes.push(
        `${preCutoff} records before ${BILLED_BEFORE} were marked billed externally by --billed-before, on top of the ones Harvest marks invoiced. They are locked and out of the uninvoiced report.`
      );

    if (DRY) {
      notes.push("DRY RUN: the transaction was rolled back and nothing was written.");
      throw new DryRun();
    }
  });

  console.log(`\nDone in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
}

class DryRun extends Error {}

main()
  .catch((e) => {
    if (e instanceof DryRun) return;
    console.error("\nImport failed. Nothing was written.\n", e);
    process.exitCode = 1;
  })
  .then(async () => {
    console.log("\n" + Object.entries(counts).map(([k, v]) => `  ${String(v).padStart(7)}  ${k}`).join("\n"));
    for (const n of notes) console.log(`\n  ! ${n}`);
    await pg.end().catch(() => {});
  });
