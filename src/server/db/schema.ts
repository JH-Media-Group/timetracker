/**
 * Database schema.
 *
 * This is the DDL in docs/BACKEND_PRD.md section 3, expressed in Drizzle. The
 * PRD is the specification; where the two disagree the PRD wins and this file
 * is wrong.
 *
 * Conventions, applied without exception:
 *   - Primary keys are uuid v7, generated application-side (`newId()`), so they
 *     sort chronologically and index without page splits.
 *   - Money is `bigint` in cents. Column names end in `_cents`.
 *   - Durations are `integer` seconds. Column names end in `_seconds`.
 *   - `spent_on` is a `date`, held as a string end to end. Turning it into a
 *     Date would drag a calendar day through a timezone and move it.
 *   - Soft delete is `archived_at` for things users archive and `deleted_at`
 *     for things with an Undo window.
 *   - `external_ref` carries `{ harvest: { id } }` so a re-import is idempotent.
 *
 * Column names are written in camelCase and mapped to snake_case by Drizzle's
 * `casing` option, set once in the client.
 */

import { relations, sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  char,
  customType,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/* ============================================================ custom types */

/** Case-insensitive text. Emails compare and unique-index without `lower()`. */
const citext = customType<{ data: string; driverData: string }>({
  dataType: () => "citext",
});

const inet = customType<{ data: string; driverData: string }>({
  dataType: () => "inet",
});

/** Encrypted blobs. bytea rather than text, so a plaintext string cannot be
 *  written by accident and mistaken for ciphertext later. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

/**
 * Money: bigint cents in Postgres, a number in JavaScript.
 *
 * A double holds an exact integer up to 2^53, which is ninety trillion dollars,
 * so `number` is safe for every amount this business will ever see. The
 * conversions assert that rather than assuming it: a value beyond the safe
 * range throws instead of silently rounding somebody's invoice.
 */
const centsType = customType<{ data: number; driverData: string }>({
  dataType: () => "bigint",
  fromDriver: (value: string) => {
    const n = Number(value);
    if (!Number.isSafeInteger(n)) {
      throw new RangeError(`Money value ${value} exceeds the safe integer range and would lose cents.`);
    }
    return n;
  },
  toDriver: (value: number) => {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(`Money value ${value} is not a safe whole number of cents.`);
    }
    return String(value);
  },
});

/* -------------------------------------------------------------- shorthands */

const pk = () => uuid().primaryKey();
const ts = (name?: string) => (name ? timestamp(name, { withTimezone: true }) : timestamp({ withTimezone: true }));
const createdAt = () => ts().notNull().defaultNow();
const updatedAt = () => ts().notNull().defaultNow();
const cents = (name?: string) => (name ? centsType(name) : centsType());
const day = () => date({ mode: "string" });
const externalRef = () => jsonb().notNull().default({});

/* ==================================================== 3.1 identity, people */

export const permissionProfiles = pgTable("permission_profiles", {
  id: pk(),
  name: text().notNull().unique(),
  isBase: boolean().notNull().default(false),
  baseKey: text(),
  capabilities: text().array().notNull().default(sql`'{}'::text[]`),
  createdAt: createdAt(),
});

export const users = pgTable(
  "users",
  {
    id: pk(),
    email: citext().notNull().unique(),
    firstName: text().notNull(),
    lastName: text().notNull(),
    avatarKey: text(),
    employeeId: text(),
    timezone: text().notNull().default("America/New_York"),
    weeklyCapacitySeconds: integer().notNull().default(144000),
    employmentType: text().notNull().default("employee"),
    isOwner: boolean().notNull().default(false),
    profileId: uuid()
      .notNull()
      .references(() => permissionProfiles.id),
    autoAssignProjects: boolean().notNull().default(false),
    theme: text().notNull().default("system"),
    notificationPrefs: jsonb().notNull().default({}),
    /** argon2id. Null for accounts that only sign in through Google. */
    passwordHash: text(),
    startedOn: day(),
    endedOn: day(),
    archivedAt: ts(),
    lastSeenAt: ts(),
    externalRef: externalRef(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("users_archived_at_idx").on(t.archivedAt)]
);

export const roles = pgTable("roles", {
  id: pk(),
  name: text().notNull().unique(),
  archivedAt: ts(),
});

export const departments = pgTable("departments", {
  id: pk(),
  name: text().notNull().unique(),
  archivedAt: ts(),
});

export const userRoles = pgTable(
  "user_roles",
  {
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleId: uuid()
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.roleId] })]
);

