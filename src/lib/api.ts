/**
 * Mock API.
 *
 * An in-memory store seeded from `src/mock/seed.ts`, persisted to localStorage
 * so edits survive a reload while testing. Every function returns a Promise with
 * a little latency, so loading and optimistic states are exercised for real
 * rather than being theoretical.
 *
 * THIS IS THE ONLY FILE THAT KNOWS THE BACKEND DOES NOT EXIST YET. Swapping to
 * the real `/api/v1` means rewriting the bodies of these functions to `fetch`;
 * every signature and every component stays as it is.
 */

"use client";

import * as seed from "@/mock/seed";
import type {
  Client, Expense, ExpenseCategory, Invoice, InvoiceLineItem, Project, Settings, Task,
  TimeEntry, TimesheetSubmission, User, ID, RecurringInvoice, Retainer,
} from "./types";
import { addDays, isoDate, startOfWeek, toDate } from "./format";
import { secondsToCents } from "./derive";

const KEY = "tally-mock-db-v1";
const LATENCY = 90;

interface DB {
  users: User[]; clients: Client[]; projects: Project[]; tasks: Task[];
  timeEntries: TimeEntry[]; expenses: Expense[]; expenseCategories: ExpenseCategory[];
  submissions: TimesheetSubmission[]; invoices: Invoice[];
  recurringInvoices: RecurringInvoice[]; retainers: Retainer[];
  settings: Settings; pinnedProjectIds: ID[];
}

function fresh(): DB {
  return {
    users: seed.users, clients: seed.clients, projects: seed.projects, tasks: seed.tasks,
    timeEntries: seed.timeEntries, expenses: seed.expenses,
    expenseCategories: seed.expenseCategories, submissions: seed.submissions,
    invoices: seed.invoices, recurringInvoices: seed.recurringInvoices,
    retainers: seed.retainers, settings: seed.settings, pinnedProjectIds: [],
  };
}

let db: DB = fresh();
let loaded = false;

function load() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) db = { ...fresh(), ...JSON.parse(raw) };
  } catch { /* corrupt or blocked storage: fall back to the seed */ }
}
function save() {
  if (typeof window === "undefined") return;
  try { localStorage.setItem(KEY, JSON.stringify(db)); } catch { /* quota or private mode */ }
}
export function resetDatabase() {
  db = fresh();
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}

/**
 * Every response is a copy.
 *
 * This is not politeness, it is correctness. Returning `db.clients` directly
 * hands the caller a live reference into the store, so the next `unshift`
 * mutates the object already sitting in the React Query cache. Query
 * invalidation then refetches, structural sharing finds old and new identical
 * (they are literally the same array), keeps the previous reference, and every
 * `useMemo` keyed on it skips: a client you just created renders as "not
 * found". A real `fetch` always yields fresh objects, so the mock does too.
 */
const clone = <T,>(value: T): T =>
  typeof structuredClone === "function" ? structuredClone(value) : (JSON.parse(JSON.stringify(value)) as T);

const delay = <T,>(value: T): Promise<T> =>
  new Promise((r) => setTimeout(() => r(clone(value)), LATENCY + Math.random() * 60));

const uid = (p: string) => `${p}${Math.random().toString(36).slice(2, 9)}`;

/** The signed-in user. Real app reads this from the session. */
export const CURRENT_USER_ID = seed.CURRENT_USER_ID;
export const TODAY = seed.TODAY;

/* =============================================================== reference */

export async function getBootstrap() {
  load();
  return delay({
    me: db.users.find((u) => u.id === CURRENT_USER_ID)!,
    users: db.users,
    clients: db.clients,
    projects: db.projects,
    tasks: db.tasks,
    settings: db.settings,
    pinnedProjectIds: db.pinnedProjectIds,
    expenseCategories: db.expenseCategories,
  });
}

export const listUsers = async () => { load(); return delay(db.users); };
export const getUser = async (id: ID) => { load(); return delay(db.users.find((u) => u.id === id) ?? null); };
export const listClients = async () => { load(); return delay(db.clients); };
export const listProjects = async () => { load(); return delay(db.projects); };
export const listTasks = async () => { load(); return delay(db.tasks); };
export const getSettings = async () => { load(); return delay(db.settings); };

