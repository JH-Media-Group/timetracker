/**
 * The API client.
 *
 * One module stands between the components and `/api/v1`. Every function here
 * returns the domain types in `./types`, so nothing above this file knows the
 * shape of a wire payload, and the whole front end was built and tested against
 * an in-memory version of exactly these signatures.
 *
 * Three jobs, and only these three:
 *
 *   1. Speak HTTP. One `request()` unwraps the `{ data, meta }` envelope, turns
 *      an `application/problem+json` body into an `ApiError` carrying its code
 *      and field errors, and sends an unauthenticated caller to sign in.
 *   2. Adapt. The server is deliberately explicit where the client is
 *      convenient: it sends `null` where the UI wants `undefined`, an
 *      `avatarKey` where the UI wants a `photo` src, and a `profileId` where a
 *      badge wants the word "Accounting". The `from*` functions below are the
 *      only place those two vocabularies meet.
 *   3. Keep the signature. Each function looks the same as it did against the
 *      mock, because a component that has to know whether its data came from
 *      memory or from Postgres is a component that will be rewritten twice.
 *
 * What is NOT here: business logic. If something looks like a rule (which hours
 * can be billed, what an invoice total is), it belongs on the server, and if it
 * appears to be missing, it is because the server already did it.
 */

"use client";

import type {
  Client, Expense, ExpenseCategory, Invoice, InvoiceLineItem, InvoicePayment, InvoiceEvent,
  Project, Settings, Task, TimeEntry, TimesheetSubmission, User, ID, InvoiceState,
  PermissionProfile, RecurringInvoice, RecurringInvoiceLine, Retainer, BillingType, BillBy, BudgetBy,
  UninvoicedClient,
} from "./types";
import type {
  FieldLabels, InvoiceAppearance, InvoiceDefaults,
} from "@/domain/invoice-config";
import { startOfWeek } from "./format";

const BASE = "/api/v1";

/* =================================================================== errors */

/**
 * A failed request, with the parts a form needs.
 *
 * `code` is the server's stable identifier (`record_locked`, `period_approved`,
 * `timer_already_running`), which is what callers should branch on. `fields`
 * maps a field name to its messages, so a validation failure can be shown
 * against the input that caused it instead of as a banner.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields?: Record<string, string[]>;
  readonly requestId?: string;
  readonly meta?: Record<string, unknown>;

  constructor(init: {
    status: number; code: string; message: string;
    fields?: Record<string, string[]>; requestId?: string; meta?: Record<string, unknown>;
  }) {
    super(init.message);
    this.name = "ApiError";
    this.status = init.status;
    this.code = init.code;
    this.fields = init.fields;
    this.requestId = init.requestId;
    this.meta = init.meta;
  }

  /** The first message for a field, for inline form errors. */
  fieldError(name: string): string | undefined {
    return this.fields?.[name]?.[0];
  }
}

/** True when the failure is the server refusing, not the network falling over. */
export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError;

/* ================================================================ transport */

type Query = Record<string, string | number | boolean | null | undefined>;

function withQuery(path: string, query?: Query): string {
  if (!query) return BASE + path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return BASE + path + (qs ? `?${qs}` : "");
}

/**
 * Sends the browser to sign in, once.
 *
 * A page can have a dozen queries in flight when a session expires, and without
 * the latch each of their 401s would push another history entry. The `next`
 * parameter is the current path so the person lands back where they were.
 */
let redirecting = false;
function toSignIn() {
  if (typeof window === "undefined" || redirecting) return;
  if (window.location.pathname.startsWith("/signin")) return;
  redirecting = true;
  const next = window.location.pathname + window.location.search;

  // Drop the cookie before leaving.
  //
  // The middleware treats the cookie's presence as being signed in and bounces
  // /signin to /timesheet. With an expired or revoked session that is a loop:
  // the page loads, bootstrap 401s, we come back here, the middleware sends us
  // to /timesheet again. Clearing it server-side breaks the cycle, and the
  // cookie is httpOnly so this is the only way to clear it.
  void fetch(`${BASE}/auth/signout`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  })
    .catch(() => {})
    .finally(() => {
      window.location.href = `/signin?next=${encodeURIComponent(next)}`;
    });
}

