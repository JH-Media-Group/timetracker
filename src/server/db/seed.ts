/**
 * Development seed.
 *
 * Writes the same dataset the front end was built against into Postgres, so the
 * two halves meet on identical numbers. It imports `src/mock/seed.ts` rather
 * than restating the data: one source, and no chance of the API and the mock
 * drifting into two different versions of JH Media Group.
 *
 * Deterministic by construction (the mock uses a seeded PRNG), so re-seeding
 * produces the same account every time. Dates move with the calendar, because
 * a demo whose most recent entry is six weeks old reads as broken.
 *
 *   pnpm db:seed            fills an empty database
 *   pnpm db:seed --force    wipes the data tables first
 */

import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { sql as raw } from "drizzle-orm";
import { db, closePool } from "./client";
import * as s from "./schema";
import { newId } from "./ids";
import * as mock from "@/mock/seed";
import { syncBaseProfiles } from "@/server/auth/profiles";
import { hashPassword } from "@/server/auth/password";
import type { BaseProfileKey } from "@/server/auth/capabilities";

/** Everyone gets this locally. Printed at the end, and never used in production. */
const DEV_PASSWORD = "tally-dev-password";

const COMPANY_ADDRESS = ["245 N. Highland Ave", "Suite 230-185", "Atlanta GA 30307"].join(`
`);

/** Mock string ids to uuids, so foreign keys line up as we go. */
const ids = new Map<string, string>();
const idFor = (key: string): string => {
  const existing = ids.get(key);
  if (existing) return existing;
  const id = newId();
  ids.set(key, id);
  return id;
};

const DATA_TABLES = [
  "retainer_transactions", "retainers", "recurring_invoices",
  "invoice_payments", "invoice_messages", "invoice_attachments",
  "invoice_line_items", "invoice_projects", "invoices",
  "time_entries", "expenses", "timesheet_submissions",
  "project_tasks", "project_members", "project_tags", "user_pinned_projects",
  "projects", "client_contacts", "clients", "tasks", "tags",
  "expense_categories", "user_rates", "user_roles", "user_departments",
  "user_managed_users", "sessions", "user_invites", "notifications",
  "audit_log", "outbox", "users", "roles", "departments",
];

async function wipe() {
  await db.execute(raw.raw(`TRUNCATE ${DATA_TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`));
}