export async function updateSettings(patch: Partial<Settings>) {
  load(); db.settings = { ...db.settings, ...patch }; save();
  return delay(db.settings);
}

/* ============================================================ time entries */

export interface TimeQuery {
  from?: string; to?: string; userId?: ID; projectId?: ID; clientId?: ID; taskId?: ID;
}

export async function listTimeEntries(q: TimeQuery = {}) {
  load();
  const clientProjects = q.clientId ? new Set(db.projects.filter((p) => p.clientId === q.clientId).map((p) => p.id)) : null;
  const rows = db.timeEntries.filter((e) => {
    if (q.from && e.spentOn < q.from) return false;
    if (q.to && e.spentOn > q.to) return false;
    if (q.userId && e.userId !== q.userId) return false;
    if (q.projectId && e.projectId !== q.projectId) return false;
    if (q.taskId && e.taskId !== q.taskId) return false;
    if (clientProjects && !clientProjects.has(e.projectId)) return false;
    return true;
  });
  return delay(rows);
}

export async function getRunningEntry(userId: ID = CURRENT_USER_ID) {
  load();
  return delay(db.timeEntries.find((e) => e.userId === userId && e.timerStartedAt) ?? null);
}

export interface TimeEntryInput {
  userId?: ID; projectId: ID; taskId: ID; spentOn: string;
  durationSeconds?: number; startedAt?: string; endedAt?: string;
  notes?: string; isBillable?: boolean; start?: boolean;
}

export async function createTimeEntry(input: TimeEntryInput) {
  load();
  const userId = input.userId ?? CURRENT_USER_ID;
  const user = db.users.find((u) => u.id === userId)!;
  const project = db.projects.find((p) => p.id === input.projectId)!;
  const task = db.tasks.find((t) => t.id === input.taskId)!;
  const billable = input.isBillable ?? (project.billingType !== "non_billable" && task.defaultBillable);

  // One running timer per user: stop whatever is running before starting a new one.
  let stopped: TimeEntry | null = null;
  if (input.start) stopped = stopTimerSync(userId);

  const entry: TimeEntry = {
    id: uid("te"), userId, projectId: input.projectId, taskId: input.taskId,
    spentOn: input.spentOn,
    startedAt: input.startedAt, endedAt: input.endedAt,
    durationSeconds: input.durationSeconds ?? 0,
    timerStartedAt: input.start ? new Date().toISOString() : undefined,
    notes: input.notes, isBillable: billable,
    billableRateCents: billable ? user.billableRateCents : 0,
    costRateCents: user.costRateCents,
  };
  db.timeEntries.push(entry);
  save();
  return delay({ entry, stopped });
}

export async function updateTimeEntry(id: ID, patch: Partial<TimeEntry>) {
  load();
  const i = db.timeEntries.findIndex((e) => e.id === id);
  if (i < 0) throw new Error("Entry not found");
  db.timeEntries[i] = { ...db.timeEntries[i]!, ...patch };
  save();
  return delay(db.timeEntries[i]!);
}

export async function deleteTimeEntry(id: ID) {
  load();
  const i = db.timeEntries.findIndex((e) => e.id === id);
  const removed = i >= 0 ? db.timeEntries.splice(i, 1)[0]! : null;
  save();
  return delay(removed);
}

/** Restores a deleted entry, for the Undo toast. */
export async function restoreTimeEntry(entry: TimeEntry) {
  load(); db.timeEntries.push(entry); save(); return delay(entry);
}

function stopTimerSync(userId: ID): TimeEntry | null {
  const running = db.timeEntries.find((e) => e.userId === userId && e.timerStartedAt);
  if (!running) return null;
  const elapsed = Math.round((Date.now() - new Date(running.timerStartedAt!).getTime()) / 1000);
  running.durationSeconds += Math.max(0, elapsed);
  running.endedAt = new Date().toISOString();
  running.timerStartedAt = undefined;
  return running;
}

export async function stopTimer(userId: ID = CURRENT_USER_ID) {
  load(); const e = stopTimerSync(userId); save(); return delay(e);
}