async function request<T>(
  method: string,
  path: string,
  options: { query?: Query; body?: unknown; idempotencyKey?: string } = {}
): Promise<{ data: T; meta?: Record<string, unknown> }> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;

  let response: Response;
  try {
    response = await fetch(withQuery(path, options.query), {
      method,
      headers,
      credentials: "same-origin",
      cache: "no-store",
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch (cause) {
    // A dropped connection is not a server error and must not be reported as
    // one: "something went wrong" sends someone to check the logs for a request
    // that never arrived.
    throw new ApiError({
      status: 0,
      code: "network_error",
      message: "Could not reach the server. Check your connection and try again.",
      meta: { cause: String(cause) },
    });
  }

  if (response.status === 401) {
    toSignIn();
    throw new ApiError({ status: 401, code: "unauthenticated", message: "Your session has ended. Sign in again." });
  }

  if (response.status === 204) return { data: null as T };

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try { payload = JSON.parse(text); } catch { /* handled below */ }
  }

  if (!response.ok) {
    const problem = (payload ?? {}) as {
      detail?: string; title?: string; code?: string;
      errors?: Record<string, string[]>; request_id?: string; meta?: Record<string, unknown>;
    };
    throw new ApiError({
      status: response.status,
      code: problem.code ?? "internal_error",
      message: problem.detail ?? problem.title ?? `Request failed (${response.status}).`,
      fields: problem.errors,
      requestId: problem.request_id,
      meta: problem.meta,
    });
  }

  const envelope = (payload ?? {}) as { data: T; meta?: Record<string, unknown> };
  return { data: envelope.data, meta: envelope.meta };
}

const get = async <T,>(path: string, query?: Query): Promise<T> => (await request<T>("GET", path, { query })).data;
const post = async <T,>(path: string, body?: unknown, idempotencyKey?: string): Promise<T> =>
  (await request<T>("POST", path, { body, idempotencyKey })).data;
const patch = async <T,>(path: string, body: unknown): Promise<T> => (await request<T>("PATCH", path, { body })).data;
const patch_ = patch;
const put = async <T,>(path: string, body: unknown): Promise<T> => (await request<T>("PUT", path, { body })).data;
const del = async <T,>(path: string): Promise<T> => (await request<T>("DELETE", path)).data;

/**
 * A key derived from the operation, so a retry carries the same one.
 *
 * A fresh UUID per call makes the whole mechanism inert: the server stores the
 * claim, matches nothing against it, and a double click on "Record payment"
 * produces two payments. The key has to be a function of what is being asked
 * for, which is what makes asking twice the same request.
 *
 * FNV-1a because it needs to be synchronous, stable across reloads, and only
 * has to distinguish one payload from another, not resist anybody.
 */
function idempotencyKey(operation: string, payload: unknown): string {
  const text = `${operation}:${JSON.stringify(payload)}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${operation}-${hash.toString(16).padStart(8, "0")}-${text.length.toString(16)}`;
}

/* ================================================================= adapters */

/** `null` on the wire, `undefined` in the UI. An optional field is absent. */
const opt = <T,>(v: T | null | undefined): T | undefined => (v == null ? undefined : v);

/**
 * A stable colour for a project.
 *
 * The palette index is presentation, so it is not a column; it is derived from
 * the id, which means the same project keeps the same colour in every session
 * and on every device without anybody storing a choice nobody made.
 */
function colorIndexFor(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return (hash % 12) + 1;
}

interface UserWire {
  id: string; email: string; firstName: string; lastName: string;
  avatarKey: string | null; employmentType: string; isOwner: boolean;
  profileId: string; timezone: string; weeklyCapacitySeconds: number;
  startedOn: string | null; archivedAt: string | null;
  roles: string[]; departments: string[];
  billableRateCents?: number; costRateCents?: number;
}

/**
 * Profile id to base key.
 *
 * Populated from the bootstrap payload. A custom profile derived from
 * "Project manager" reports the base it was cloned from, because the badge is
 * telling you roughly what someone can do, not which row of a table they are.
 */
let profileKeyById = new Map<string, PermissionProfile>();

/**
 * The other direction, for writing.
 *
 * The UI speaks in profile keys ("people_admin") because that is what a badge
 * shows and what a permission means. The API speaks in profile ids, because a
 * custom profile has an id and no key. Both translations belong here, in the
 * one file that knows the wire vocabulary, so no component ever holds an id.
 */
let profileIdByKey = new Map<PermissionProfile, string>();

/** Every profile the account has, in the order the roster should offer them. */
let profileList: { id: string; name: string; key: PermissionProfile }[] = [];

export function permissionProfiles(): readonly { id: string; name: string; key: PermissionProfile }[] {
  return profileList;
}

function fromUser(u: UserWire): User {
  return {
    id: u.id,
    firstName: u.firstName,
    lastName: u.lastName,
    email: u.email,
    photo: opt(u.avatarKey),
    employmentType: u.employmentType === "contractor" ? "contractor" : "employee",
    profile: profileKeyById.get(u.profileId) ?? "member",
    isOwner: u.isOwner,
    roles: u.roles ?? [],
    departments: u.departments ?? [],
    weeklyCapacitySeconds: u.weeklyCapacitySeconds,
    timezone: u.timezone,
    // Absent means "you may not see this", which is not the same as zero, so
    // the field stays absent. Collapsing it to a number here presents a
    // redaction as an accounting figure, which is the failure this comment was
    // written to prevent and then did not.
    billableRateCents: u.billableRateCents,
    costRateCents: u.costRateCents,
    archivedAt: opt(u.archivedAt),
    startedOn: opt(u.startedOn),
  };
}

interface ClientWire {
  id: string; name: string; address: string | null; currency: string;
  paymentTerm: string; paymentTermDays: number | null;
  taxPercent: number | null; discountPercent: number | null;
  invoicePrefix: string | null; archivedAt: string | null;
  contacts: {
    id: string; clientId: string; firstName: string | null; lastName: string | null;
    title: string | null; email: string | null; phone: string | null; isPrimary: boolean;
  }[];
}

function fromClient(c: ClientWire): Client {
  return {
    id: c.id,
    name: c.name,
    address: opt(c.address),
    currency: c.currency,
    // Carried through rather than coerced. Rewriting a custom term as net 30
            // moves the due date on every invoice that client is ever sent.
    paymentTerm: c.paymentTerm as Client["paymentTerm"],
    paymentTermDays: opt(c.paymentTermDays),
    taxPercent: opt(c.taxPercent),
    discountPercent: opt(c.discountPercent),
    archivedAt: opt(c.archivedAt),
    contacts: (c.contacts ?? []).map((k) => ({
      id: k.id,
      clientId: k.clientId,
      firstName: k.firstName ?? "",
      lastName: k.lastName ?? "",
      title: opt(k.title),
      email: opt(k.email),
      phone: opt(k.phone),
      isPrimary: k.isPrimary,
    })),
  };
}

interface ProjectWire {
  id: string; clientId: string; name: string; code: string | null;
  billingType: string; billBy: string; budgetBy: string;
  budgetSeconds: number | null; budgetResetsMonthly: boolean; budgetAlertPercent: number | null;
  startsOn: string | null; endsOn: string | null; notes: string | null;
  reportVisibility: string; archivedAt: string | null;
  tags: string[]; taskIds: string[]; memberIds: string[]; managerIds: string[];
  hourlyRateCents?: number; feeCents?: number; feeCadence?: string | null; budgetFeeCents?: number | null;
}

function fromProject(p: ProjectWire): Project {
  return {
    id: p.id,
    clientId: p.clientId,
    name: p.name,
    code: opt(p.code),
    billingType: p.billingType as BillingType,
    billBy: p.billBy as BillBy,
    hourlyRateCents: opt(p.hourlyRateCents),
    feeCents: opt(p.feeCents),
    feeCadence: opt(p.feeCadence) as Project["feeCadence"],
    budgetBy: p.budgetBy as BudgetBy,
    budgetSeconds: opt(p.budgetSeconds),
    budgetFeeCents: opt(p.budgetFeeCents),
    budgetResetsMonthly: p.budgetResetsMonthly,
    budgetAlertPercent: opt(p.budgetAlertPercent),
    notes: opt(p.notes),
    tags: p.tags ?? [],
    startsOn: opt(p.startsOn),
    endsOn: opt(p.endsOn),
    colorIndex: colorIndexFor(p.id),
    archivedAt: opt(p.archivedAt),
    taskIds: p.taskIds ?? [],
    memberIds: p.memberIds ?? [],
    managerIds: p.managerIds ?? [],
  };
}

interface TaskWire {
  id: string; name: string; defaultBillable: boolean; isCommon: boolean;
  defaultHourlyRateCents?: number | null; archivedAt?: string | null;
}

const fromTask = (t: TaskWire): Task => ({
  id: t.id,
  name: t.name,
  defaultBillable: t.defaultBillable,
  isCommon: t.isCommon,
  defaultRateCents: opt(t.defaultHourlyRateCents),
  archivedAt: opt(t.archivedAt),
});

interface TimeEntryWire {
  id: string; userId: string; projectId: string; projectTaskId: string; taskId: string | null;
  spentOn: string; startedAt: string | null; endedAt: string | null;
  durationSeconds: number; timerStartedAt: string | null; notes: string | null;
  isBillable: boolean; invoiceId: string | null; approvalId: string | null;
  billedExternally: boolean; needsReview: boolean;
  locked: boolean; lockReasons: string[];
  billableRateCents?: number; costRateCents?: number;
}

/** The wire entry plus the two fields the grid reads but the mock never had. */
export interface TimeEntryView extends TimeEntry {
  locked: boolean;
  lockReasons: string[];
  needsReview: boolean;
}

function fromTimeEntry(e: TimeEntryWire): TimeEntryView {
  return {
    id: e.id,
    userId: e.userId,
    projectId: e.projectId,
    taskId: e.taskId ?? e.projectTaskId,
    spentOn: e.spentOn,
    startedAt: opt(e.startedAt),
    endedAt: opt(e.endedAt),
    durationSeconds: e.durationSeconds,
    timerStartedAt: opt(e.timerStartedAt),
    notes: opt(e.notes),
    isBillable: e.isBillable,
    billableRateCents: e.billableRateCents,
    costRateCents: e.costRateCents,
    invoiceId: opt(e.invoiceId),
    billedExternally: e.billedExternally,
    approvalId: opt(e.approvalId),
    locked: e.locked,
    lockReasons: e.lockReasons ?? [],
    needsReview: e.needsReview,
  };
}

interface ExpenseWire {
  id: string; userId: string; projectId: string; categoryId: string; spentOn: string;
  units: number | null; totalCents: number; notes: string | null;
  isBillable: boolean; isReimbursable: boolean; reimbursementState: string | null;
  reimbursedAt: string | null; receiptFilename: string | null; invoiceId: string | null;
  billedExternally: boolean; locked: boolean; lockReasons: string[];
}

export interface ExpenseView extends Expense {
  locked: boolean;
  lockReasons: string[];
}

const fromExpense = (x: ExpenseWire): ExpenseView => ({
  id: x.id,
  userId: x.userId,
  projectId: x.projectId,
  categoryId: x.categoryId,
  spentOn: x.spentOn,
  units: opt(x.units),
  totalCents: x.totalCents,
  notes: opt(x.notes),
  isBillable: x.isBillable,
  isReimbursable: x.isReimbursable,
  reimbursementState: opt(x.reimbursementState) as Expense["reimbursementState"],
  receiptName: opt(x.receiptFilename),
  invoiceId: opt(x.invoiceId),
  locked: x.locked,
  lockReasons: x.lockReasons ?? [],
});

interface CategoryWire {
  id: string; name: string; unitName: string | null; unitPriceCents: number | null; archivedAt: string | null;
}

const fromCategory = (c: CategoryWire): ExpenseCategory => ({
  id: c.id,
  name: c.name,
  unitName: opt(c.unitName),
  unitPriceCents: opt(c.unitPriceCents),
  archivedAt: opt(c.archivedAt),
});

interface SubmissionWire {
  id: string; userId: string; periodStart: string; periodEnd: string; state: string;
  submittedAt: string | null; reviewedBy: string | null; reviewedAt: string | null;
  reviewNote: string | null; totalSeconds: number; flags: string[]; amended: boolean;
}

export interface SubmissionView extends TimesheetSubmission {
  amended: boolean;
}

const fromSubmission = (s: SubmissionWire): SubmissionView => ({
  id: s.id,
  userId: s.userId,
  periodStart: s.periodStart,
  periodEnd: s.periodEnd,
  state: s.state as TimesheetSubmission["state"],
  submittedAt: opt(s.submittedAt),
  reviewedBy: opt(s.reviewedBy),
  reviewedAt: opt(s.reviewedAt),
  reviewNote: opt(s.reviewNote),
  totalSeconds: s.totalSeconds,
  flags: s.flags ?? [],
  amended: s.amended,
});

interface InvoiceWire {
  id: string; clientId: string; number: string; subject: string | null; notes: string | null;
  poNumber: string | null; currency: string; issueDate: string; dueDate: string;
  state: string; displayState: string;
  subtotalCents: number; discountPercent: number | null; discountCents: number;
  taxPercent: number | null; taxCents: number; totalCents: number;
  paidCents: number; balanceCents: number; retainerDrawCents: number;
  sentAt: string | null; paidAt: string | null; projectIds: string[];
  lineItems?: {
    id: string; position: number; projectId: string | null; description: string;
    quantity: number; unitPriceCents: number; amountCents: number; isTaxed: boolean;
    itemType: string | null; isTime: boolean;
  }[];
  payments?: {
    id: string; amountCents: number; paidAt: string; method: string | null;
    reference: string | null; voidedAt: string | null;
  }[];
  events?: { id: string; kind: string; label: string; actorId: string | null; at: string; amountCents: number | null }[];
}

export interface InvoiceView extends Invoice {
  /** The state as a person reads it: a sent invoice past its due date is late. */
  displayState: InvoiceState;
  balanceCents: number;
  retainerDrawCents: number;
}

function fromInvoice(i: InvoiceWire): InvoiceView {
  const lineItems: InvoiceLineItem[] = (i.lineItems ?? []).map((l) => ({
    id: l.id,
    invoiceId: i.id,
    position: l.position,
    // The real column, not a guess. This used to read `isTaxed ? "Service" :
    // "Expense"`, which was a placeholder from before item types were connected
    // and told you whether a line was taxed, not what it was.
    itemType: l.itemType ?? "",
    isTime: l.isTime ?? false,
    projectId: opt(l.projectId),
    description: l.description,
    quantity: l.quantity,
    unitPriceCents: l.unitPriceCents,
    amountCents: l.amountCents,
    isTaxed: l.isTaxed,
  }));

  // A voided payment is kept on the ledger but must not be counted as money in
  // the door, so it never reaches the payments list the UI totals.
  const payments: InvoicePayment[] = (i.payments ?? [])
    .filter((p) => !p.voidedAt)
    .map((p) => ({
      id: p.id,
      invoiceId: i.id,
      amountCents: p.amountCents,
      paidAt: p.paidAt,
      method: opt(p.method),
      reference: opt(p.reference),
      recordedBy: "",
    }));

  const events: InvoiceEvent[] = (i.events ?? []).map((e) => ({
    id: e.id,
    invoiceId: i.id,
    kind: e.kind,
    label: e.label,
    actorId: opt(e.actorId),
    at: e.at,
    amountCents: opt(e.amountCents),
  }));

  return {
    id: i.id,
    clientId: i.clientId,
    number: i.number,
    subject: opt(i.subject),
    notes: opt(i.notes),
    poNumber: opt(i.poNumber),
    currency: i.currency,
    issueDate: i.issueDate,
    dueDate: i.dueDate,
    state: i.displayState as InvoiceState,
    displayState: i.displayState as InvoiceState,
    subtotalCents: i.subtotalCents,
    taxPercent: opt(i.taxPercent),
    taxCents: i.taxCents,
    discountPercent: opt(i.discountPercent),
    discountCents: i.discountCents,
    totalCents: i.totalCents,
    paidCents: i.paidCents,
    balanceCents: i.balanceCents,
    retainerDrawCents: i.retainerDrawCents,
    sentAt: opt(i.sentAt),
    paidAt: opt(i.paidAt),
    projectIds: i.projectIds ?? [],
    lineItems,
    payments,
    events,
  };
}

interface SettingsWire {
  companyName: string; companyAddress: string | null; taxId: string | null; baseCurrency: string; timezone: string;
  weekStartsOn: number; fiscalYearStartMonth: number; timerMode: string; timeDisplay: string;
  roundingMinutes: number; roundingMode: string; requireNotes: string; allowFutureDates: boolean;
  flagMissingBelowSeconds: number | null; lockTimesheetsAfterDays: number | null;
  projectNotesVisibility: string; modules: Record<string, boolean>; invoiceNumberPattern: string;
  invoiceLabels: FieldLabels; invoiceAppearance: InvoiceAppearance; invoiceDefaults: InvoiceDefaults;
}

const fromSettings = (s: SettingsWire): Settings => ({
  // Already resolved by the server. Re-resolving here would be a second place
  // for the defaults to live, which is what `invoice-config.ts` exists to avoid.
  invoiceLabels: s.invoiceLabels,
  invoiceAppearance: s.invoiceAppearance,
  invoiceDefaults: s.invoiceDefaults,
  companyName: s.companyName,
  companyAddress: s.companyAddress ?? "",
  taxId: s.taxId ?? "",
  baseCurrency: s.baseCurrency,
  timezone: s.timezone,
  weekStartsOn: (s.weekStartsOn === 0 ? 0 : 1) as 0 | 1,
  timerMode: s.timerMode as Settings["timerMode"],
  timeDisplay: s.timeDisplay as Settings["timeDisplay"],
  roundingMinutes: s.roundingMinutes,
  requireNotes: s.requireNotes as Settings["requireNotes"],
  allowFutureDates: s.allowFutureDates,
  flagMissingBelowSeconds: opt(s.flagMissingBelowSeconds),
  modules: s.modules ?? {},
});

/* =============================================================== reference */

/** Local midnight today. Every calendar comparison in the UI is against this. */
export const TODAY = (() => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
})();