export const userDepartments = pgTable(
  "user_departments",
  {
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    departmentId: uuid()
      .notNull()
      .references(() => departments.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.departmentId] })]
);

/** Who a manager can see and approve, when their profile is not account-wide. */
export const userManagedUsers = pgTable(
  "user_managed_users",
  {
    managerId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    managedId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.managerId, t.managedId] })]
);

/**
 * Rates are dated ranges, not single values. A rate change in March must not
 * silently rewrite what January cost. The overlap exclusion constraint is added
 * in the migration, because Drizzle has no builder for EXCLUDE USING gist.
 */
export const userRates = pgTable(
  "user_rates",
  {
    id: pk(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text().notNull(), // billable | cost
    amountCents: cents().notNull(),
    currency: char({ length: 3 }).notNull().default("USD"),
    startsOn: day(), // null = all prior
    endsOn: day(), // null = all future
    createdAt: createdAt(),
    createdBy: uuid().references(() => users.id),
  },
  (t) => [index("user_rates_lookup_idx").on(t.userId, t.kind, t.startsOn)]
);

/**
 * Invitations.
 *
 * Provisioning is by invite only: first sign-in matches an existing row by
 * email and never auto-creates, so a Google account inside the domain is not
 * by itself an account here. The token is single-use, hashed at rest, and
 * expires in seven days.
 */
export const userInvites = pgTable(
  "user_invites",
  {
    id: pk(),
    email: citext().notNull(),
    profileId: uuid()
      .notNull()
      .references(() => permissionProfiles.id),
    firstName: text(),
    lastName: text(),
    employmentType: text().notNull().default("employee"),
    tokenHash: text().notNull().unique(),
    invitedBy: uuid().references(() => users.id),
    expiresAt: ts().notNull(),
    acceptedAt: ts(),
    acceptedUserId: uuid().references(() => users.id),
    revokedAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [index("user_invites_email_idx").on(t.email)]
);

/** Auth.js-style database sessions, so revocation is immediate. */
export const sessions = pgTable(
  "sessions",
  {
    id: pk(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text().notNull().unique(),
    userAgent: text(),
    ip: inet(),
    lastSeenAt: ts().notNull().defaultNow(),
    expiresAt: ts().notNull(),
    absoluteExpiresAt: ts().notNull(),
    revokedAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)]
);

/* ================================================== 3.2 clients, projects */

export const clients = pgTable(
  "clients",
  {
    id: pk(),
    name: text().notNull(),
    address: text(),
    currency: char({ length: 3 }).notNull().default("USD"),
    paymentTerm: text().notNull().default("net_15"),
    paymentTermDays: integer(),
    taxPercent: numeric({ precision: 6, scale: 3 }),
    tax2Percent: numeric({ precision: 6, scale: 3 }),
    discountPercent: numeric({ precision: 6, scale: 3 }),
    invoicePrefix: text(),
    archivedAt: ts(),
    externalRef: externalRef(),
    createdAt: createdAt(),
    createdBy: uuid(),
    updatedAt: updatedAt(),
    updatedBy: uuid(),
  },
  (t) => [index("clients_archived_at_idx").on(t.archivedAt)]
);

export const clientContacts = pgTable(
  "client_contacts",
  {
    id: pk(),
    clientId: uuid()
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    firstName: text(),
    lastName: text(),
    title: text(),
    email: citext(),
    phoneOffice: text(),
    phoneMobile: text(),
    isPrimary: boolean().notNull().default(false),
    archivedAt: ts(),
    externalRef: externalRef(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("client_contacts_client_idx").on(t.clientId)]
);

export const projects = pgTable(
  "projects",
  {
    id: pk(),
    clientId: uuid()
      .notNull()
      .references(() => clients.id),
    name: text().notNull(),
    code: text(),
    billingType: text().notNull(), // time_and_materials | fixed_fee | non_billable
    billBy: text().notNull().default("none"), // project | tasks | people | none
    hourlyRateCents: cents(),
    feeCents: cents(),
    feeCadence: text(), // single | monthly
    budgetBy: text().notNull().default("none"),
    budgetSeconds: integer(),
    budgetFeeCents: cents(),
    budgetResetsMonthly: boolean().notNull().default(false),
    budgetAlertPercent: numeric({ precision: 5, scale: 2 }),
    currency: char({ length: 3 }),
    startsOn: day(),
    endsOn: day(),
    notes: text(),
    reportVisibility: text().notNull().default("managers"), // managers | everyone
    archivedAt: ts(),
    externalRef: externalRef(),
    createdAt: createdAt(),
    createdBy: uuid(),
    updatedAt: updatedAt(),
    updatedBy: uuid(),
  },
  (t) => [
    index("projects_client_idx").on(t.clientId),
    index("projects_archived_at_idx").on(t.archivedAt),
  ]
);

export const tags = pgTable("tags", {
  id: pk(),
  name: text().notNull().unique(),
  createdAt: createdAt(),
});

export const projectTags = pgTable(
  "project_tags",
  {
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    tagId: uuid()
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.tagId] })]
);