export async function startTimerFrom(entryId: ID) {
  load();
  const src = db.timeEntries.find((e) => e.id === entryId)!;
  return createTimeEntry({
    userId: src.userId, projectId: src.projectId, taskId: src.taskId,
    spentOn: isoDate(TODAY), notes: src.notes, start: true,
    startedAt: new Date().toISOString(),
  });
}

export async function copyDay(fromDate: string, toDateStr: string, userId: ID = CURRENT_USER_ID, withDurations = false) {
  load();
  const src = db.timeEntries.filter((e) => e.userId === userId && e.spentOn === fromDate);
  const made = src.map((e) => {
    const copy: TimeEntry = {
      ...e, id: uid("te"), spentOn: toDateStr,
      durationSeconds: withDurations ? e.durationSeconds : 0,
      timerStartedAt: undefined, startedAt: undefined, endedAt: undefined, invoiceId: undefined,
    };
    db.timeEntries.push(copy);
    return copy;
  });
  save();
  return delay(made);
}

/** Bulk upsert of a week grid row. One round trip instead of thirty. */
export async function saveWeekCell(args: {
  userId: ID; projectId: ID; taskId: ID; notes?: string; spentOn: string; seconds: number;
}) {
  load();
  const match = db.timeEntries.find(
    (e) => e.userId === args.userId && e.projectId === args.projectId &&
      e.taskId === args.taskId && e.spentOn === args.spentOn && (e.notes ?? "") === (args.notes ?? "")
  );
  if (args.seconds <= 0) {
    if (match) db.timeEntries.splice(db.timeEntries.indexOf(match), 1);
    save(); return delay(null);
  }
  if (match) { match.durationSeconds = args.seconds; save(); return delay(match); }
  return createTimeEntry({
    userId: args.userId, projectId: args.projectId, taskId: args.taskId,
    spentOn: args.spentOn, durationSeconds: args.seconds, notes: args.notes,
  }).then((r) => r.entry);
}

/* ================================================================ expenses */

export async function listExpenses(q: { from?: string; to?: string; userId?: ID; projectId?: ID } = {}) {
  load();
  return delay(db.expenses.filter((e) => {
    if (q.from && e.spentOn < q.from) return false;
    if (q.to && e.spentOn > q.to) return false;
    if (q.userId && e.userId !== q.userId) return false;
    if (q.projectId && e.projectId !== q.projectId) return false;
    return true;
  }));
}

export async function createExpense(input: Omit<Expense, "id">) {
  load(); const e: Expense = { ...input, id: uid("ex") }; db.expenses.push(e); save(); return delay(e);
}
export async function updateExpense(id: ID, patch: Partial<Expense>) {
  load(); const i = db.expenses.findIndex((e) => e.id === id);
  db.expenses[i] = { ...db.expenses[i]!, ...patch }; save(); return delay(db.expenses[i]!);
}
export async function deleteExpense(id: ID) {
  load(); const i = db.expenses.findIndex((e) => e.id === id);
  const removed = i >= 0 ? db.expenses.splice(i, 1)[0]! : null; save(); return delay(removed);
}

/* ============================================================== approvals */

export async function listSubmissions() { load(); return delay(db.submissions); }

export async function submitTimesheet(userId: ID, periodStart: string) {
  load();
  const end = isoDate(addDays(toDate(periodStart), 6));
  const total = db.timeEntries
    .filter((e) => e.userId === userId && e.spentOn >= periodStart && e.spentOn <= end)
    .reduce((a, b) => a + b.durationSeconds, 0);
  const existing = db.submissions.find((s) => s.userId === userId && s.periodStart === periodStart);
  const sub: TimesheetSubmission = existing ?? {
    id: uid("sub"), userId, periodStart, periodEnd: end, state: "submitted",
    totalSeconds: total, flags: [],
  };
  sub.state = "submitted"; sub.submittedAt = new Date().toISOString(); sub.totalSeconds = total;
  if (!existing) db.submissions.push(sub);
  save();
  return delay(sub);
}