interface BootstrapWire {
  me: UserWire;
  users: UserWire[];
  clients: ClientWire[];
  projects: ProjectWire[];
  tasks: TaskWire[];
  settings: SettingsWire;
  expenseCategories: CategoryWire[];
  pinnedProjectIds: string[];
  profiles: { id: string; name: string; baseKey: string | null }[];
  capabilities: string[];
  baseKey: string | null;
}

/**
 * Everything the shell needs, in one request.
 *
 * The profile table is applied before any user is adapted, because `fromUser`
 * reads it to turn a profile id into a badge. Populating it here rather than
 * lazily means there is no order in which a user can be adapted against an
 * empty map.
 */
export async function getBootstrap() {
  const b = await get<BootstrapWire>("/bootstrap");

  profileKeyById = new Map(
    (b.profiles ?? []).map((p) => [p.id, (p.baseKey ?? "member") as PermissionProfile])
  );
  profileIdByKey = new Map(
    (b.profiles ?? []).map((p) => [(p.baseKey ?? "member") as PermissionProfile, p.id])
  );
  profileList = (b.profiles ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    key: (p.baseKey ?? "member") as PermissionProfile,
  }));

  return {
    me: fromUser(b.me),
    users: (b.users ?? []).map(fromUser),
    clients: (b.clients ?? []).map(fromClient),
    projects: (b.projects ?? []).map(fromProject),
    tasks: (b.tasks ?? []).map(fromTask),
    settings: fromSettings(b.settings),
    pinnedProjectIds: b.pinnedProjectIds ?? [],
    expenseCategories: (b.expenseCategories ?? []).map(fromCategory),
    capabilities: b.capabilities ?? [],
  };
}