export const tasks = pgTable("tasks", {
  id: pk(),
  name: text().notNull(),
  defaultHourlyRateCents: cents(),
  isDefaultBillable: boolean().notNull().default(true),
  isCommon: boolean().notNull().default(false),
  archivedAt: ts(),
  externalRef: externalRef(),
  createdAt: createdAt(),
  createdBy: uuid(),
  updatedAt: updatedAt(),
  updatedBy: uuid(),
});

/** A task made available on a project. Time entries reference THIS, not tasks. */
export const projectTasks = pgTable(
  "project_tasks",
  {
    id: pk(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    taskId: uuid()
      .notNull()
      .references(() => tasks.id),
    isBillable: boolean().notNull().default(true),
    hourlyRateCents: cents(),
    budgetSeconds: integer(),
    budgetFeeCents: cents(),
    archivedAt: ts(),
    externalRef: externalRef(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("project_tasks_unique").on(t.projectId, t.taskId)]
);

export const projectMembers = pgTable(
  "project_members",
  {
    id: pk(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    isManager: boolean().notNull().default(false),
    hourlyRateCents: cents(),
    budgetSeconds: integer(),
    archivedAt: ts(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("project_members_unique").on(t.projectId, t.userId),
    // The live-membership lookup is partial on archived_at, so it lives in
    // drizzle/manual/0001_constraints.sql as project_members_live_idx.
  ]
);

/** Pinning is a per-user preference, not a project attribute. */
export const userPinnedProjects = pgTable(
  "user_pinned_projects",
  {
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    pinnedAt: ts().notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.projectId] })]
);

/* ================================================= 3.4 invoicing (early) */
// Declared before time_entries because both time_entries and expenses carry an
// invoice_id foreign key.

export const recurringInvoices = pgTable(
  "recurring_invoices",
  {
    id: pk(),
    clientId: uuid()
      .notNull()
      .references(() => clients.id),
    subject: text(),
    template: jsonb().notNull().default({}),
    frequency: text().notNull(), // weekly | monthly | quarterly | yearly
    interval: integer().notNull().default(1),
    dayOfMonth: integer(),
    dayOfWeek: integer(),
    startsOn: day().notNull(),
    endsOn: day(),
    occurrencesRemaining: integer(),
    nextIssueOn: day(),
    sendAutomatically: boolean().notNull().default(false),
    state: text().notNull().default("active"), // active | paused | completed
    lastIssuedOn: day(),
    externalRef: externalRef(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  // Partial on state = 'active'; see drizzle/manual/0001_constraints.sql.
  () => []
);

export const invoices = pgTable(
  "invoices",
  {
    id: pk(),
    clientId: uuid()
      .notNull()
      .references(() => clients.id),
    number: text().notNull(),
    subject: text(),
    notes: text(),
    poNumber: text(),
    currency: char({ length: 3 }).notNull().default("USD"),
    issueDate: day().notNull(),
    dueDate: day().notNull(),
    paymentTerm: text(),
    state: text().notNull().default("draft"), // draft | open | paid | written_off | closed
    subtotalCents: cents().notNull().default(0),
    discountPercent: numeric({ precision: 6, scale: 3 }),
    discountCents: cents().notNull().default(0),
    taxPercent: numeric({ precision: 6, scale: 3 }),
    taxCents: cents().notNull().default(0),
    tax2Percent: numeric({ precision: 6, scale: 3 }),
    tax2Cents: cents().notNull().default(0),
    totalCents: cents().notNull().default(0),
    paidCents: cents().notNull().default(0),
    showTotalHours: boolean().notNull().default(false),
    payToken: text().unique(),
    sentAt: ts(),

    /**
     * The highest overdue escalation step this invoice has been chased about.
     *
     * Counting the reminders already sent looks equivalent and is not. An
     * invoice discovered when it is already thirty days late has crossed three
     * steps at once, and a count-based rule sends one per run to catch up: with
     * the mail job on a five-minute cadence that is three emails to a client
     * inside a quarter of an hour. Recording the level instead means crossing
     * straight to the last step sends exactly one message, which is also the
     * only one worth sending. Nobody needs the "one day late" note when they
     * are a month past due.
     */
    reminderLevel: integer().notNull().default(0),
    paidAt: ts(),
    closedAt: ts(),
    recurringInvoiceId: uuid().references(() => recurringInvoices.id, { onDelete: "set null" }),
    retainerDrawCents: cents().notNull().default(0),
    externalRef: externalRef(),
    deletedAt: ts(),
    createdAt: createdAt(),
    createdBy: uuid().references(() => users.id),
    updatedAt: updatedAt(),
    updatedBy: uuid().references(() => users.id),
  },
  // Both hot invoice indexes exclude deleted rows, so they are partial and live
  // in drizzle/manual/0001_constraints.sql.
  () => []
);

/**
 * What kind of thing an invoice line is: a service, a product, a direct cost.
 *
 * `externalRef` matches the other imported entities. Without it the Harvest
 * import cannot recognise a type it created on an earlier run, which is what
 * makes the migration safe to repeat.
 */
export const invoiceItemTypes = pgTable("invoice_item_types", {
  id: pk(),
  name: text().notNull().unique(),
  isDefaultForExpenses: boolean().notNull().default(false),
  isDefaultForServices: boolean().notNull().default(false),
  qboIncomeAccountId: text(),
  externalRef: externalRef(),
  archivedAt: ts(),
});

export const invoiceLineItems = pgTable(
  "invoice_line_items",
  {
    id: pk(),
    invoiceId: uuid()
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    position: integer().notNull(),
    itemTypeId: uuid().references(() => invoiceItemTypes.id),
    projectId: uuid().references(() => projects.id),
    description: text().notNull(),
    quantity: numeric({ precision: 12, scale: 2 }).notNull().default("1"),
    unitPriceCents: cents().notNull().default(0),
    amountCents: cents().notNull().default(0),
    isTaxed: boolean().notNull().default(true),
    isTaxed2: boolean().notNull().default(false),
  },
  (t) => [index("invoice_line_items_invoice_idx").on(t.invoiceId, t.position)]
);

export const invoicePayments = pgTable(
  "invoice_payments",
  {
    id: pk(),
    invoiceId: uuid()
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    amountCents: cents().notNull(),
    paidAt: ts().notNull(),
    method: text(),
    reference: text(),
    notes: text(),
    gateway: text(),
    gatewayTxnId: text().unique(),
    voidedAt: ts(),
    voidedBy: uuid().references(() => users.id),
    recordedBy: uuid().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index("invoice_payments_invoice_idx").on(t.invoiceId)]
);

export const invoiceMessages = pgTable("invoice_messages", {
  id: pk(),
  invoiceId: uuid()
    .notNull()
    .references(() => invoices.id, { onDelete: "cascade" }),
  kind: text().notNull(), // invoice | reminder | thank_you
  subject: text(),
  body: text(),
  recipients: jsonb().notNull().default({}),
  attachedPdf: boolean().notNull().default(true),
  providerMessageId: text(),
  sentBy: uuid().references(() => users.id),
  sentAt: ts().notNull().defaultNow(),
  openedAt: ts(),
  /** Set when there is no SMTP transport configured, so the queue is honest. */
  deliveryState: text().notNull().default("queued"), // queued | sent | not_configured | failed
});

export const invoiceAttachments = pgTable("invoice_attachments", {
  id: pk(),
  invoiceId: uuid()
    .notNull()
    .references(() => invoices.id, { onDelete: "cascade" }),
  objectKey: text().notNull(),
  filename: text().notNull(),
  contentType: text(),
  bytes: integer(),
  uploadedBy: uuid().references(() => users.id),
  createdAt: createdAt(),
});

export const invoiceProjects = pgTable(
  "invoice_projects",
  {
    invoiceId: uuid()
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.invoiceId, t.projectId] })]
);

