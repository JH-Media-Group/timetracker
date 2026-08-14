/**
 * Deterministic fictional fixtures for local development.
 * Names, contact details, rates, dates, and budgets are synthetic.
 */

import type {
  Client, Expense, ExpenseCategory, Invoice, InvoiceLineItem, Project,
  RecurringInvoice, Retainer, Settings, Task, TimeEntry, TimesheetSubmission, User,
} from "@/lib/types";
import { defaultLabels, INVOICE_APPEARANCE, INVOICE_DEFAULTS } from "@/domain/invoice-config";

/* ---------------------------------------------------------------- utilities */

/** mulberry32: tiny seeded PRNG, so the dataset never shifts between reloads. */
function rng(seed: number) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20260813);
const pick = <T,>(arr: readonly T[]) => arr[Math.floor(rand() * arr.length)]!;
const between = (lo: number, hi: number) => lo + rand() * (hi - lo);

/* Local calendar date, not UTC. `toISOString()` would shift the day for anyone
   east of Greenwich: local midnight on the 14th is 21:00 UTC on the 13th. */
export const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

/**
 * The app's "today", and it has to be the real one.
 *
 * The sample data is generated backwards from this date, so pinning it to a
 * fixed day means that the moment the wall clock moves past it the timesheet
 * opens on an empty week while the rest of the app (period pickers, the date
 * a new expense defaults to, an invoice's issue date) is still using the real
 * clock. Two clocks, and everything looks a day stale.
 *
 * Normalised to local midnight so day comparisons are exact. The PRNG is still
 * seeded, so the data's shape is identical every time; only the dates move.
 */
export const TODAY = (() => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
})();

/* -------------------------------------------------------------------- users */