export const listUsers = async (): Promise<User[]> =>
  (await get<UserWire[]>("/users", { status: "all" })).map(fromUser);

export const getUser = async (id: ID): Promise<User | null> => {
  try {
    return fromUser(await get<UserWire>(`/users/${id}`));
  } catch (e) {
    if (isApiError(e) && e.status === 404) return null;
    throw e;
  }
};

export const listClients = async (): Promise<Client[]> =>
  (await get<ClientWire[]>("/clients", { status: "all" })).map(fromClient);

export const listProjects = async (): Promise<Project[]> =>
  (await get<ProjectWire[]>("/projects", { status: "all" })).map(fromProject);

export const listTasks = async (): Promise<Task[]> =>
  (await get<TaskWire[]>("/tasks", { status: "all" })).map(fromTask);

export const getSettings = async (): Promise<Settings> => fromSettings(await get<SettingsWire>("/settings"));

export async function updateSettings(input: Partial<Settings>): Promise<Settings> {
  return fromSettings(await patch<SettingsWire>("/settings", input));
}

/* ============================================================ time entries */

export interface TimeQuery {
  from?: string; to?: string; userId?: ID; projectId?: ID; clientId?: ID; taskId?: ID;
}

export async function listTimeEntries(q: TimeQuery = {}): Promise<TimeEntryView[]> {
  const rows = await get<TimeEntryWire[]>("/time-entries", {
    from: q.from, to: q.to,
    user_id: q.userId, project_id: q.projectId, client_id: q.clientId, task_id: q.taskId,
  });
  return rows.map(fromTimeEntry);
}

export async function getRunningEntry(userId?: ID): Promise<TimeEntryView | null> {
  const row = await get<TimeEntryWire | null>("/time-entries/running", { user_id: userId });
  return row ? fromTimeEntry(row) : null;
}

export interface TimeEntryInput {
  userId?: ID; projectId: ID; taskId: ID; spentOn: string;
  durationSeconds?: number; startedAt?: string; endedAt?: string;
  notes?: string; isBillable?: boolean; start?: boolean;
}

interface CreateWire { entry: TimeEntryWire; stopped: TimeEntryWire | null }

/** Returns the new entry and whatever timer was stopped to make room for it. */
export async function createTimeEntry(input: TimeEntryInput) {
  const result = await post<CreateWire>("/time-entries", {
    userId: input.userId,
    projectId: input.projectId,
    taskId: input.taskId,
    spentOn: input.spentOn,
    durationSeconds: input.durationSeconds,
    startedAt: input.startedAt ?? null,
    endedAt: input.endedAt ?? null,
    notes: input.notes ?? null,
    isBillable: input.isBillable,
    start: input.start,
  });
  return {
    entry: fromTimeEntry(result.entry),
    stopped: result.stopped ? fromTimeEntry(result.stopped) : null,
  };
}

export async function updateTimeEntry(id: ID, p: Partial<TimeEntry>): Promise<TimeEntryView> {
  return fromTimeEntry(await patch<TimeEntryWire>(`/time-entries/${id}`, {
    projectId: p.projectId,
    taskId: p.taskId,
    spentOn: p.spentOn,
    durationSeconds: p.durationSeconds,
    startedAt: p.startedAt ?? undefined,
    endedAt: p.endedAt ?? undefined,
    notes: p.notes === undefined ? undefined : (p.notes ?? null),
    isBillable: p.isBillable,
  }));
}

export async function deleteTimeEntry(id: ID): Promise<{ id: ID }> {
  await del(`/time-entries/${id}`);
  return { id };
}

/**
 * Puts a deleted entry back, for the Undo toast.
 *
 * The argument is the whole entry rather than an id because that is what the
 * toast is holding, but only the id is sent: the server restores the row it
 * soft-deleted, so the rates and the invoice link come back as they were rather
 * than as the client last saw them.
 */
export async function restoreTimeEntry(entry: { id: ID }): Promise<TimeEntryView> {
  return fromTimeEntry(await post<TimeEntryWire>(`/time-entries/${entry.id}/restore`));
}

/** Stops the running timer. Defaults to your own; a reviewer may name somebody. */
export async function stopTimer(userId?: ID): Promise<TimeEntryView | null> {
  const row = await post<TimeEntryWire | null>("/time-entries/current/stop", { userId: userId ?? null });
  return row ? fromTimeEntry(row) : null;
}

export async function startTimerFrom(entryId: ID) {
  const result = await post<CreateWire>(`/time-entries/${entryId}/start`);
  return {
    entry: fromTimeEntry(result.entry),
    stopped: result.stopped ? fromTimeEntry(result.stopped) : null,
  };
}

export async function copyDay(
  fromDate: string, toDateStr: string, userId?: ID, withDurations = false
): Promise<TimeEntryView[]> {
  const rows = await post<TimeEntryWire[]>("/timesheet/copy-day", {
    from: fromDate, to: toDateStr, includeDurations: withDurations, userId,
  });
  return rows.map(fromTimeEntry);
}

/**
 * One cell of the week grid.
 *
 * Sent through the week endpoint as a single row carrying a single day. The
 * endpoint writes only the days present in the payload, so saving Tuesday does
 * not disturb the rest of the row, and a zero deletes rather than storing an
 * empty entry.
 */
export async function saveWeekCell(args: {
  userId: ID; projectId: ID; taskId: ID; notes?: string; spentOn: string; seconds: number;
}): Promise<TimeEntryView | null> {
  const weekStart = isoLocal(startOfWeek(new Date(`${args.spentOn}T00:00:00`)));
  const result = await request<TimeEntryWire[]>("PUT", "/timesheet/week", {
    body: {
      userId: args.userId,
      weekStart,
      rows: [{
        projectId: args.projectId,
        taskId: args.taskId,
        notes: args.notes ?? null,
        days: { [args.spentOn]: Math.max(0, Math.round(args.seconds)) },
      }],
    },
  });

  // A lock can refuse one cell while the rest of the week saves. Say so rather
  // than letting the grid show a value the server did not keep.
  const skipped = (result.meta?.skipped ?? []) as { reasons: string[] }[];
  if (skipped.length > 0) {
    throw new ApiError({
      status: 409,
      code: "record_locked",
      message: reasonText(skipped[0]!.reasons),
      meta: { reasons: skipped[0]!.reasons },
    });
  }

  const match = result.data.find(
    (e) => e.spentOn === args.spentOn && e.projectId === args.projectId &&
      (e.taskId ?? e.projectTaskId) === args.taskId
  );
  return match ? fromTimeEntry(match) : null;
}

/** Turns a lock reason code into the sentence the toast shows. */
function reasonText(reasons: string[]): string {
  const first = reasons[0] ?? "locked";
  const text: Record<string, string> = {
    period_approved: "That week has been approved. Ask an approver to reopen it.",
    invoiced: "That time is on an invoice and cannot be changed.",
    invoice_sent: "That time is on an invoice that has been sent.",
    billed_externally: "That time was marked as billed outside Tally.",
    timesheet_locked: "That timesheet is past the lock window.",
    not_yours: "That entry belongs to somebody else.",
  };
  return text[first] ?? "That entry cannot be changed.";
}

const isoLocal = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/* ================================================================ expenses */

/**
 * Lists that can be truncated say so.
 *
 * The server caps these collections and reports `hasMore`. Dropping that on the
 * floor turns a capped list into one that reads as complete, which is the exact
 * failure the cap was added to make visible. `truncated` is a property on the
 * returned array so no call site has to change to keep working.
 */