export const retainers = pgTable(
  "retainers",
  {
    id: pk(),
    clientId: uuid()
      .notNull()
      .references(() => clients.id),
    projectId: uuid().references(() => projects.id),
    balanceCents: cents().notNull().default(0),
    archivedAt: ts(),
    createdAt: createdAt(),
  },
  // UNIQUE over a nullable project_id needs NULLS NOT DISTINCT, or two
  // client-wide retainers can both exist. Created in the manual migration.
  () => []
);

export const retainerTransactions = pgTable("retainer_transactions", {
  id: pk(),
  retainerId: uuid()
    .notNull()
    .references(() => retainers.id, { onDelete: "cascade" }),
  kind: text().notNull(), // add | draw | adjust
  amountCents: cents().notNull(),
  balanceAfterCents: cents().notNull(),
  invoiceId: uuid().references(() => invoices.id, { onDelete: "set null" }),
  note: text(),
  occurredAt: ts().notNull().defaultNow(),
  createdBy: uuid().references(() => users.id),
});

/* ================================================ 3.3 time and expenses */

export const timesheetSubmissions = pgTable(
  "timesheet_submissions",
  {
    id: pk(),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    periodStart: day().notNull(),
    periodEnd: day().notNull(),
    state: text().notNull().default("submitted"), // submitted | approved | changes_requested
    submittedAt: ts().notNull().defaultNow(),
    reviewedBy: uuid().references(() => users.id),
    reviewedAt: ts(),
    reviewNote: text(),
    totalSeconds: integer().notNull().default(0),
    flags: jsonb().notNull().default([]),
    /** Set when an administrator writes into an already-approved period. */
    amendedAt: ts(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("timesheet_submissions_unique").on(t.userId, t.periodStart),
    index("timesheet_submissions_state_idx").on(t.state, t.periodStart),
  ]
);

export const timeEntries = pgTable(
  "time_entries",
  {
    id: pk(),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    projectId: uuid()
      .notNull()
      .references(() => projects.id),
    projectTaskId: uuid()
      .notNull()
      .references(() => projectTasks.id),
    spentOn: day().notNull(),
    startedAt: ts(),
    endedAt: ts(),
    timesAreInferred: boolean().notNull().default(false),
    durationSeconds: integer().notNull().default(0),
    timerStartedAt: ts(),
    notes: text(),
    isBillable: boolean().notNull(),
    // Rate snapshots, resolved at write time. Never recomputed except by an
    // explicit re-rate.
    billableRateCents: cents().notNull().default(0),
    costRateCents: cents().notNull().default(0),
    ratesLockedAt: ts(),
    billedExternally: boolean().notNull().default(false),
    invoiceId: uuid().references(() => invoices.id, { onDelete: "set null" }),
    approvalId: uuid().references(() => timesheetSubmissions.id, { onDelete: "set null" }),
    needsReview: boolean().notNull().default(false),
    source: text().notNull().default("web"),
    externalRef: externalRef(),
    deletedAt: ts(),
    createdAt: createdAt(),
    createdBy: uuid().references(() => users.id),
    updatedAt: updatedAt(),
    updatedBy: uuid().references(() => users.id),
  },
  // Every hot path on this table excludes soft-deleted rows, so those indexes
  // are partial and live in drizzle/manual/0001_constraints.sql.
  (t) => [index("time_entries_invoice_idx").on(t.invoiceId)]
);

export const expenseCategories = pgTable("expense_categories", {
  id: pk(),
  name: text().notNull(),
  unitName: text(),
  unitPriceCents: cents(),
  archivedAt: ts(),
  externalRef: externalRef(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const expenses = pgTable(
  "expenses",
  {
    id: pk(),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    projectId: uuid()
      .notNull()
      .references(() => projects.id),
    categoryId: uuid()
      .notNull()
      .references(() => expenseCategories.id),
    spentOn: day().notNull(),
    units: numeric({ precision: 12, scale: 2 }),
    totalCents: cents().notNull(),
    notes: text(),
    isBillable: boolean().notNull().default(true),
    isReimbursable: boolean().notNull().default(false),
    reimbursementState: text(), // pending | approved | paid
    reimbursedAt: ts(),
    receiptKey: text(),
    receiptFilename: text(),
    receiptContentType: text(),
    receiptBytes: integer(),
    billedExternally: boolean().notNull().default(false),
    invoiceId: uuid().references(() => invoices.id, { onDelete: "set null" }),
    approvalId: uuid().references(() => timesheetSubmissions.id, { onDelete: "set null" }),
    ratesLockedAt: ts(),
    externalRef: externalRef(),
    deletedAt: ts(),
    createdAt: createdAt(),
    createdBy: uuid().references(() => users.id),
    updatedAt: updatedAt(),
    updatedBy: uuid().references(() => users.id),
  },
  // Partial on deleted_at; see drizzle/manual/0001_constraints.sql.
  (t) => [index("expenses_invoice_idx").on(t.invoiceId)]
);

/* ================================================= 3.5 platform tables */

export const settings = pgTable("settings", {
  id: smallint().primaryKey().default(1),
  companyName: text().notNull(),
  companyAddress: text(),
  logoKey: text(),
  taxId: text(),
  baseCurrency: char({ length: 3 }).notNull().default("USD"),
  timezone: text().notNull().default("America/New_York"),
  weekStartsOn: smallint().notNull().default(1),
  fiscalYearStartMonth: smallint().notNull().default(1),
  timerMode: text().notNull().default("start_end"),
  timeDisplay: text().notNull().default("decimal"),
  roundingMinutes: smallint().notNull().default(0),
  roundingMode: text().notNull().default("nearest"),
  requireNotes: text().notNull().default("never"),
  allowFutureDates: boolean().notNull().default(true),
  flagMissingBelowSeconds: integer(),
  lockTimesheetsAfterDays: integer(),
  projectNotesVisibility: text().notNull().default("managers"),
  modules: jsonb().notNull().default({}),
  invoiceDefaults: jsonb().notNull().default({}),
  invoiceAppearance: jsonb().notNull().default({}),
  invoiceMessages: jsonb().notNull().default({}),
  invoiceFieldLabels: jsonb().notNull().default({}),
  invoiceNumberPattern: text().notNull().default("{seq:5}"),
  invoiceNextSeq: integer().notNull().default(1),
  updatedAt: updatedAt(),
  updatedBy: uuid().references(() => users.id),
});

export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    actorId: uuid().references(() => users.id),
    actorKind: text().notNull().default("user"),
    action: text().notNull(),
    entityType: text().notNull(),
    entityId: uuid(),
    entityLabel: text(),
    before: jsonb(),
    after: jsonb(),
    diffKeys: text().array(),
    requestId: text(),
    ip: inet(),
    userAgent: text(),
    createdAt: createdAt(),
  },
  (t) => [
    index("audit_log_created_idx").on(t.createdAt),
    index("audit_log_entity_idx").on(t.entityType, t.entityId, t.createdAt),
    index("audit_log_actor_idx").on(t.actorId, t.createdAt),
  ]
);

export const outbox = pgTable(
  "outbox",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    topic: text().notNull(),
    payload: jsonb().notNull(),
    createdAt: createdAt(),
    publishedAt: ts(),
  },
  // The pending-work index is partial; see drizzle/manual/0001_constraints.sql.
  () => []
);

export const idempotencyKeys = pgTable("idempotency_keys", {
  key: text().primaryKey(),
  actorId: uuid().references(() => users.id),
  route: text().notNull(),
  requestHash: text().notNull(),
  responseStatus: smallint(),
  responseBody: jsonb(),
  createdAt: createdAt(),
});

export const apiTokens = pgTable("api_tokens", {
  id: pk(),
  userId: uuid()
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  label: text().notNull(),
  tokenHash: text().notNull().unique(),
  prefix: text().notNull(),
  scopes: text().array().notNull().default(sql`'{}'::text[]`),
  lastUsedAt: ts(),
  expiresAt: ts(),
  revokedAt: ts(),
  createdAt: createdAt(),
});

export const integrationConnections = pgTable(
  "integration_connections",
  {
    id: pk(),
    provider: text().notNull(),
    scope: text().notNull().default("account"),
    userId: uuid().references(() => users.id, { onDelete: "cascade" }),
    externalAccountId: text(),
    accessTokenEnc: bytea(),
    refreshTokenEnc: bytea(),
    expiresAt: ts(),
    grantedScopes: text().array(),
    config: jsonb().notNull().default({}),
    status: text().notNull().default("connected"),
    lastError: text(),
    lastSyncedAt: ts(),
    createdAt: createdAt(),
  },
  // Same nullable-column problem as retainers; created in the manual migration
  // with NULLS NOT DISTINCT.
  () => []
);

export const savedReports = pgTable("saved_reports", {
  id: pk(),
  ownerId: uuid()
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text().notNull(),
  kind: text().notNull(),
  config: jsonb().notNull(),
  visibility: text().notNull().default("private"),
  schedule: jsonb(),
  lastRunAt: ts(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const bulkActionRuns = pgTable("bulk_action_runs", {
  id: pk(),
  actorId: uuid()
    .notNull()
    .references(() => users.id),
  actionKey: text().notNull(),
  params: jsonb().notNull(),
  targetCount: integer().notNull(),
  succeeded: integer().notNull().default(0),
  skipped: integer().notNull().default(0),
  failed: integer().notNull().default(0),
  results: jsonb().notNull().default([]),
  state: text().notNull().default("running"),
  revertPayload: jsonb(),
  createdAt: createdAt(),
  completedAt: ts(),
});

export const importRuns = pgTable("import_runs", {
  id: pk(),
  actorId: uuid()
    .notNull()
    .references(() => users.id),
  kind: text().notNull(),
  filename: text(),
  objectKey: text(),
  mapping: jsonb(),
  rowCount: integer(),
  inserted: integer(),
  skipped: integer(),
  failed: integer(),
  errors: jsonb().notNull().default([]),
  state: text().notNull().default("pending"),
  createdIds: uuid().array(),
  revertedAt: ts(),
  createdAt: createdAt(),
});

/**
 * Every email the app intends to send, and what became of it (TALLY-49).
 *
 * One table for all outbound mail, whatever produced it, because the questions
 * worth asking are "did it go" and "what failed", and they should have one
 * place to look rather than one per feature.
 *
 * The state machine is deliberately small:
 *
 *   queued   -> sending -> sent
 *                       -> queued  (a transient failure, with backoff)
 *                       -> failed  (attempts exhausted, or a permanent refusal)
 *   not_configured                 (no SMTP transport; nothing was attempted)
 *
 * `not_configured` exists so the record is honest on an instance with no key,
 * rather than a `queued` row that will never move. It is the same distinction
 * `invoice_messages.delivery_state` already draws, and the reason a send does
 * not silently report success.
 *
 * `body_text` is stored rather than re-rendered on read. An invoice email is
 * close enough to a legal document that what was sent has to stay what was
 * sent, even after somebody edits the template it came from.
 */
export const outboundMessages = pgTable(
  "outbound_messages",
  {
    id: pk(),
    /** invite | password_reset | invoice | reminder | thank_you | notification */
    kind: text().notNull(),
    toAddress: text().notNull(),
    ccAddresses: jsonb().notNull().default([]),
    subject: text().notNull(),
    bodyText: text().notNull(),

    state: text().notNull().default("queued"),
    attempts: integer().notNull().default(0),
    lastError: text(),
    /** Never claimed before this. Carries the backoff between attempts. */
    nextAttemptAt: ts().notNull().defaultNow(),
    sentAt: ts(),
    providerMessageId: text(),

    /** What this is about, for a timeline and for support questions. */
    relatedType: text(),
    relatedId: uuid(),
    /** Who it is for, when it is somebody in this account. */
    userId: uuid().references(() => users.id, { onDelete: "set null" }),

    createdAt: createdAt(),
  },
  (t) => [
    // The drain's claim query: due, unsent, oldest first.
    index("outbound_messages_claim_idx").on(t.state, t.nextAttemptAt),
    index("outbound_messages_related_idx").on(t.relatedType, t.relatedId),
  ]
);

/**
 * A single-use token that proves somebody can read an inbox (TALLY-48).
 *
 * Serves both the invite and the password reset, distinguished by `purpose`,
 * because they are the same mechanism with different copy and different
 * expiries: an invite can reasonably sit for a week, a reset should not.
 *
 * **The token is stored hashed.** A token in a database is a credential: anyone
 * who can read this table could otherwise set any password in the account, and
 * a backup of it would be a permanent skeleton key. Only the digest is kept, so
 * a stolen copy is worthless.
 */
export const authTokens = pgTable(
  "auth_tokens",
  {
    id: pk(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** invite | password_reset */
    purpose: text().notNull(),
    /** sha256 of the token that was emailed. The token itself is never stored. */
    tokenHash: text().notNull().unique(),
    expiresAt: ts().notNull(),
    usedAt: ts(),
    createdBy: uuid().references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("auth_tokens_user_idx").on(t.userId, t.purpose)]
);

export const notifications = pgTable(
  "notifications",
  {
    id: pk(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text().notNull(),
    title: text().notNull(),
    body: text(),
    entityType: text(),
    entityId: uuid(),
    url: text(),
    readAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [index("notifications_user_created_idx").on(t.userId, t.createdAt)]
);

/** Async export jobs. The row is the job; the worker fills in the object key. */
export const exportRuns = pgTable("export_runs", {
  id: pk(),
  actorId: uuid()
    .notNull()
    .references(() => users.id),
  kind: text().notNull(),
  format: text().notNull().default("csv"),
  filters: jsonb().notNull().default({}),
  state: text().notNull().default("queued"), // queued | running | done | failed
  rowCount: integer(),
  objectKey: text(),
  downloadName: text(),
  content: text(),
  error: text(),
  createdAt: createdAt(),
  completedAt: ts(),
});

/* ==================================================== relations (queries) */

export const usersRelations = relations(users, ({ one, many }) => ({
  profile: one(permissionProfiles, { fields: [users.profileId], references: [permissionProfiles.id] }),
  rates: many(userRates),
  roles: many(userRoles),
  departments: many(userDepartments),
}));

export const clientsRelations = relations(clients, ({ many }) => ({
  contacts: many(clientContacts),
  projects: many(projects),
}));

export const projectsRelations = relations(projects, ({ one, many }) => ({
  client: one(clients, { fields: [projects.clientId], references: [clients.id] }),
  tasks: many(projectTasks),
  members: many(projectMembers),
}));

export const projectTasksRelations = relations(projectTasks, ({ one }) => ({
  project: one(projects, { fields: [projectTasks.projectId], references: [projects.id] }),
  task: one(tasks, { fields: [projectTasks.taskId], references: [tasks.id] }),
}));

export const timeEntriesRelations = relations(timeEntries, ({ one }) => ({
  user: one(users, { fields: [timeEntries.userId], references: [users.id] }),
  project: one(projects, { fields: [timeEntries.projectId], references: [projects.id] }),
  projectTask: one(projectTasks, { fields: [timeEntries.projectTaskId], references: [projectTasks.id] }),
  invoice: one(invoices, { fields: [timeEntries.invoiceId], references: [invoices.id] }),
}));

export const invoicesRelations = relations(invoices, ({ one, many }) => ({
  client: one(clients, { fields: [invoices.clientId], references: [clients.id] }),
  lineItems: many(invoiceLineItems),
  payments: many(invoicePayments),
  messages: many(invoiceMessages),
}));

/* ------------------------------------------------------------- row types */

export type UserRow = typeof users.$inferSelect;
export type ClientRow = typeof clients.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type ProjectTaskRow = typeof projectTasks.$inferSelect;
export type TimeEntryRow = typeof timeEntries.$inferSelect;
export type ExpenseRow = typeof expenses.$inferSelect;
export type InvoiceRow = typeof invoices.$inferSelect;
export type SettingsRow = typeof settings.$inferSelect;
export type SubmissionRow = typeof timesheetSubmissions.$inferSelect;
export type InviteRow = typeof userInvites.$inferSelect;