async function main() {
  const force = process.argv.includes("--force");

  const [{ count }] = (await db.execute<{ count: string }>(
    raw`SELECT COUNT(*)::text AS count FROM users`
  )) as unknown as { count: string }[];

  if (Number(count) > 0) {
    if (!force) {
      console.log(`Database already has ${count} users. Re-run with --force to replace the data.`);
      return;
    }
    console.log("→ wiping existing data");
    await wipe();
  }

  console.log("→ permission profiles");
  const profiles = await syncBaseProfiles(db);

  console.log("→ settings");
  await db
    .insert(s.settings)
    .values({
      id: 1,
      companyName: "JH Media Group",
      companyAddress: "245 N. Highland Ave\nSuite 230-185\nAtlanta GA 30307",
      baseCurrency: "USD",
      timezone: "America/New_York",
      weekStartsOn: 1,
      timerMode: "start_end",
      timeDisplay: "decimal",
      requireNotes: "never",
      allowFutureDates: false,
      flagMissingBelowSeconds: 8 * 3600,
      invoiceNumberPattern: "{seq:5}",
      invoiceNextSeq: mock.invoices.length + 1,
      modules: { time: true, expenses: true, approvals: true, team: true, invoices: true, reports: true },
    })
    // The migration inserts a bare row so services always find one; the seed
    // fills it in properly.
    .onConflictDoUpdate({
      target: s.settings.id,
      set: {
        companyName: "JH Media Group",
        companyAddress: COMPANY_ADDRESS,
        timezone: "America/New_York",
        weekStartsOn: 1,
        timerMode: "start_end",
        flagMissingBelowSeconds: 8 * 3600,
        allowFutureDates: false,
        invoiceNextSeq: mock.invoices.length + 1,
        modules: { time: true, expenses: true, approvals: true, team: true, invoices: true, reports: true },
      },
    });

  /* ------------------------------------------------------------------ people */

  console.log(`→ ${mock.users.length} people`);
  const passwordHash = await hashPassword(DEV_PASSWORD);

  const roleNames = [...new Set(mock.users.flatMap((u) => u.roles))];
  const departmentNames = [...new Set(mock.users.flatMap((u) => u.departments))];

  await db.insert(s.roles).values(roleNames.map((name) => ({ id: idFor(`role:${name}`), name })));
  await db
    .insert(s.departments)
    .values(departmentNames.map((name) => ({ id: idFor(`dept:${name}`), name })));

  await db.insert(s.users).values(
    mock.users.map((u) => ({
      id: idFor(u.id),
      email: u.email,
      firstName: u.firstName,
      lastName: u.lastName,
      // In production this holds a Spaces object key. The mock generates a data
      // URI, and the client renders whichever it is given.
      avatarKey: u.photo ?? null,
      employmentType: u.employmentType,
      isOwner: u.isOwner ?? false,
      profileId: profiles.ids[u.profile as BaseProfileKey],
      timezone: u.timezone,
      weeklyCapacitySeconds: u.weeklyCapacitySeconds,
      startedOn: u.startedOn ?? null,
      passwordHash,
      externalRef: { mock: { id: u.id } },
    }))
  );

  await db.insert(s.userRoles).values(
    mock.users.flatMap((u) => u.roles.map((r) => ({ userId: idFor(u.id), roleId: idFor(`role:${r}`) })))
  );
  await db.insert(s.userDepartments).values(
    mock.users.flatMap((u) =>
      u.departments.map((d) => ({ userId: idFor(u.id), departmentId: idFor(`dept:${d}`) }))
    )
  );

  // Rates as open-ended ranges. Real history would carry dated ranges; the mock
  // has one rate per person, so it starts at their start date and never ends.
  await db.insert(s.userRates).values(
    mock.users.flatMap((u) => [
      {
        id: newId(),
        userId: idFor(u.id),
        kind: "billable",
        amountCents: u.billableRateCents,
        startsOn: u.startedOn ?? null,
        endsOn: null,
      },
      {
        id: newId(),
        userId: idFor(u.id),
        kind: "cost",
        amountCents: u.costRateCents,
        startsOn: u.startedOn ?? null,
        endsOn: null,
      },
    ])
  );

  // Project managers manage everyone, which matches how an eleven-person shop
  // actually works.
  const managerIds = mock.users.filter((u) => u.profile !== "member").map((u) => u.id);
  await db.insert(s.userManagedUsers).values(
    managerIds.flatMap((m) =>
      mock.users.filter((u) => u.id !== m).map((u) => ({ managerId: idFor(m), managedId: idFor(u.id) }))
    )
  );

  /* ----------------------------------------------------------------- clients */

  console.log(`→ ${mock.clients.length} clients`);
  await db.insert(s.clients).values(
    mock.clients.map((c) => ({
      id: idFor(c.id),
      name: c.name,
      address: c.address ?? null,
      currency: c.currency,
      paymentTerm: c.paymentTerm,
      externalRef: { mock: { id: c.id } },
    }))
  );

  const contacts = mock.clients.flatMap((c) => c.contacts);
  if (contacts.length) {
    await db.insert(s.clientContacts).values(
      contacts.map((ct) => ({
        id: idFor(ct.id),
        clientId: idFor(ct.clientId),
        firstName: ct.firstName,
        lastName: ct.lastName,
        title: ct.title ?? null,
        email: ct.email ?? null,
        phoneMobile: ct.phone ?? null,
        isPrimary: ct.isPrimary ?? false,
      }))
    );
  }

  /* ------------------------------------------------------------------- tasks */

  console.log(`→ ${mock.tasks.length} tasks`);
  await db.insert(s.tasks).values(
    mock.tasks.map((t) => ({
      id: idFor(t.id),
      name: t.name,
      isDefaultBillable: t.defaultBillable,
      isCommon: t.isCommon,
      externalRef: { mock: { id: t.id } },
    }))
  );

  console.log("→ expense categories");
  await db.insert(s.expenseCategories).values(
    mock.expenseCategories.map((c) => ({
      id: idFor(c.id),
      name: c.name,
      unitName: c.unitName ?? null,
      unitPriceCents: c.unitPriceCents ?? null,
    }))
  );

  /* ---------------------------------------------------------------- projects */

  console.log(`→ ${mock.projects.length} projects`);
  await db.insert(s.projects).values(
    mock.projects.map((p) => ({
      id: idFor(p.id),
      clientId: idFor(p.clientId),
      name: p.name,
      code: p.code ?? null,
      billingType: p.billingType,
      billBy: p.billBy,
      hourlyRateCents: p.hourlyRateCents ?? null,
      feeCents: p.feeCents ?? null,
      feeCadence: p.feeCadence ?? null,
      budgetBy: p.budgetBy,
      budgetSeconds: p.budgetSeconds ?? null,
      budgetFeeCents: p.budgetFeeCents ?? null,
      budgetResetsMonthly: p.budgetResetsMonthly,
      budgetAlertPercent: p.budgetAlertPercent == null ? null : String(p.budgetAlertPercent),
      startsOn: p.startsOn ?? null,
      endsOn: p.endsOn ?? null,
      notes: p.notes ?? null,
      archivedAt: p.archivedAt ? new Date(`${p.archivedAt}T00:00:00Z`) : null,
      externalRef: { mock: { id: p.id } },
    }))
  );

  // Tags
  const tagNames = [...new Set(mock.projects.flatMap((p) => p.tags))];
  if (tagNames.length) {
    await db.insert(s.tags).values(tagNames.map((name) => ({ id: idFor(`tag:${name}`), name })));
    const links = mock.projects.flatMap((p) =>
      p.tags.map((t) => ({ projectId: idFor(p.id), tagId: idFor(`tag:${t}`) }))
    );
    if (links.length) await db.insert(s.projectTags).values(links);
  }

  // project_tasks: the row a time entry actually points at.
  console.log("→ project tasks and members");
  const projectTaskRows = mock.projects.flatMap((p) =>
    p.taskIds.map((t) => {
      const task = mock.tasks.find((x) => x.id === t)!;
      return {
        id: idFor(`pt:${p.id}:${t}`),
        projectId: idFor(p.id),
        taskId: idFor(t),
        // A non-billable project makes every task on it non-billable, which is
        // what makes the rate ladder return zero without a special case.
        isBillable: p.billingType === "non_billable" ? false : task.defaultBillable,
      };
    })
  );
  await insertInChunks(s.projectTasks, projectTaskRows);

  const memberRows = mock.projects.flatMap((p) => {
    const everyone = new Set([...p.memberIds, ...p.managerIds]);
    return [...everyone].map((u) => ({
      id: idFor(`pm:${p.id}:${u}`),
      projectId: idFor(p.id),
      userId: idFor(u),
      isManager: p.managerIds.includes(u),
    }));
  });
  await insertInChunks(s.projectMembers, memberRows);

  /* ------------------------------------------------------------- time entries */

  console.log(`→ ${mock.timeEntries.length} time entries`);
  const entryRows = mock.timeEntries.map((e) => ({
    id: idFor(e.id),
    userId: idFor(e.userId),
    projectId: idFor(e.projectId),
    projectTaskId: idFor(`pt:${e.projectId}:${e.taskId}`),
    spentOn: e.spentOn,
    startedAt: e.startedAt ? new Date(e.startedAt) : null,
    endedAt: e.endedAt ? new Date(e.endedAt) : null,
    durationSeconds: e.durationSeconds,
    notes: e.notes || null,
    isBillable: e.isBillable,
    billableRateCents: e.billableRateCents,
    costRateCents: e.costRateCents,
    // Marks time invoiced in Harvest before the move. Without it every
    // historical billable hour reads as receivable on day one.
    billedExternally: e.billedExternally ?? false,
    createdBy: idFor(e.userId),
    updatedBy: idFor(e.userId),
    externalRef: { mock: { id: e.id } },
  }));
  await insertInChunks(s.timeEntries, entryRows);

  /* ---------------------------------------------------------------- expenses */

  console.log(`→ ${mock.expenses.length} expenses`);
  await insertInChunks(
    s.expenses,
    mock.expenses.map((x) => ({
      id: idFor(x.id),
      userId: idFor(x.userId),
      projectId: idFor(x.projectId),
      categoryId: idFor(x.categoryId),
      spentOn: x.spentOn,
      units: x.units == null ? null : String(x.units),
      totalCents: x.totalCents,
      notes: x.notes || null,
      isBillable: x.isBillable,
      isReimbursable: x.isReimbursable,
      reimbursementState: x.isReimbursable ? (x.reimbursementState ?? "pending") : null,
      receiptFilename: x.receiptName ?? null,
      createdBy: idFor(x.userId),
      updatedBy: idFor(x.userId),
    }))
  );

  /* ------------------------------------------------------------- submissions */

  console.log(`→ ${mock.submissions.length} timesheet submissions`);
  if (mock.submissions.length) {
    await insertInChunks(
      s.timesheetSubmissions,
      mock.submissions.map((sub) => ({
        id: idFor(sub.id),
        userId: idFor(sub.userId),
        periodStart: sub.periodStart,
        periodEnd: sub.periodEnd,
        state: sub.state === "draft" ? "submitted" : sub.state,
        submittedAt: sub.submittedAt ? new Date(sub.submittedAt) : new Date(),
        reviewedBy: sub.reviewedBy ? idFor(sub.reviewedBy) : null,
        reviewedAt: sub.reviewedAt ? new Date(sub.reviewedAt) : null,
        reviewNote: sub.reviewNote ?? null,
        totalSeconds: sub.totalSeconds,
        flags: sub.flags,
      }))
    );
  }

  /* ---------------------------------------------------------------- invoices */

  console.log(`→ ${mock.invoices.length} invoices`);
  await insertInChunks(
    s.invoices,
    mock.invoices.map((i) => ({
      id: idFor(i.id),
      clientId: idFor(i.clientId),
      number: i.number,
      subject: i.subject || null,
      notes: i.notes ?? null,
      currency: i.currency,
      issueDate: i.issueDate,
      dueDate: i.dueDate,
      // The mock carries display states; the column holds the stored ones.
      // "sent", "partial", and "late" are all `open` plus a due date.
      state: storedInvoiceState(i.state),
      subtotalCents: i.subtotalCents,
      taxCents: i.taxCents,
      discountCents: i.discountCents,
      totalCents: i.totalCents,
      paidCents: i.paidCents,
      sentAt: i.sentAt ? new Date(i.sentAt) : null,
      paidAt: i.paidAt ? new Date(i.paidAt) : null,
      externalRef: { mock: { id: i.id } },
    }))
  );

  const lineRows = mock.invoices.flatMap((i) =>
    i.lineItems.map((l) => ({
      id: idFor(l.id),
      invoiceId: idFor(i.id),
      position: l.position,
      projectId: l.projectId ? idFor(l.projectId) : null,
      description: l.description,
      quantity: String(l.quantity),
      unitPriceCents: l.unitPriceCents,
      amountCents: l.amountCents,
      isTaxed: l.isTaxed,
    }))
  );
  await insertInChunks(s.invoiceLineItems, lineRows);

  const projectLinks = mock.invoices.flatMap((i) =>
    [...new Set(i.projectIds)].map((p) => ({ invoiceId: idFor(i.id), projectId: idFor(p) }))
  );
  if (projectLinks.length) await insertInChunks(s.invoiceProjects, projectLinks);

  const payments = mock.invoices.flatMap((i) =>
    i.payments.map((p) => ({
      id: idFor(p.id),
      invoiceId: idFor(i.id),
      amountCents: p.amountCents,
      paidAt: new Date(p.paidAt),
      method: p.method ?? null,
      recordedBy: idFor(p.recordedBy),
    }))
  );
  if (payments.length) await insertInChunks(s.invoicePayments, payments);

  /* ------------------------------------------------- recurring and retainers */

  if (mock.recurringInvoices.length) {
    console.log(`→ ${mock.recurringInvoices.length} recurring schedules`);
    await db.insert(s.recurringInvoices).values(
      mock.recurringInvoices.map((r) => ({
        id: idFor(r.id),
        clientId: idFor(r.clientId),
        subject: r.subject,
        frequency: r.frequency,
        interval: r.intervalMonths,
        startsOn: r.nextIssueOn ?? new Date().toISOString().slice(0, 10),
        nextIssueOn: r.nextIssueOn ?? null,
        state: r.state,
        template: { amountCents: r.amountCents },
      }))
    );
  }

  if (mock.retainers.length) {
    console.log(`→ ${mock.retainers.length} retainers`);
    await db.insert(s.retainers).values(
      mock.retainers.map((r) => ({
        id: idFor(r.id),
        clientId: idFor(r.clientId),
        projectId: r.projectId ? idFor(r.projectId) : null,
        balanceCents: Math.max(0, r.balanceCents),
      }))
    );

    const transactions = mock.retainers.flatMap((r) => {
      let balance = 0;
      return r.transactions.map((t) => {
        balance += t.kind === "draw" ? -t.amountCents : t.amountCents;
        return {
          id: idFor(t.id),
          retainerId: idFor(r.id),
          kind: t.kind,
          amountCents: Math.max(1, Math.abs(t.amountCents)),
          balanceAfterCents: Math.max(0, balance),
          note: t.note ?? null,
          occurredAt: new Date(t.at),
        };
      });
    });
    if (transactions.length) await insertInChunks(s.retainerTransactions, transactions);
  }

  /* -------------------------------------------------------------------- done */

  const owner = mock.users.find((u) => u.isOwner) ?? mock.users[0]!;
  console.log("");
  console.log("✓ seeded");
  console.log("");
  console.log("  Sign in with any of the seeded accounts:");
  console.log(`    ${owner.email}  (administrator, account owner)`);
  console.log(`    password: ${DEV_PASSWORD}`);
  console.log("");
  console.log("  Every seeded person shares that password. It is a development");
  console.log("  convenience and must not survive contact with the droplet.");
}

/** Stored state, not display state. Late and partial are both `open`. */
function storedInvoiceState(display: string): string {
  switch (display) {
    case "draft":
      return "draft";
    case "paid":
      return "paid";
    case "written_off":
      return "written_off";
    default:
      return "open";
  }
}

/**
 * Postgres caps a statement at 65535 parameters. Nine thousand time entries at
 * twenty columns each is well past it, so inserts go in chunks.
 */
async function insertInChunks<T extends Record<string, unknown>>(
  table: Parameters<typeof db.insert>[0],
  rows: T[],
  size = 500
) {
  for (let i = 0; i < rows.length; i += size) {
    const chunk = rows.slice(i, i + size);
    if (chunk.length) await db.insert(table).values(chunk as never);
  }
}

main()
  .catch((e) => {
    console.error("\n✗ seed failed\n");
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