type MaybeTruncated<T> = T[] & { truncated?: boolean };

function withTruncation<T>(rows: T[], meta: Record<string, unknown> | undefined): MaybeTruncated<T> {
  const out = rows as MaybeTruncated<T>;
  if (meta?.hasMore) out.truncated = true;
  return out;
}

export async function listExpenses(
  q: { from?: string; to?: string; userId?: ID; projectId?: ID } = {}
): Promise<MaybeTruncated<ExpenseView>> {
  const { data, meta } = await request<ExpenseWire[]>("GET", "/expenses", {
    query: { from: q.from, to: q.to, user_id: q.userId, project_id: q.projectId },
  });
  return withTruncation(data.map(fromExpense), meta);
}

export async function createExpense(input: Omit<Expense, "id">): Promise<ExpenseView> {
  return fromExpense(await post<ExpenseWire>("/expenses", {
    userId: input.userId,
    projectId: input.projectId,
    categoryId: input.categoryId,
    spentOn: input.spentOn,
    units: input.units ?? null,
    totalCents: input.totalCents,
    notes: input.notes ?? null,
    isBillable: input.isBillable,
    isReimbursable: input.isReimbursable,
    receiptFilename: input.receiptName ?? null,
  }));
}

export async function updateExpense(id: ID, p: Partial<Expense>): Promise<ExpenseView> {
  return fromExpense(await patch<ExpenseWire>(`/expenses/${id}`, {
    projectId: p.projectId,
    categoryId: p.categoryId,
    spentOn: p.spentOn,
    units: p.units === undefined ? undefined : (p.units ?? null),
    totalCents: p.totalCents,
    notes: p.notes === undefined ? undefined : (p.notes ?? null),
    isBillable: p.isBillable,
    isReimbursable: p.isReimbursable,
    receiptFilename: p.receiptName === undefined ? undefined : (p.receiptName ?? null),
  }));
}

export async function deleteExpense(id: ID): Promise<{ id: ID }> {
  await del(`/expenses/${id}`);
  return { id };
}

/** Moves a batch of reimbursements along: pending, approved, then paid. */
export async function setReimbursementState(
  ids: ID[], state: "pending" | "approved" | "paid", paidAt?: string
): Promise<number> {
  const result = await post<{ updated: number }>("/expenses/reimbursements", { ids, state, paidAt });
  return result.updated;
}

/* ============================================================== approvals */

export const listSubmissions = async (): Promise<MaybeTruncated<SubmissionView>> => {
  const { data, meta } = await request<SubmissionWire[]>("GET", "/approvals", { query: { state: "all" } });
  return withTruncation(data.map(fromSubmission), meta);
};

export async function submitTimesheet(userId: ID, periodStart: string): Promise<SubmissionView> {
  return fromSubmission(await post<SubmissionWire>("/approvals/submit", { periodStart, userId }));
}

/**
 * Approving takes an optional note; sending something back does not.
 *
 * "Changes requested" with no reason is a message that says only "no", and the
 * server refuses it, so the signature refuses it too rather than letting a
 * call that typechecks fail at runtime.
 */
export async function reviewSubmission(
  id: ID, state: "approved", note?: string
): Promise<SubmissionView>;
export async function reviewSubmission(
  id: ID, state: "changes_requested", note: string
): Promise<SubmissionView>;
export async function reviewSubmission(
  id: ID, state: "approved" | "changes_requested", note?: string
): Promise<SubmissionView> {
  const path = state === "approved" ? `/approvals/${id}/approve` : `/approvals/${id}/request-changes`;
  return fromSubmission(await post<SubmissionWire>(path, { note }));
}

export async function approveMany(ids: ID[]): Promise<number> {
  const result = await post<{ approved: number }>("/approvals/approve-many", { ids });
  return result.approved;
}

export async function remindToSubmit(periodStart: string, userIds?: ID[]): Promise<number> {
  const result = await post<{ reminded: number }>("/approvals/remind", { periodStart, userIds });
  return result.reminded;
}

/* ================================================================ projects */

export async function getProject(id: ID): Promise<Project | null> {
  try {
    return fromProject(await get<ProjectWire>(`/projects/${id}`));
  } catch (e) {
    if (isApiError(e) && e.status === 404) return null;
    throw e;
  }
}

export async function createProject(input: Partial<Project> & { name: string; clientId: ID }): Promise<Project> {
  return fromProject(await post<ProjectWire>("/projects", projectBody(input, true)));
}

export async function updateProject(id: ID, p: Partial<Project>): Promise<Project> {
  return fromProject(await patch<ProjectWire>(`/projects/${id}`, projectBody(p, false)));
}

function projectBody(p: Partial<Project>, creating: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    clientId: p.clientId,
    name: p.name,
    code: p.code === undefined ? undefined : (p.code || null),
    billingType: p.billingType ?? (creating ? "time_and_materials" : undefined),
    billBy: p.billBy,
    hourlyRateCents: p.hourlyRateCents === undefined ? undefined : (p.hourlyRateCents ?? null),
    feeCents: p.feeCents === undefined ? undefined : (p.feeCents ?? null),
    feeCadence: p.feeCadence === undefined ? undefined : (p.feeCadence ?? null),
    budgetBy: p.budgetBy,
    budgetSeconds: p.budgetSeconds === undefined ? undefined : (p.budgetSeconds ?? null),
    budgetFeeCents: p.budgetFeeCents === undefined ? undefined : (p.budgetFeeCents ?? null),
    budgetResetsMonthly: p.budgetResetsMonthly,
    budgetAlertPercent: p.budgetAlertPercent === undefined ? undefined : (p.budgetAlertPercent ?? null),
    startsOn: p.startsOn === undefined ? undefined : (p.startsOn || null),
    endsOn: p.endsOn === undefined ? undefined : (p.endsOn || null),
    notes: p.notes === undefined ? undefined : (p.notes || null),
    tags: p.tags,
    taskIds: p.taskIds,
    memberIds: p.memberIds,
    managerIds: p.managerIds,
  };
  for (const key of Object.keys(body)) if (body[key] === undefined) delete body[key];
  return body;
}

export async function archiveProject(id: ID, archived = true): Promise<Project> {
  const path = archived ? `/projects/${id}/archive` : `/projects/${id}/restore`;
  return fromProject(await post<ProjectWire>(path));
}

/** Pins or unpins for the signed-in person only. Returns the whole new list. */
export async function togglePin(id: ID, pinned: boolean): Promise<ID[]> {
  const result = await post<{ pinned: boolean; pinnedProjectIds: string[] }>(
    `/projects/${id}/${pinned ? "pin" : "unpin"}`
  );
  return result.pinnedProjectIds;
}

/* ================================================================= clients */

/**
 * `null` clears a field; leaving it out changes nothing.
 *
 * The distinction has to be expressible or a form cannot empty a box: the API
 * patch is partial, so an absent key means "as you were", and sending
 * `undefined` for a cleared input silently kept the old value.
 */
export type ClientPatch = Omit<Partial<Client>, "taxPercent" | "discountPercent" | "address"> & {
  taxPercent?: number | null;
  discountPercent?: number | null;
  address?: string | null;
};

export async function createClient(input: ClientPatch & { name: string }): Promise<Client> {
  return fromClient(await post<ClientWire>("/clients", clientBody(input, true)));
}

export async function updateClient(id: ID, p: ClientPatch): Promise<Client> {
  return fromClient(await patch<ClientWire>(`/clients/${id}`, clientBody(p, false)));
}