export async function reviewSubmission(id: ID, state: "approved" | "changes_requested", note?: string) {
  load();
  const s = db.submissions.find((x) => x.id === id)!;
  s.state = state; s.reviewedAt = new Date().toISOString(); s.reviewedBy = CURRENT_USER_ID; s.reviewNote = note;
  save();
  return delay(s);
}

/* ================================================================ projects */

export async function getProject(id: ID) { load(); return delay(db.projects.find((p) => p.id === id) ?? null); }

export async function createProject(input: Partial<Project> & { name: string; clientId: ID }) {
  load();
  const p: Project = {
    id: uid("p"), billingType: "time_and_materials", billBy: "people",
    budgetBy: "none", budgetResetsMonthly: false, tags: [],
    colorIndex: (db.projects.length % 12) + 1,
    taskIds: db.tasks.filter((t) => t.isCommon).map((t) => t.id),
    memberIds: [CURRENT_USER_ID], managerIds: [CURRENT_USER_ID],
    ...input,
  };
  db.projects.unshift(p); save(); return delay(p);
}

export async function updateProject(id: ID, patch: Partial<Project>) {
  load(); const i = db.projects.findIndex((p) => p.id === id);
  db.projects[i] = { ...db.projects[i]!, ...patch }; save(); return delay(db.projects[i]!);
}

export async function archiveProject(id: ID, archived = true) {
  return updateProject(id, { archivedAt: archived ? new Date().toISOString() : undefined });
}

export async function togglePin(id: ID) {
  load();
  const i = db.pinnedProjectIds.indexOf(id);
  if (i >= 0) db.pinnedProjectIds.splice(i, 1); else db.pinnedProjectIds.push(id);
  save(); return delay(db.pinnedProjectIds);
}

/* ================================================================= clients */

export async function createClient(input: Partial<Client> & { name: string }) {
  load();
  const c: Client = { id: uid("c"), currency: "USD", paymentTerm: "net_15", contacts: [], ...input };
  db.clients.unshift(c); save(); return delay(c);
}
export async function updateClient(id: ID, patch: Partial<Client>) {
  load(); const i = db.clients.findIndex((c) => c.id === id);
  db.clients[i] = { ...db.clients[i]!, ...patch }; save(); return delay(db.clients[i]!);
}

/* =================================================================== tasks */

export async function createTask(input: Partial<Task> & { name: string }) {
  load();
  const t: Task = { id: uid("t"), defaultBillable: true, isCommon: false, ...input };
  db.tasks.push(t); save(); return delay(t);
}
export async function updateTask(id: ID, patch: Partial<Task>) {
  load(); const i = db.tasks.findIndex((t) => t.id === id);
  db.tasks[i] = { ...db.tasks[i]!, ...patch }; save(); return delay(db.tasks[i]!);
}

/* ==================================================================== people */

export async function updateUser(id: ID, patch: Partial<User>) {
  load(); const i = db.users.findIndex((u) => u.id === id);
  db.users[i] = { ...db.users[i]!, ...patch }; save(); return delay(db.users[i]!);
}

/* ================================================================ invoices */

export async function listInvoices() { load(); return delay(db.invoices); }
export async function getInvoice(id: ID) { load(); return delay(db.invoices.find((i) => i.id === id) ?? null); }
export async function listRecurringInvoices() { load(); return delay(db.recurringInvoices); }
export async function listRetainers() { load(); return delay(db.retainers); }

export async function updateInvoice(id: ID, patch: Partial<Invoice>) {
  load(); const i = db.invoices.findIndex((x) => x.id === id);
  db.invoices[i] = { ...db.invoices[i]!, ...patch }; save(); return delay(db.invoices[i]!);
}