const P = (h: number, s = 62, l = 52) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${h} ${s}% ${l + 12}%)"/><stop offset="1" stop-color="hsl(${h} ${s}% ${l - 10}%)"/></linearGradient></defs><rect width="100" height="100" fill="url(%23g)"/><circle cx="50" cy="38" r="17" fill="hsl(30 45% 82%)"/><path d="M19 100c0-19 14-30 31-30s31 11 31 30z" fill="hsl(${h} ${s}% ${l - 26}%)"/></svg>`
  )}`;

export const users: User[] = [
  { id: "u1", firstName: "Sample", lastName: "Person01", email: "person01@example.com", photo: P(212), employmentType: "employee", profile: "administrator", isOwner: true, roles: ["Project Manager"], departments: ["Leadership"], weeklyCapacitySeconds: 144000, timezone: "America/New_York", billableRateCents: 10500, costRateCents: 2100, startedOn: "2024-01-01" },
  { id: "u2", firstName: "Sample", lastName: "Person02", email: "person02@example.com", photo: P(160), employmentType: "employee", profile: "administrator", roles: ["Designer", "Project Manager"], departments: ["Design"], weeklyCapacitySeconds: 144000, timezone: "Europe/Paris", billableRateCents: 11000, costRateCents: 2200, startedOn: "2024-01-01" },
  { id: "u3", firstName: "Sample", lastName: "Person03", email: "person03@example.com", photo: P(330), employmentType: "employee", profile: "administrator", roles: ["Developer", "Project Manager"], departments: ["Engineering"], weeklyCapacitySeconds: 126000, timezone: "America/New_York", billableRateCents: 11500, costRateCents: 2300, startedOn: "2024-01-01" },
  { id: "u4", firstName: "Sample", lastName: "Person04", email: "person04@example.com", employmentType: "employee", profile: "member", roles: ["Designer"], departments: ["Design"], weeklyCapacitySeconds: 144000, timezone: "Asia/Karachi", billableRateCents: 12000, costRateCents: 2400, startedOn: "2024-01-01" },
  { id: "u5", firstName: "Sample", lastName: "Person05", email: "person05@example.com", photo: P(268), employmentType: "contractor", profile: "member", roles: ["Designer"], departments: ["Design"], weeklyCapacitySeconds: 144000, timezone: "Europe/Bucharest", billableRateCents: 12500, costRateCents: 2500, startedOn: "2024-01-01" },
  { id: "u6", firstName: "Sample", lastName: "Person06", email: "person06@example.com", photo: P(12), employmentType: "contractor", profile: "member", roles: ["Designer"], departments: ["Design"], weeklyCapacitySeconds: 144000, timezone: "Asia/Karachi", billableRateCents: 13000, costRateCents: 2600, startedOn: "2024-01-01" },
  { id: "u7", firstName: "Sample", lastName: "Person07", email: "person07@example.com", photo: P(140), employmentType: "contractor", profile: "administrator", roles: ["Developer"], departments: ["Engineering"], weeklyCapacitySeconds: 144000, timezone: "Europe/London", billableRateCents: 13500, costRateCents: 2700, startedOn: "2024-01-01" },
  { id: "u8", firstName: "Sample", lastName: "Person08", email: "person08@example.com", employmentType: "contractor", profile: "project_manager", roles: ["Developer", "Dev PM"], departments: ["Engineering"], weeklyCapacitySeconds: 144000, timezone: "Europe/Bucharest", billableRateCents: 14000, costRateCents: 2800, startedOn: "2024-01-01" },
  { id: "u9", firstName: "Sample", lastName: "Person09", email: "person09@example.com", employmentType: "contractor", profile: "administrator", roles: ["Developer"], departments: ["Engineering"], weeklyCapacitySeconds: 144000, timezone: "Europe/Bucharest", billableRateCents: 14500, costRateCents: 2900, startedOn: "2024-01-01" },
  { id: "u10", firstName: "Sample", lastName: "Person10", email: "person10@example.com", photo: P(96), employmentType: "contractor", profile: "member", roles: ["Designer"], departments: ["Design"], weeklyCapacitySeconds: 144000, timezone: "Asia/Karachi", billableRateCents: 15000, costRateCents: 3000, startedOn: "2024-01-01" },
  { id: "u11", firstName: "Sample", lastName: "Person11", email: "person11@example.com", employmentType: "contractor", profile: "member", roles: ["Developer"], departments: ["Engineering"], weeklyCapacitySeconds: 144000, timezone: "Europe/Skopje", billableRateCents: 15500, costRateCents: 3100, startedOn: "2024-01-01" },
];

export const CURRENT_USER_ID = "u1";

/* ------------------------------------------------------------------ clients */

const clientNames = [
  "Example Client 03", "Example Client 04", "Example Client 05",
  "Example Client 06", "Example Client 07", "Example Client 12", "Example Client 14",
  "Example Client 17", "Example Client 18", "Example Client 19",
  "Example Client 22", "Example Client 25", "Example Internal", "Example Client 31",
  "Example Client 30", "Example Client 32", "Example Client 38", "Example Client 39", "Example Client 41", "Example Client 42",
  "Example Client 43", "Example Client 40", "Example Client 45", "Example Client 46", "Example Learning",
  "Example Client 49", "Example Client 50",
];

export const clients: Client[] = clientNames.map((name, i) => ({
  id: `c${i + 1}`,
  name,
  address: i % 3 === 0 ? `${100 + i} Main Street\nSuite ${i + 2}\nAtlanta, GA 30307` : undefined,
  currency: "USD",
  paymentTerm: i % 4 === 0 ? "net_30" : "net_15",
  taxPercent: undefined,
  contacts: i % 3 === 0 ? [{
    id: `ct${i}`, clientId: `c${i + 1}`,
    firstName: pick(["Drew", "Kirk", "Daniel", "Karen", "Paul", "Erin"]),
    lastName: pick(["Edwards", "Pardue", "Rainey", "Wallace", "Nguyen", "Brooks"]),
    title: pick(["CEO", "Director of Marketing", "Operations Lead", "CFO"]),
    email: `contact${i}@example.com`, phone: "(404) 555-0140", isPrimary: true,
  }] : [],
}));

const clientId = (name: string) => clients.find((c) => c.name === name)!.id;

/* -------------------------------------------------------------------- tasks */

const taskNames = [
  ["Account Management", true, true], ["Business Development", false, true],
  ["Consulting", true, true], ["Design", true, true], ["Emails", true, true],
  ["Information Architecture", true, true], ["Marketing", true, true],
  ["Meetings/Collaboration", true, true], ["Non-billable Support", false, true],
  ["Planning & Scoping", true, true], ["Programming", true, true],
  ["Project Management", true, true], ["Research", true, true], ["Testing and QA", true, true],
] as const;

export const tasks: Task[] = taskNames.map(([name, billable, common], i) => ({
  id: `t${i + 1}`, name: name as string,
  defaultBillable: billable as boolean, isCommon: common as boolean,
}));

const taskId = (name: string) => tasks.find((t) => t.name === name)!.id;
const allTaskIds = tasks.map((t) => t.id);

/* ----------------------------------------------------------------- projects */

interface Seed {
  name: string; client: string; billingType: BillingTypeLite; billBy: BillBy2;
  fee?: number; rate?: number; budgetHours?: number; budgetFees?: number;
  monthly?: boolean; members: string[]; managers: string[]; archived?: boolean;
}
type BillingTypeLite = "time_and_materials" | "fixed_fee" | "non_billable";
type BillBy2 = "project" | "tasks" | "people" | "none";

const projectSeeds: Seed[] = [
  { name: "Example Project 01", client: "Example Client 03", billingType: "fixed_fee", billBy: "people", fee: 700000, budgetFees: 700000, members: ["u3", "u5", "u7", "u9", "u10"], managers: ["u1", "u2", "u3"] },
  { name: "Example Project 02", client: "Example Client 04", billingType: "fixed_fee", billBy: "people", fee: 100000, budgetHours: 20, members: ["u6", "u10", "u9"], managers: ["u1", "u2", "u3"] },
  { name: "Example Project 03", client: "Example Client 05", billingType: "time_and_materials", billBy: "people", budgetHours: 20, monthly: true, members: ["u3", "u7"], managers: ["u2"] },
  { name: "Example Project 04", client: "Example Client 06", billingType: "time_and_materials", billBy: "people", budgetHours: 20, members: ["u2", "u7"], managers: ["u2"] },
  { name: "Example Client 07", client: "Example Client 07", billingType: "non_billable", billBy: "none", members: ["u1", "u3"], managers: ["u1"] },
  { name: "Example Project 06", client: "Example Client 12", billingType: "time_and_materials", billBy: "people", budgetFees: 500000, members: ["u3", "u7", "u8", "u9"], managers: ["u3"] },
  { name: "Example Project 07", client: "Example Client 12", billingType: "time_and_materials", billBy: "people", budgetFees: 600000, members: ["u7", "u8"], managers: ["u3"] },
  { name: "Example Project 08", client: "Example Client 12", billingType: "time_and_materials", billBy: "people", budgetFees: 700000, members: ["u3", "u7", "u8", "u9", "u11"], managers: ["u3"] },
  { name: "Example Project 09", client: "Example Client 12", billingType: "time_and_materials", billBy: "people", budgetHours: 20, monthly: true, members: ["u7", "u8"], managers: ["u3"] },
  { name: "Example Project 10", client: "Example Client 14", billingType: "time_and_materials", billBy: "people", members: ["u7", "u3", "u11"], managers: ["u3"] },
  { name: "Example Project 11", client: "Example Client 17", billingType: "time_and_materials", billBy: "people", budgetHours: 20, monthly: true, members: ["u3"], managers: ["u2"] },
  { name: "Example Project 12", client: "Example Client 18", billingType: "fixed_fee", billBy: "people", fee: 400000, members: ["u3", "u7"], managers: ["u2"] },
  { name: "Example Project 13", client: "Example Client 19", billingType: "time_and_materials", billBy: "people", members: ["u3", "u7"], managers: ["u2"] },
  { name: "Example Project 14", client: "Example Client 22", billingType: "fixed_fee", billBy: "people", fee: 600000, members: ["u7", "u9"], managers: ["u3"] },
  { name: "Example Project 15", client: "Example Client 25", billingType: "time_and_materials", billBy: "people", members: ["u2", "u3"], managers: ["u2"] },
  { name: "Example Project 16", client: "Example Internal", billingType: "non_billable", billBy: "none", members: ["u1", "u2", "u3"], managers: ["u1"] },
  { name: "Example Project 17", client: "Example Internal", billingType: "non_billable", billBy: "none", members: ["u1", "u2", "u4"], managers: ["u1"] },
  { name: "Operations", client: "Example Internal", billingType: "non_billable", billBy: "none", members: users.map((u) => u.id), managers: ["u1"] },
  { name: "Example Project 19", client: "Example Client 30", billingType: "fixed_fee", billBy: "people", fee: 400000, members: ["u2", "u6", "u7"], managers: ["u2"] },
  { name: "Example Project 20", client: "Example Client 32", billingType: "time_and_materials", billBy: "people", budgetHours: 20, monthly: true, members: ["u3"], managers: ["u2"] },
  { name: "Example Project 21", client: "Example Client 38", billingType: "time_and_materials", billBy: "people", budgetFees: 600000, members: ["u7"], managers: ["u3"] },
  { name: "Example Project 22", client: "Example Client 39", billingType: "time_and_materials", billBy: "people", members: ["u7", "u9", "u11"], managers: ["u3"] },
  { name: "Example Project 23", client: "Example Client 39", billingType: "time_and_materials", billBy: "people", members: ["u7", "u9", "u11", "u8"], managers: ["u3"] },
  { name: "Example Project 24", client: "Example Client 41", billingType: "non_billable", billBy: "none", members: ["u1", "u3"], managers: ["u1"] },
  { name: "Example Project 25", client: "Example Client 42", billingType: "time_and_materials", billBy: "people", members: ["u3", "u7"], managers: ["u2"] },
  { name: "Example Project 26", client: "Example Client 43", billingType: "time_and_materials", billBy: "people", budgetFees: 400000, members: ["u3", "u7"], managers: ["u3"] },
  { name: "Example Client 40", client: "Example Client 40", billingType: "time_and_materials", billBy: "people", members: ["u2", "u3", "u7"], managers: ["u2"] },
  { name: "Example Client 40 plan", client: "Example Learning", billingType: "time_and_materials", billBy: "people", budgetHours: 20, monthly: true, members: ["u2", "u6"], managers: ["u2"] },
  { name: "Hosting", client: "Example Client 49", billingType: "fixed_fee", billBy: "people", fee: 700000, members: ["u7"], managers: ["u3"] },
  { name: "Example Project 30", client: "Example Client 50", billingType: "fixed_fee", billBy: "people", fee: 100000, members: ["u1"], managers: ["u1"] },
];

export const projects: Project[] = projectSeeds.map((s, i) => ({
  id: `p${i + 1}`,
  clientId: clientId(s.client),
  name: s.name,
  code: i % 5 === 0 ? `JH-${1000 + i}` : undefined,
  billingType: s.billingType,
  billBy: s.billBy,
  hourlyRateCents: s.rate,
  feeCents: s.fee,
  feeCadence: s.fee ? (s.monthly ? "monthly" : "single") : undefined,
  budgetBy: s.budgetHours ? "project_hours" : s.budgetFees ? "project_fees" : "none",
  budgetSeconds: s.budgetHours ? Math.round(s.budgetHours * 3600) : undefined,
  budgetFeeCents: s.budgetFees,
  budgetResetsMonthly: !!s.monthly,
  budgetAlertPercent: s.budgetHours || s.budgetFees ? 80 : undefined,
  tags: i % 4 === 0 ? ["retainer"] : i % 7 === 0 ? ["fixed"] : [],
  colorIndex: (i % 12) + 1,
  taskIds: allTaskIds,
  memberIds: s.members,
  managerIds: s.managers,
  archivedAt: s.archived ? "2025-06-30" : undefined,
}));

/* Archived projects, so the Projects list has a realistic archived bucket. */
for (let i = 0; i < 46; i++) {
  projects.push({
    id: `pa${i + 1}`,
    clientId: clients[i % clients.length]!.id,
    name: `${pick(["Website", "Retainer", "Campaign", "Migration", "Support", "Rebuild"])} ${2021 + (i % 4)}`,
    billingType: "time_and_materials", billBy: "people",
    budgetBy: "none", budgetResetsMonthly: false,
    tags: [], colorIndex: (i % 12) + 1,
    taskIds: allTaskIds, memberIds: ["u3", "u7"], managerIds: ["u2"],
    archivedAt: `${2022 + (i % 4)}-1${i % 2}-01`,
  });
}

/* --------------------------------------------------------------- time entries */

const noteBank = [
  "Calendar sync options and empty screen changes", "Wish list flows",
  "New homepage, all scrollable sections", "Sprint planning and estimates",
  "Client call and follow-up notes", "Bug triage from staging",
  "Component library cleanup", "Invoice template revisions",
  "Data migration dry run", "Accessibility pass on the checkout",
  "Weekly status report", "Design QA on the mobile breakpoints", "",
];

const activeProjects = projects.filter((p) => !p.archivedAt);
export const timeEntries: TimeEntry[] = [];

let entryN = 0;
for (let dayOffset = 168; dayOffset >= 0; dayOffset--) {
  const date = addDays(TODAY, -dayOffset);
  const dow = date.getDay();
  if (dow === 0 || dow === 6) { if (rand() > 0.12) continue; }

  for (const user of users) {
    // The signed-in user always has this week filled in. Opening the app on an
    // empty day is a poor first impression, and it hides half the day view.
    const alwaysLogs = user.id === CURRENT_USER_ID && dayOffset <= 4 && dow !== 0 && dow !== 6;
    if (!alwaysLogs && rand() > 0.72) continue;        // not everyone logs every day
    const myProjects = activeProjects.filter((p) => p.memberIds.includes(user.id));
    if (!myProjects.length) continue;
    const count = 1 + Math.floor(rand() * 3);
    let clockMinutes = 9 * 60 + Math.floor(rand() * 60);

    for (let k = 0; k < count; k++) {
      const project = pick(myProjects);
      const tId = pick(project.taskIds);
      const task = tasks.find((t) => t.id === tId)!;
      const minutes = Math.round(between(25, 240) / 5) * 5;
      const start = new Date(date); start.setHours(0, clockMinutes, 0, 0);
      const end = new Date(start.getTime() + minutes * 60000);
      clockMinutes += minutes + 15;
      const billable = project.billingType !== "non_billable" && task.defaultBillable;

      timeEntries.push({
        id: `te${++entryN}`,
        userId: user.id,
        projectId: project.id,
        taskId: tId,
        spentOn: iso(date),
        startedAt: start.toISOString(),
        endedAt: end.toISOString(),
        durationSeconds: minutes * 60,
        notes: pick(noteBank),
        isBillable: billable,
        billableRateCents: billable ? user.billableRateCents : 0,
        costRateCents: user.costRateCents,
        billedExternally: dayOffset > 60 && billable && rand() > 0.35,
      });
    }
  }
}

/* ------------------------------------------------------------------ expenses */

export const expenseCategories: ExpenseCategory[] = [
  { id: "ec1", name: "Ad spend" }, { id: "ec2", name: "Entertainment" },
  { id: "ec3", name: "Hosting" }, { id: "ec4", name: "Lodging" },
  { id: "ec5", name: "Meals" },
  { id: "ec6", name: "Mileage", unitName: "mile", unitPriceCents: 45 },
  { id: "ec7", name: "Other" }, { id: "ec8", name: "Sales" },
  { id: "ec9", name: "Transportation" }, { id: "ec10", name: "Website Maintenance" },
];

export const expenses: Expense[] = Array.from({ length: 38 }, (_, i) => {
  const date = addDays(TODAY, -Math.floor(rand() * 150));
  const cat = pick(expenseCategories);
  const units = cat.unitPriceCents ? Math.round(between(20, 180)) : undefined;
  const user = pick(users);
  const project = pick(activeProjects.filter((p) => p.memberIds.includes(user.id)) || activeProjects);
  return {
    id: `ex${i + 1}`,
    userId: user.id,
    projectId: (project ?? activeProjects[0]!).id,
    categoryId: cat.id,
    spentOn: iso(date),
    units,
    totalCents: units ? units * cat.unitPriceCents! : Math.round(between(999, 116400)),
    notes: pick(["Seamless.ai year subscription", "Pipedrive for the sales team", "Transcription system",
      "FindThatLead top-up", "Client lunch", "Domain renewal", "Stock photography", ""]),
    isBillable: rand() > 0.6,
    isReimbursable: rand() > 0.7,
    reimbursementState: rand() > 0.5 ? "pending" : "paid",
    receiptName: rand() > 0.4 ? "receipt.pdf" : undefined,
  };
});

/* --------------------------------------------------------------- submissions */

export const submissions: TimesheetSubmission[] = [];
{
  const monday = addDays(TODAY, -(((TODAY.getDay() + 6) % 7)));
  for (let w = 1; w <= 6; w++) {
    const start = addDays(monday, -7 * w);
    for (const u of users) {
      if (rand() > 0.8) continue;
      const total = Math.round(between(18, 42) * 3600);
      submissions.push({
        id: `sub-${u.id}-${iso(start)}`,
        userId: u.id, periodStart: iso(start), periodEnd: iso(addDays(start, 6)),
        state: w === 1 ? (rand() > 0.5 ? "submitted" : "approved") : "approved",
        submittedAt: addDays(start, 7).toISOString(),
        reviewedBy: w === 1 ? undefined : "u1",
        totalSeconds: total,
        flags: rand() > 0.7 ? ["2 gaps"] : [],
      });
    }
  }
}

/* ----------------------------------------------------------------- invoices */

const invStates: Array<Invoice["state"]> = ["paid", "sent", "late", "draft", "partial"];
export const invoices: Invoice[] = [];
{
  let n = 0;
  for (let m = 0; m < 40; m++) {
    const client = clients[m % clients.length]!;
    const issue = addDays(TODAY, -Math.floor(between(2, 260)));
    const due = addDays(issue, 15);
    const state: Invoice["state"] =
      m % 9 === 0 ? "draft" : due < TODAY && m % 3 === 0 ? "late" : pick(invStates);
    const lineCount = 1 + Math.floor(rand() * 3);
    const proj = activeProjects.find((p) => p.clientId === client.id);
    const items: InvoiceLineItem[] = Array.from({ length: lineCount }, (_, li) => {
      const qty = Math.round(between(1, 12));
      const unit = Math.round(between(15000, 900000) / 100) * 100;
      return {
        id: `il${n}-${li}`, invoiceId: `inv${n + 1}`, position: li, itemType: "Service", isTime: true,
        projectId: proj?.id,
        description: pick(["Design Completion", "Development Completion", "Monthly Support Plan",
          "Hosting and Maintenance", "Discovery and Planning", "UX Design Services"]),
        quantity: qty, unitPriceCents: unit, amountCents: qty * unit, isTaxed: false,
      };
    });
    const subtotal = items.reduce((a, b) => a + b.amountCents, 0);
    const paid = state === "paid" ? subtotal : state === "partial" ? Math.round(subtotal * 0.4) : 0;
    n++;
    invoices.push({
      id: `inv${n}`, clientId: client.id,
      number: `${71300 + n}-${client.name.slice(0, 3).toUpperCase().replace(/[^A-Z]/g, "X")}-${n}`,
      subject: pick(["Monthly Support Plan", "Website Maintenance Plan", "Hosting", "Project milestone", ""]),
      currency: "USD", issueDate: iso(issue), dueDate: iso(due), state,
      subtotalCents: subtotal, taxCents: 0, discountCents: 0,
      totalCents: subtotal, paidCents: paid,
      sentAt: state === "draft" ? undefined : issue.toISOString(),
      paidAt: state === "paid" ? addDays(issue, 20).toISOString() : undefined,
      projectIds: proj ? [proj.id] : [],
      lineItems: items,
      payments: paid ? [{ id: `pay${n}`, invoiceId: `inv${n}`, amountCents: paid, paidAt: addDays(issue, 20).toISOString(), method: "ACH", recordedBy: "u3" }] : [],
      events: [
        { id: `ev${n}a`, invoiceId: `inv${n}`, kind: "created", label: "Invoice created.", actorId: "u3", at: issue.toISOString() },
        ...(state !== "draft" ? [{ id: `ev${n}b`, invoiceId: `inv${n}`, kind: "sent", label: "Invoice marked as sent.", actorId: "u3", at: issue.toISOString() }] : []),
        ...(paid ? [{ id: `ev${n}c`, invoiceId: `inv${n}`, kind: "payment", label: `Payment received.`, actorId: "u2", at: addDays(issue, 20).toISOString(), amountCents: paid }] : []),
      ],
    });
  }
}

/** One schedule, with the fields every row shares. */
function r(
  id: string,
  client: string,
  subject: string,
  frequency: RecurringInvoice["frequency"],
  amountCents: number,
  nextIssueOn: string
): RecurringInvoice {
  return {
    id,
    clientId: clientId(client),
    subject,
    frequency,
    interval: 1,
    startsOn: nextIssueOn,
    nextIssueOn,
    amountCents,
    state: "active",
    sendAutomatically: false,
    paymentTermDays: 30,
    lines: [{ description: subject, quantity: 1, unitPriceCents: amountCents }],
  };
}

export const recurringInvoices: RecurringInvoice[] = [
  // `interval` counts periods, not months: quarterly at 1 is every three
  // months. It was `intervalMonths` until schedules became editable, and
  // quarterly carried a 3 there, which under the new name would read as every
  // nine months.
  r("ri1", "Example Client 43", "Maintenance Plan", "monthly", 50000, "2026-09-01"),
  r("ri2", "Example Client 19", "Maintenance and Health Support Monthly Plan", "monthly", 50000, "2026-09-01"),
  r("ri3", "Example Client 42", "Website Maintenance Plan", "monthly", 50000, "2026-09-01"),
  r("ri4", "Example Client 31", "Example Client 40 | Enhanced Support Package", "monthly", 50000, "2026-09-01"),
  r("ri5", "Example Client 32", "Hosting", "quarterly", 50000, "2026-10-01"),
  { ...r("ri6", "Example Learning", "Support Plan - Maintenance - Example Client 40", "monthly", 50000, "2026-09-01"), state: "paused", nextIssueOn: undefined },
];

export const retainers: Retainer[] = [
  { id: "r1", clientId: clientId("Example Client 04"), balanceCents: 420000, transactions: [
    { id: "rt1", kind: "add", amountCents: 1000000, at: "2026-03-01T12:00:00Z", note: "Q2 retainer" },
    { id: "rt2", kind: "draw", amountCents: 580000, at: "2026-06-01T12:00:00Z", invoiceId: "inv2" },
  ] },
];

/* ----------------------------------------------------------------- settings */

export const settings: Settings = {
  invoiceLabels: defaultLabels(),
  invoiceAppearance: INVOICE_APPEARANCE,
  invoiceDefaults: INVOICE_DEFAULTS,
  companyName: "JH Media Group Inc.",
  taxId: "",
  companyAddress: "245 N. Highland Ave\nSuite 230-185\nAtlanta GA\n30307",
  baseCurrency: "USD",
  timezone: "America/New_York",
  weekStartsOn: 1,
  timerMode: "start_end",
  timeDisplay: "decimal",
  roundingMinutes: 0,
  requireNotes: "never",
  allowFutureDates: true,
  flagMissingBelowSeconds: 0,
  modules: {
    time: true, expenses: true, approvals: true, team: true,
    invoices: true, activityLog: true,
  },
};

export const tags = ["retainer", "fixed", "rush", "internal"];
export const roles = ["Business Developer", "Designer", "Dev PM", "Developer", "Digital Marketer", "Marketer", "Project Manager", "QA", "Sales", "Social Media", "Writer"];
export const departments = ["Design", "Engineering", "Leadership", "Marketing"];