function clientBody(c: ClientPatch, creating: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: c.name,
    address: c.address === undefined ? undefined : (c.address || null),
    currency: c.currency ?? (creating ? "USD" : undefined),
    paymentTerm: c.paymentTerm,
    paymentTermDays: c.paymentTermDays,
    taxPercent: c.taxPercent === undefined ? undefined : (c.taxPercent ?? null),
    discountPercent: c.discountPercent === undefined ? undefined : (c.discountPercent ?? null),
    contacts: c.contacts?.map((k) => ({
      id: k.id?.startsWith("new-") ? undefined : k.id,
      firstName: k.firstName || null,
      lastName: k.lastName || null,
      title: k.title || null,
      email: k.email || null,
      phone: k.phone || null,
      isPrimary: k.isPrimary ?? false,
    })),
  };
  for (const key of Object.keys(body)) if (body[key] === undefined) delete body[key];
  return body;
}

/* =================================================================== tasks */

export async function createTask(input: Partial<Task> & { name: string }): Promise<Task> {
  return fromTask(await post<TaskWire>("/tasks", {
    name: input.name,
    defaultBillable: input.defaultBillable ?? true,
    isCommon: input.isCommon ?? false,
    defaultHourlyRateCents: input.defaultRateCents ?? null,
  }));
}

export async function updateTask(id: ID, p: Partial<Task>): Promise<Task> {
  const body: Record<string, unknown> = {
    name: p.name,
    defaultBillable: p.defaultBillable,
    isCommon: p.isCommon,
    defaultHourlyRateCents: p.defaultRateCents === undefined ? undefined : (p.defaultRateCents ?? null),
  };
  if ("archivedAt" in p) body.archived = p.archivedAt != null;
  for (const key of Object.keys(body)) if (body[key] === undefined) delete body[key];
  return fromTask(await patch<TaskWire>(`/tasks/${id}`, body));
}

/* ================================================================== people */

export async function updateUser(id: ID, p: Partial<User>): Promise<User> {
  const body: Record<string, unknown> = {
    firstName: p.firstName,
    lastName: p.lastName,
    email: p.email,
    timezone: p.timezone,
    weeklyCapacitySeconds: p.weeklyCapacitySeconds,
    employmentType: p.employmentType,
    startedOn: p.startedOn === undefined ? undefined : (p.startedOn || null),
    roles: p.roles,
    departments: p.departments,
    // The UI holds a profile key; the wire wants an id. An unknown key is sent
    // as undefined and therefore dropped below, which leaves the permission
    // alone rather than guessing at one.
    profileId: p.profile === undefined ? undefined : profileIdByKey.get(p.profile),
  };
  for (const key of Object.keys(body)) if (body[key] === undefined) delete body[key];
  return fromUser(await patch<UserWire>(`/users/${id}`, body));
}

export async function archiveUser(id: ID, archived = true): Promise<User> {
  const path = archived ? `/users/${id}/archive` : `/users/${id}/restore`;
  return fromUser(await post<UserWire>(path));
}

export async function inviteUser(id: ID): Promise<{ queued: boolean }> {
  return post<{ queued: boolean }>(`/users/${id}/invite`);
}

/* ================================================================ invoices */

export const listInvoices = async (): Promise<MaybeTruncated<InvoiceView>> => {
  const { data, meta } = await request<InvoiceWire[]>("GET", "/invoices", { query: { state: "all" } });
  return withTruncation(data.map(fromInvoice), meta);
};

export async function getInvoice(id: ID): Promise<InvoiceView | null> {
  try {
    return fromInvoice(await get<InvoiceWire>(`/invoices/${id}`));
  } catch (e) {
    if (isApiError(e) && e.status === 404) return null;
    throw e;
  }
}

/* ------------------------------------------------------ recurring invoices */

interface RecurringWire {
  id: string; clientId: string; subject: string | null;
  frequency: string; interval: number;
  startsOn: string; endsOn: string | null; occurrencesRemaining: number | null;
  nextIssueOn: string | null; lastIssuedOn: string | null;
  state: string; sendAutomatically: boolean; amountCents: number;
  notes: string | null; paymentTermDays: number;
  taxPercent: number | null; discountPercent: number | null;
  lines: { description: string; quantity: number; unitPriceCents: number; isTaxed?: boolean }[];
}

const fromRecurring = (r: RecurringWire): RecurringInvoice => ({
  id: r.id,
  clientId: r.clientId,
  subject: r.subject ?? "",
  frequency: r.frequency as RecurringInvoice["frequency"],
  interval: r.interval,
  startsOn: r.startsOn,
  endsOn: opt(r.endsOn),
  occurrencesRemaining: r.occurrencesRemaining ?? undefined,
  nextIssueOn: opt(r.nextIssueOn),
  lastIssuedOn: opt(r.lastIssuedOn),
  amountCents: r.amountCents,
  state: r.state as RecurringInvoice["state"],
  sendAutomatically: r.sendAutomatically,
  notes: opt(r.notes),
  paymentTermDays: r.paymentTermDays,
  taxPercent: r.taxPercent ?? undefined,
  discountPercent: r.discountPercent ?? undefined,
  lines: r.lines ?? [],
});

export const listRecurringInvoices = async (): Promise<RecurringInvoice[]> =>
  (await get<RecurringWire[]>("/recurring-invoices")).map(fromRecurring);

export async function getRecurringInvoice(id: ID): Promise<RecurringInvoice | null> {
  try {
    return fromRecurring(await get<RecurringWire>(`/recurring-invoices/${id}`));
  } catch (e) {
    if (isApiError(e) && e.status === 404) return null;
    throw e;
  }
}

/** The body both create and update take. A schedule is written whole. */
export interface RecurringInput {
  clientId: ID;
  subject?: string | null;
  notes?: string | null;
  frequency: RecurringInvoice["frequency"];
  interval: number;
  startsOn: string;
  endsOn?: string | null;
  occurrencesRemaining?: number | null;
  sendAutomatically?: boolean;
  paymentTermDays?: number;
  taxPercent?: number | null;
  discountPercent?: number | null;
  lines: RecurringInvoiceLine[];
}

export const createRecurringInvoice = async (input: RecurringInput): Promise<RecurringInvoice> =>
  fromRecurring(await post<RecurringWire>("/recurring-invoices", input));

export const updateRecurringInvoice = async (id: ID, input: RecurringInput): Promise<RecurringInvoice> =>
  fromRecurring(await patch<RecurringWire>(`/recurring-invoices/${id}`, input));

export const setRecurringInvoiceState = async (
  id: ID,
  state: "active" | "paused"
): Promise<RecurringInvoice> =>
  fromRecurring(await post<RecurringWire>(`/recurring-invoices/${id}/state`, { state }));

/** Raises the next invoice now and moves the schedule on one period. */
export const issueRecurringInvoice = async (id: ID): Promise<{ invoiceId: ID }> =>
  post<{ invoiceId: string }>(`/recurring-invoices/${id}/issue`);

export const deleteRecurringInvoice = async (id: ID): Promise<void> => {
  await del(`/recurring-invoices/${id}`);
};

interface RetainerWire {
  id: string; clientId: string; projectId: string | null; balanceCents: number;
  archivedAt: string | null;
  transactions: {
    id: string; kind: string; amountCents: number; balanceAfterCents: number;
    invoiceId: string | null; note: string | null; at: string;
  }[];
}

const fromRetainer = (r: RetainerWire): Retainer => ({
  id: r.id,
  clientId: r.clientId,
  projectId: opt(r.projectId),
  balanceCents: r.balanceCents,
  archivedAt: opt(r.archivedAt),
  transactions: r.transactions.map((t) => ({
    id: t.id,
    kind: t.kind as "add" | "draw" | "adjust",
    amountCents: t.amountCents,
    balanceAfterCents: t.balanceAfterCents,
    at: t.at,
    note: opt(t.note),
    invoiceId: opt(t.invoiceId),
  })),
});

export const listRetainers = async (): Promise<Retainer[]> =>
  (await get<RetainerWire[]>("/retainers")).map(fromRetainer);

export interface CreateRetainerInput {
  clientId: ID;
  projectId?: ID | null;
  openingCents?: number;
  note?: string | null;
}

export const createRetainer = async (input: CreateRetainerInput): Promise<Retainer> =>
  fromRetainer(
    await post<RetainerWire>("/retainers", input, idempotencyKey("retainer-create", input))
  );