export async function recordPayment(id: ID, amountCents: number, paidAt: string) {
  load();
  const inv = db.invoices.find((x) => x.id === id)!;
  inv.payments.push({ id: uid("pay"), invoiceId: id, amountCents, paidAt, recordedBy: CURRENT_USER_ID });
  inv.paidCents += amountCents;
  inv.state = inv.paidCents >= inv.totalCents ? "paid" : "partial";
  if (inv.state === "paid") inv.paidAt = paidAt;
  inv.events.unshift({ id: uid("ev"), invoiceId: id, kind: "payment", label: "Payment received.", actorId: CURRENT_USER_ID, at: new Date().toISOString(), amountCents });
  save();
  return delay(inv);
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

export async function getUninvoiced(
  clientId: ID,
  opts: { from?: string; to?: string; groupBy?: "project" | "task" | "person" } = {}
): Promise<UninvoicedLine[]> {
  load();
  const groupBy = opts.groupBy ?? "project";
  const projects = db.projects.filter((p) => p.clientId === clientId);
  const projectIds = new Set(projects.map((p) => p.id));

  const buckets = new Map<string, UninvoicedLine>();

  for (const e of db.timeEntries) {
    if (!projectIds.has(e.projectId)) continue;
    if (!e.isBillable || e.invoiceId || e.billedExternally || e.timerStartedAt) continue;
    if (opts.from && e.spentOn < opts.from) continue;
    if (opts.to && e.spentOn > opts.to) continue;

    const project = db.projects.find((p) => p.id === e.projectId)!;
    const detail =
      groupBy === "task" ? db.tasks.find((t) => t.id === e.taskId)?.name ?? "Task"
      : groupBy === "person" ? (() => { const u = db.users.find((x) => x.id === e.userId); return u ? `${u.firstName} ${u.lastName}` : "Person"; })()
      : "";
    const key = `time:${e.projectId}:${groupBy === "project" ? "" : detail}:${e.billableRateCents}`;

    const cur = buckets.get(key) ?? {
      key, projectId: e.projectId, kind: "time" as const,
      label: project.name,
      sublabel: detail || "Billable time",
      quantity: 0, unitPriceCents: e.billableRateCents, amountCents: 0,
      entryIds: [], expenseIds: [],
    };
    cur.quantity += e.durationSeconds / 3600;
    cur.amountCents += secondsToCents(e.durationSeconds, e.billableRateCents);
    cur.entryIds.push(e.id);
    buckets.set(key, cur);
  }

  for (const x of db.expenses) {
    if (!projectIds.has(x.projectId)) continue;
    if (!x.isBillable || x.invoiceId) continue;
    if (opts.from && x.spentOn < opts.from) continue;
    if (opts.to && x.spentOn > opts.to) continue;

    const project = db.projects.find((p) => p.id === x.projectId)!;
    const category = db.expenseCategories.find((c) => c.id === x.categoryId)?.name ?? "Expense";
    const key = `expense:${x.projectId}:${x.categoryId}`;
    const cur = buckets.get(key) ?? {
      key, projectId: x.projectId, kind: "expense" as const,
      label: project.name, sublabel: category,
      quantity: 0, unitPriceCents: 0, amountCents: 0,
      entryIds: [], expenseIds: [],
    };
    cur.quantity += 1;
    cur.amountCents += x.totalCents;
    cur.unitPriceCents = cur.amountCents / Math.max(1, cur.quantity);
    cur.expenseIds.push(x.id);
    buckets.set(key, cur);
  }

  const lines = [...buckets.values()]
    .map((l) => ({ ...l, quantity: Math.round(l.quantity * 100) / 100 }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.sublabel.localeCompare(b.sublabel));
  return delay(lines);
}

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

export async function createInvoice(input: CreateInvoiceInput) {
  load();
  const client = db.clients.find((c) => c.id === input.clientId)!;
  const seq = db.invoices.length + 1;
  const id = uid("inv");
  const code = client.name.slice(0, 3).toUpperCase().replace(/[^A-Z]/g, "X");

  const lineItems: InvoiceLineItem[] = input.lines.map((l, i) => ({
    id: uid("il"), invoiceId: id, position: i,
    itemType: l.kind === "expense" ? "Expense" : "Service",
    projectId: l.projectId,
    description: l.sublabel && l.sublabel !== "Billable time" ? `${l.label}: ${l.sublabel}` : l.label,
    quantity: l.quantity,
    unitPriceCents: Math.round(l.unitPriceCents),
    amountCents: Math.round(l.amountCents),
    isTaxed: l.kind !== "expense",
  }));

  const subtotal = lineItems.reduce((a, b) => a + b.amountCents, 0);
  const discountCents = Math.round(subtotal * ((input.discountPercent ?? 0) / 100));
  const taxable = lineItems.filter((l) => l.isTaxed).reduce((a, b) => a + b.amountCents, 0) - discountCents;
  const taxCents = Math.round(Math.max(0, taxable) * ((input.taxPercent ?? 0) / 100));

  const invoice: Invoice = {
    id, clientId: input.clientId,
    number: `${71300 + seq}-${code}-${seq}`,
    subject: input.subject?.trim() || undefined,
    notes: input.notes?.trim() || undefined,
    poNumber: input.poNumber?.trim() || undefined,
    currency: client.currency,
    issueDate: input.issueDate, dueDate: input.dueDate,
    state: "draft",
    subtotalCents: subtotal,
    taxPercent: input.taxPercent, taxCents,
    discountPercent: input.discountPercent, discountCents,
    totalCents: subtotal - discountCents + taxCents,
    paidCents: 0,
    projectIds: [...new Set(input.lines.map((l) => l.projectId))],
    lineItems, payments: [],
    events: [{ id: uid("ev"), invoiceId: id, kind: "created", label: "Invoice created.", actorId: CURRENT_USER_ID, at: new Date().toISOString() }],
  };

  // Claim the underlying records so the same hour cannot be billed twice.
  const entryIds = new Set(input.lines.flatMap((l) => l.entryIds));
  const expenseIds = new Set(input.lines.flatMap((l) => l.expenseIds));
  for (const e of db.timeEntries) if (entryIds.has(e.id)) e.invoiceId = id;
  for (const x of db.expenses) if (expenseIds.has(x.id)) x.invoiceId = id;

  db.invoices.unshift(invoice);
  save();
  return delay(invoice);
}

export async function deleteInvoice(id: ID) {
  load();
  for (const e of db.timeEntries) if (e.invoiceId === id) e.invoiceId = undefined;
  for (const x of db.expenses) if (x.invoiceId === id) x.invoiceId = undefined;
  db.invoices = db.invoices.filter((i) => i.id !== id);
  save();
  return delay(true);
}

export async function markInvoiceSent(id: ID) {
  load();
  const inv = db.invoices.find((x) => x.id === id)!;
  inv.state = "sent"; inv.sentAt = new Date().toISOString();
  inv.events.unshift({ id: uid("ev"), invoiceId: id, kind: "sent", label: "Invoice marked as sent.", actorId: CURRENT_USER_ID, at: inv.sentAt });
  save();
  return delay(inv);
}

/* ================================================================ search */

export interface SearchHit { type: "project" | "client" | "person" | "invoice" | "task"; id: ID; label: string; sub?: string }

export async function search(q: string): Promise<SearchHit[]> {
  load();
  const s = q.trim().toLowerCase();
  if (!s) return [];
  const match = (t: string) => t.toLowerCase().includes(s);
  const out: SearchHit[] = [];
  for (const p of db.projects) {
    if (p.archivedAt) continue;
    const c = db.clients.find((x) => x.id === p.clientId);
    if (match(p.name) || (c && match(c.name)) || (p.code && match(p.code))) {
      out.push({ type: "project", id: p.id, label: p.name, sub: c?.name });
    }
  }
  for (const c of db.clients) if (match(c.name)) out.push({ type: "client", id: c.id, label: c.name });
  for (const u of db.users) if (match(`${u.firstName} ${u.lastName}`) || match(u.email)) {
    out.push({ type: "person", id: u.id, label: `${u.firstName} ${u.lastName}`, sub: u.roles.join(", ") });
  }
  for (const i of db.invoices) if (match(i.number) || match(i.subject ?? "")) {
    const c = db.clients.find((x) => x.id === i.clientId);
    out.push({ type: "invoice", id: i.id, label: i.number, sub: c?.name });
  }
  for (const t of db.tasks) if (match(t.name)) out.push({ type: "task", id: t.id, label: t.name });
  return delay(out.slice(0, 40));
}

/* ============================================================== the store */

/** Escape hatch for computed views that need the whole dataset at once
 *  (reports, project summaries). The real app computes these server-side. */
export function snapshot(): DB { load(); return db; }
export { startOfWeek };