/**
 * Money in, and the key is derived rather than random.
 *
 * A fresh UUID per call would make the mechanism inert: a double click sends
 * two different keys, the server matches neither, and the client is credited
 * twice. Derived from the amount and note, so pressing the button twice is the
 * same request. Two genuinely separate payments of the same amount differ by
 * their note, and if they do not, the second is almost certainly the accident
 * this is here to stop.
 */
export const addRetainerFunds = async (
  id: ID,
  input: { amountCents: number; note?: string | null }
): Promise<Retainer> =>
  fromRetainer(
    await post<RetainerWire>(
      `/retainers/${id}/funds`,
      input,
      idempotencyKey("retainer-funds", { id, ...input })
    )
  );

export const adjustRetainer = async (
  id: ID,
  input: { deltaCents: number; note: string }
): Promise<Retainer> =>
  fromRetainer(
    await post<RetainerWire>(
      `/retainers/${id}/adjust`,
      input,
      idempotencyKey("retainer-adjust", { id, ...input })
    )
  );

export const archiveRetainer = async (id: ID): Promise<Retainer> =>
  fromRetainer(await del<RetainerWire>(`/retainers/${id}`));

/**
 * Edits a draft, or moves an invoice along its state machine.
 *
 * Write-off and close are not field edits, they are transitions with their own
 * consequences (a retainer draw gets reversed, an event is written), so they go
 * to their own endpoints rather than through a PATCH of `state`.
 */
export async function updateInvoice(id: ID, p: Partial<Invoice>): Promise<InvoiceView> {
  if (p.state === "written_off") return fromInvoice(await post<InvoiceWire>(`/invoices/${id}/write-off`));
  if (p.state === "paid") return fromInvoice(await post<InvoiceWire>(`/invoices/${id}/close`));

  const body: Record<string, unknown> = {
    subject: p.subject === undefined ? undefined : (p.subject || null),
    notes: p.notes === undefined ? undefined : (p.notes || null),
    poNumber: p.poNumber === undefined ? undefined : (p.poNumber || null),
    issueDate: p.issueDate,
    dueDate: p.dueDate,
    taxPercent: p.taxPercent === undefined ? undefined : (p.taxPercent ?? null),
    discountPercent: p.discountPercent === undefined ? undefined : (p.discountPercent ?? null),
  };
  for (const key of Object.keys(body)) if (body[key] === undefined) delete body[key];
  return fromInvoice(await patch<InvoiceWire>(`/invoices/${id}`, body));
}

export async function recordPayment(id: ID, amountCents: number, paidAt: string): Promise<InvoiceView> {
  // A payment is money moving, so a retried request must not become two.
  const body = { amountCents, paidAt: new Date(paidAt).toISOString() };
  return fromInvoice(await post<InvoiceWire>(
    `/invoices/${id}/payments`,
    body,
    // Keyed on the invoice and the payment itself, so a double click is one
    // payment and a genuinely second payment of the same amount on the same
    // day is still two.
    idempotencyKey(`payment-${id}`, body)
  ));
}

export async function voidPayment(invoiceId: ID, paymentId: ID): Promise<InvoiceView> {
  return fromInvoice(await post<InvoiceWire>(`/invoices/${invoiceId}/payments/${paymentId}/void`));
}

/** What could go on an invoice for a client: billable time and billable expenses
 *  that are not on an invoice already and were not billed outside the system. */
export interface UninvoicedLine {
  key: string;
  projectId: ID;
  kind: "time" | "expense";
  label: string;
  sublabel: string;
  quantity: number;          // hours for time, units or 1 for an expense
  unitPriceCents: number;
  amountCents: number;
  entryIds: ID[];
  expenseIds: ID[];
}

interface UninvoicedWire {
  key: string; projectId: string; kind: "time" | "expense";
  label: string; sublabel: string; quantity: number;
  unitPriceCents: number; amountCents: number;
  timeEntryIds: string[]; expenseIds: string[];
}

export async function getUninvoiced(
  clientId: ID,
  opts: { from?: string; to?: string; groupBy?: "project" | "task" | "person" } = {}
): Promise<UninvoicedLine[]> {
  const rows = await post<UninvoicedWire[]>("/invoices/preview-lines", {
    clientId,
    from: opts.from,
    to: opts.to,
    grouping: opts.groupBy ?? "project",
  });
  return rows.map((l) => ({
    key: l.key,
    projectId: l.projectId,
    kind: l.kind,
    label: l.label,
    sublabel: l.sublabel,
    quantity: l.quantity,
    unitPriceCents: l.unitPriceCents,
    amountCents: l.amountCents,
    entryIds: l.timeEntryIds,
    expenseIds: l.expenseIds,
  }));
}

interface UninvoicedClientWire {
  clientId: string;
  clientName: string;
  currency: string;
  hours: number;
  timeCents: number;
  expenseCount: number;
  expenseCents: number;
  totalCents: number;
  from: string | null;
  to: string | null;
}

/**
 * Every client with unbilled work, largest first.
 *
 * The server computes the totals. This does not re-derive them, and must not
 * start to: the screen's figure has to equal the invoice the client's preview
 * then offers, and the only way to keep that true is for one place to do the
 * arithmetic. `tests/uninvoiced.test.ts` asserts the equality.
 */
export async function listUninvoicedClients(): Promise<UninvoicedClient[]> {
  const rows = await get<UninvoicedClientWire[]>("/invoices/uninvoiced");
  return rows.map((r) => ({
    ...r,
    from: r.from ?? undefined,
    to: r.to ?? undefined,
  }));
}

export interface InvoiceConfig {
  company: { name: string; address: string | null; taxId: string | null };
  defaults: InvoiceDefaults;
  rounding: { minutes: number; mode: string };
  appearance: InvoiceAppearance;
  messages: Record<string, string>;
  labels: FieldLabels;
  numbering: { pattern: string; nextSeq: number; example: string };
}

export type InvoiceConfigPatch =
  | { section: "company"; value: { name: string; address?: string | null; taxId?: string | null } }
  | { section: "defaults"; value: Record<string, unknown> }
  | { section: "appearance"; value: Record<string, unknown> }
  | { section: "messages"; value: Record<string, string> }
  | { section: "labels"; value: Record<string, string> }
  | { section: "numbering"; value: { pattern?: string; nextSeq?: number } };

export const getInvoiceConfig = () => get<InvoiceConfig>("/settings/invoice-config");

export const updateInvoiceConfig = (input: InvoiceConfigPatch) =>
  patch<InvoiceConfig>("/settings/invoice-config", input);

export interface ItemType {
  id: ID;
  name: string;
  isDefaultForExpenses: boolean;
  isDefaultForServices: boolean;
  archivedAt: string | null;
  usageCount: number;
}

export const listItemTypes = () => get<ItemType[]>("/settings/item-types");

export const createItemType = (input: { name: string }) =>
  post<ItemType>("/settings/item-types", input);

export const updateItemType = (
  id: ID,
  input: { name?: string; isDefaultForExpenses?: boolean; isDefaultForServices?: boolean }
) => patch<ItemType>(`/settings/item-types/${id}`, input);

export const removeItemType = (id: ID) =>
  del<{ archived: boolean }>(`/settings/item-types/${id}`);

export interface CreateInvoiceInput {
  clientId: ID;
  subject?: string;
  notes?: string;
  poNumber?: string;
  issueDate: string;
  dueDate: string;
  taxPercent?: number;
  discountPercent?: number;
  lines: UninvoicedLine[];
}

export async function createInvoice(input: CreateInvoiceInput): Promise<InvoiceView> {
  const body = {
    clientId: input.clientId,
    subject: input.subject?.trim() || null,
    notes: input.notes?.trim() || null,
    poNumber: input.poNumber?.trim() || null,
    issueDate: input.issueDate,
    dueDate: input.dueDate,
    taxPercent: input.taxPercent ?? null,
    discountPercent: input.discountPercent ?? null,
    lines: input.lines.map((l) => ({
      projectId: l.projectId,
      description: l.sublabel && l.sublabel !== "Billable time" ? `${l.label}: ${l.sublabel}` : l.label,
      quantity: l.quantity,
      unitPriceCents: Math.round(l.unitPriceCents),
      // The exact value, not `quantity x unitPrice`. The quantity is hours
      // rounded to two decimals for the document, and re-deriving the amount
      // from it is how the preview and the invoice came out dollars apart.
      amountCents: Math.round(l.amountCents),
      isTaxed: l.kind !== "expense",
      // The server resolves this to whichever type currently holds the default
      // role, so the browser never has to know which one that is.
      kind: l.kind,
    })),
    projectIds: [...new Set(input.lines.map((l) => l.projectId))],
    timeEntryIds: input.lines.flatMap((l) => l.entryIds),
    expenseIds: input.lines.flatMap((l) => l.expenseIds),
  };

  // Keyed on the whole payload: the same lines for the same client on the same
  // dates is the same invoice, however many times the button is pressed.
  return fromInvoice(await post<InvoiceWire>("/invoices", body, idempotencyKey("invoice", body)));
}

export async function deleteInvoice(id: ID): Promise<boolean> {
  await del(`/invoices/${id}`);
  return true;
}

export async function markInvoiceSent(id: ID): Promise<InvoiceView> {
  return fromInvoice(await post<InvoiceWire>(`/invoices/${id}/mark-sent`));
}

/**
 * Copies an invoice into a new draft.
 *
 * The lines come across; the claimed time and expenses do not, because those
 * are already on the original and billing them twice is the one thing the
 * attachment rules exist to prevent. Dates move to today and the payment terms
 * of the original.
 */
export async function duplicateInvoice(id: ID): Promise<InvoiceView> {
  const source = await getInvoice(id);
  if (!source) throw new ApiError({ status: 404, code: "not_found", message: "That invoice no longer exists." });

  const span = Math.max(
    0,
    Math.round((new Date(source.dueDate).getTime() - new Date(source.issueDate).getTime()) / 86_400_000)
  );
  const issueDate = isoLocal(new Date());
  const dueDate = isoLocal(new Date(Date.now() + span * 86_400_000));

  return fromInvoice(await post<InvoiceWire>(
    "/invoices",
    {
      clientId: source.clientId,
      subject: source.subject ?? null,
      notes: source.notes ?? null,
      poNumber: source.poNumber ?? null,
      issueDate,
      dueDate,
      taxPercent: source.taxPercent ?? null,
      discountPercent: source.discountPercent ?? null,
      lines: source.lineItems.map((l) => ({
        projectId: l.projectId ?? null,
        description: l.description,
        quantity: l.quantity,
        unitPriceCents: l.unitPriceCents,
        amountCents: l.amountCents,
        isTaxed: l.isTaxed,
      })),
      projectIds: source.projectIds,
    },
    idempotencyKey(`duplicate-${id}`, { issueDate, dueDate })
  ));
}

/** Records a reminder against the invoice. Reports whether it was really sent. */
export async function sendReminder(id: ID, to: string[]): Promise<{ delivered: boolean }> {
  return post<{ delivered: boolean }>(`/invoices/${id}/reminder`, { to });
}

export async function archiveClient(id: ID): Promise<void> {
  await del(`/clients/${id}`);
}

export async function createExpenseCategory(input: {
  name: string; unitName?: string; unitPriceCents?: number;
}): Promise<ExpenseCategory> {
  return fromCategory(await post<CategoryWire>("/expense-categories", {
    name: input.name,
    unitName: input.unitName ?? null,
    unitPriceCents: input.unitPriceCents ?? null,
  }));
}

export async function updateExpenseCategory(
  id: ID, patch: { name?: string; unitName?: string | null; unitPriceCents?: number | null; archived?: boolean }
): Promise<ExpenseCategory> {
  return fromCategory(await patch_<CategoryWire>(`/expense-categories/${id}`, patch));
}

/** Ends every session in the account, including this one. */
export async function signOutEverywhere(): Promise<{ revoked: number }> {
  return post<{ revoked: number }>("/auth/signout-all", {});
}

export async function sendInvoice(
  id: ID, message: { to: string[]; cc?: string[]; bcc?: string[]; subject?: string; body?: string }
): Promise<InvoiceView> {
  return fromInvoice(await post<InvoiceWire>(`/invoices/${id}/send`, message));
}

/* ================================================================= reports */

export interface ReportRow {
  key: string;
  label: string;
  sub?: string | null;
  seconds: number;
  billableSeconds: number;
  amountCents: number | null;
  costCents: number | null;
  [extra: string]: unknown;
}

export interface ReportResult<Row = ReportRow> {
  rows: Row[];
  totals: Record<string, number | null>;
  meta: Record<string, unknown>;
}

async function report<Row>(path: string, query: Query): Promise<ReportResult<Row>> {
  const { data, meta } = await request<Row[]>("GET", path, { query });
  return {
    rows: data ?? [],
    totals: (meta?.totals ?? {}) as Record<string, number | null>,
    meta: meta ?? {},
  };
}

export const timeReport = (q: {
  from: string; to: string; groupBy?: "client" | "project" | "task" | "user";
  userId?: ID; projectId?: ID; clientId?: ID;
}) => report<ReportRow>("/reports/time", {
  from: q.from, to: q.to, group_by: q.groupBy ?? "client",
  user_id: q.userId, project_id: q.projectId, client_id: q.clientId,
});

export const profitabilityReport = (q: { from: string; to: string; groupBy?: "project" | "client" }) =>
  report<ReportRow>("/reports/profitability", { from: q.from, to: q.to, group_by: q.groupBy ?? "project" });

export const teamReport = (q: { from: string; to: string; employmentType?: "employee" | "contractor" }) =>
  report<ReportRow>("/reports/team", { from: q.from, to: q.to, employment_type: q.employmentType });

export const invoicingReport = (q: { from: string; to: string }) =>
  report<ReportRow>("/reports/invoicing", { from: q.from, to: q.to });

/** Everything the project page's KPI cards need, computed server-side. */
export interface ProjectSummaryDto {
  totalSeconds: number;
  billableSeconds: number;
  nonBillableSeconds: number;
  billableCents: number;
  costCents: number;
  expenseCents: number;
  invoicedCents: number;
  uninvoicedCents: number;
  overbilledCents: number;
  feesToDateCents: number | null;
  budget: {
    by: string;
    budget: number | null;
    spent: number;
    remaining: number | null;
    percentUsed: number | null;
    monthly: boolean;
  };
}

export const getProjectSummary = async (id: ID): Promise<ProjectSummaryDto | null> => {
  try {
    return await get<ProjectSummaryDto>(`/projects/${id}/summary`);
  } catch (e) {
    if (isApiError(e) && e.status === 404) return null;
    throw e;
  }
};

/* ================================================================== search */

export interface SearchHit { type: "project" | "client" | "person" | "invoice" | "task"; id: ID; label: string; sub?: string }

export async function search(q: string): Promise<SearchHit[]> {
  const term = q.trim();
  if (!term) return [];
  // The hits are the collection, so they arrive as `data`; the per-type counts
  // are the meta. Reading a `hits` key off the envelope returns undefined and
  // the palette silently shows nothing for every query.
  const hits = await get<(SearchHit & { sub?: string | null })[]>("/search", { q: term });
  return (hits ?? []).map((h) => ({ ...h, sub: opt(h.sub) }));
}

/* ==================================================================== auth */

export async function signIn(email: string, password: string): Promise<void> {
  await request("POST", "/auth/signin", { body: { email, password } });
}

export async function signOut(): Promise<void> {
  await request("POST", "/auth/signout", { body: {} });
}

export const authProviders = () =>
  get<{ password: boolean; google: boolean }>("/auth/providers");

export { startOfWeek };
