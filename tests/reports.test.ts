/**
 * Reports.
 *
 * The tests that earn their keep here are the arithmetic ones. A report that is
 * merely present is worthless; a report whose totals disagree with its rows, or
 * whose money drifts by a cent per entry, is worse than absent because somebody
 * will invoice from it.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDb, db, resetDb, s } from "./helpers";
import { newId } from "@/server/db/ids";
import { syncBaseProfiles } from "@/server/auth/profiles";
import { createCtx, type Actor, type Ctx } from "@/server/ctx";
import { BASE_PROFILES, type Capability } from "@/server/auth/capabilities";
import { invalidateSettings } from "@/server/services/settings";
import {
  invoicingReport, profitabilityReport, projectSummary, teamReport, timeReport,
} from "@/server/services/reports";

let profiles: Record<string, string>;
let admin: string;
let member: string;
let clientId: string;
let tmProject: string;
let fixedProject: string;
let designTask: string;
let ptTm: string;
let ptFixed: string;

const TODAY = "2026-08-14";

function ctxFor(userId: string, key: keyof typeof BASE_PROFILES): Ctx {
  const actor: Actor = {
    userId,
    profileId: profiles[key]!,
    baseKey: key,
    capabilities: new Set(BASE_PROFILES[key].capabilities as readonly Capability[]),
    kind: "user",
    timezone: "America/New_York",
    isOwner: key === "administrator",
  };
  return createCtx({ actor, now: () => new Date(`${TODAY}T15:00:00Z`) });
}

async function addEntry(userId: string, projectTaskId: string, projectId: string, opts: {
  spentOn?: string; seconds: number; billableRate: number; costRate: number; isBillable?: boolean;
}) {
  await db.insert(s.timeEntries).values({
    id: newId(),
    userId,
    projectId,
    projectTaskId,
    spentOn: opts.spentOn ?? TODAY,
    durationSeconds: opts.seconds,
    isBillable: opts.isBillable ?? true,
    billableRateCents: opts.billableRate,
    costRateCents: opts.costRate,
  });
}

beforeEach(async () => {
  await resetDb();
  invalidateSettings();
  profiles = (await syncBaseProfiles(db)).ids;

  await db.insert(s.settings).values({
    id: 1, companyName: "JH Media Group", timezone: "America/New_York",
  });

  admin = newId();
  member = newId();
  await db.insert(s.users).values([
    { id: admin, email: "admin@jhmediagroup.com", firstName: "Admin", lastName: "A", profileId: profiles.administrator!, weeklyCapacitySeconds: 144000 },
    { id: member, email: "member@jhmediagroup.com", firstName: "Member", lastName: "M", profileId: profiles.member!, weeklyCapacitySeconds: 144000 },
  ]);

  clientId = newId();
  await db.insert(s.clients).values({ id: clientId, name: "Test Client" });

  tmProject = newId();
  fixedProject = newId();
  await db.insert(s.projects).values([
    { id: tmProject, clientId, name: "T&M", billingType: "time_and_materials", billBy: "people" },
    {
      id: fixedProject, clientId, name: "Fixed", billingType: "fixed_fee", billBy: "none",
      feeCents: 1_000_000, feeCadence: "single", startsOn: "2026-01-01", endsOn: "2026-12-31",
    },
  ]);

  designTask = newId();
  await db.insert(s.tasks).values({ id: designTask, name: "Design" });

  ptTm = newId();
  ptFixed = newId();
  await db.insert(s.projectTasks).values([
    { id: ptTm, projectId: tmProject, taskId: designTask, isBillable: true },
    { id: ptFixed, projectId: fixedProject, taskId: designTask, isBillable: false },
  ]);

  await db.insert(s.projectMembers).values([
    { id: newId(), projectId: tmProject, userId: admin, isManager: true },
    { id: newId(), projectId: tmProject, userId: member },
    { id: newId(), projectId: fixedProject, userId: admin, isManager: true },
  ]);
});

afterAll(async () => {
  await closeDb();
});

/* ============================================================ time report */

describe("the time report", () => {
  it("agrees with itself across every grouping", async () => {
    const ctx = ctxFor(admin, "administrator");
    await addEntry(admin, ptTm, tmProject, { seconds: 3600, billableRate: 15000, costRate: 6000 });
    await addEntry(member, ptTm, tmProject, { seconds: 7200, billableRate: 9000, costRate: 3000 });
    await addEntry(admin, ptFixed, fixedProject, { seconds: 1800, billableRate: 0, costRate: 6000, isBillable: false });

    const period = { from: "2026-08-01", to: "2026-08-31" };
    const byClient = await timeReport(ctx, { ...period, groupBy: "client" });
    const byProject = await timeReport(ctx, { ...period, groupBy: "project" });
    const byTask = await timeReport(ctx, { ...period, groupBy: "task" });
    const byUser = await timeReport(ctx, { ...period, groupBy: "user" });

    // A total that changes with the grouping is a total nobody can trust.
    for (const report of [byProject, byTask, byUser]) {
      expect(report.totals.totalSeconds).toBe(byClient.totals.totalSeconds);
      expect(report.totals.billableCents).toBe(byClient.totals.billableCents);
    }

    expect(byClient.totals.totalSeconds).toBe(3600 + 7200 + 1800);
    // 1h at $150 plus 2h at $90 = $330.00
    expect(byClient.totals.billableCents).toBe(33000);
    expect(byClient.totals.nonBillableSeconds).toBe(1800);
  });

  it("sums the rows to the totals exactly", async () => {
    const ctx = ctxFor(admin, "administrator");
    for (let i = 0; i < 20; i += 1) {
      await addEntry(admin, ptTm, tmProject, { seconds: 100 + i, billableRate: 12345, costRate: 6789 });
    }

    const report = await timeReport(ctx, { from: "2026-08-01", to: "2026-08-31", groupBy: "project" });
    const rowSum = report.rows.reduce((a, r) => a + r.billableCents, 0);
    expect(rowSum).toBe(report.totals.billableCents);
  });

  it("divides once, at the end, rather than per row", async () => {
    const ctx = ctxFor(admin, "administrator");

    // Seven 100-second entries at $123.45/h. Per row that is 342.9 cents, which
    // rounds to 343 and sums to 2401. The honest total is 2400.42, so 2400.
    for (let i = 0; i < 7; i += 1) {
      await addEntry(admin, ptTm, tmProject, { seconds: 100, billableRate: 12345, costRate: 0 });
    }

    const report = await timeReport(ctx, { from: "2026-08-01", to: "2026-08-31", groupBy: "project" });
    expect(report.totals.billableCents).toBe(2400);
  });

  it("scopes a Member to their own time", async () => {
    const ctx = ctxFor(member, "member");
    await addEntry(admin, ptTm, tmProject, { seconds: 3600, billableRate: 15000, costRate: 6000 });
    await addEntry(member, ptTm, tmProject, { seconds: 7200, billableRate: 9000, costRate: 3000 });

    const report = await timeReport(ctx, { from: "2026-08-01", to: "2026-08-31", groupBy: "user" });
    expect(report.rows).toHaveLength(1);
    expect(report.totals.totalSeconds).toBe(7200);
  });
});

/* ======================================================= profitability */

describe("the profitability report", () => {
  it("computes revenue, cost, and margin for time and materials", async () => {
    const ctx = ctxFor(admin, "administrator");
    // 10 hours at $150 billable, $60 cost.
    await addEntry(admin, ptTm, tmProject, { seconds: 36000, billableRate: 15000, costRate: 6000 });

    const report = await profitabilityReport(ctx, { from: "2026-08-01", to: "2026-08-31", groupBy: "project" });
    const row = report.rows.find((r) => r.name === "T&M")!;

    expect(row.revenueCents).toBe(150000);
    expect(row.costCents).toBe(60000);
    expect(row.profitCents).toBe(90000);
    expect(row.marginPct).toBeCloseTo(0.6);
  });

  it("recognises a fixed fee across the project window rather than billing the hours", async () => {
    const ctx = ctxFor(admin, "administrator");
    // Fixed-fee time carries a zero billable rate; the fee is the revenue.
    await addEntry(admin, ptFixed, fixedProject, { seconds: 36000, billableRate: 0, costRate: 6000, isBillable: false });

    const report = await profitabilityReport(ctx, { from: "2026-08-01", to: "2026-08-31", groupBy: "project" });
    const row = report.rows.find((r) => r.name === "Fixed")!;

    // 31 of 365 days of a $10,000 fee.
    expect(row.revenueCents).toBe(Math.round((1_000_000 * 31) / 365));
    expect(row.costCents).toBe(60000);
  });

  it("flags billable time that has no rate rather than reporting it as free", async () => {
    const ctx = ctxFor(admin, "administrator");
    await addEntry(admin, ptTm, tmProject, { seconds: 3600, billableRate: 0, costRate: 6000, isBillable: true });

    const report = await profitabilityReport(ctx, { from: "2026-08-01", to: "2026-08-31", groupBy: "project" });
    expect(report.flags.some((f) => f.kind === "missing_billable_rate")).toBe(true);
    expect(report.rows.find((r) => r.name === "T&M")!.missingBillableRate).toBe(true);
  });

  it("counts an expense once, not once per time entry", async () => {
    const ctx = ctxFor(admin, "administrator");
    // The classic join bug: three entries and one expense would report the
    // expense three times if both were joined in a single aggregate.
    await addEntry(admin, ptTm, tmProject, { seconds: 3600, billableRate: 10000, costRate: 5000 });
    await addEntry(admin, ptTm, tmProject, { seconds: 3600, billableRate: 10000, costRate: 5000 });
    await addEntry(admin, ptTm, tmProject, { seconds: 3600, billableRate: 10000, costRate: 5000 });

    const categoryId = newId();
    await db.insert(s.expenseCategories).values({ id: categoryId, name: "Travel" });
    await db.insert(s.expenses).values({
      id: newId(), userId: admin, projectId: tmProject, categoryId,
      spentOn: TODAY, totalCents: 50000, isBillable: true,
    });

    const report = await profitabilityReport(ctx, { from: "2026-08-01", to: "2026-08-31", groupBy: "project" });
    const row = report.rows.find((r) => r.name === "T&M")!;

    expect(row.revenueCents).toBe(30000 + 50000);
    expect(row.costCents).toBe(15000 + 50000);
  });

  it("refuses a Member entirely", async () => {
    const ctx = ctxFor(member, "member");
    await expect(
      profitabilityReport(ctx, { from: "2026-08-01", to: "2026-08-31" })
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});

/* ============================================================ team report */

describe("the team report", () => {
  it("computes utilization against capacity for the period", async () => {
    const ctx = ctxFor(admin, "administrator");
    // A week is 40 hours of capacity. 20 hours tracked is 50%.
    await addEntry(admin, ptTm, tmProject, { seconds: 20 * 3600, billableRate: 15000, costRate: 6000 });

    const report = await teamReport(ctx, { from: "2026-08-10", to: "2026-08-16" });
    const row = report.rows.find((r) => r.userId === admin)!;

    expect(row.capacitySeconds).toBe(144000);
    expect(row.utilization).toBeCloseTo(0.5);
    expect(row.billableShare).toBe(1);
  });

  it("hides cost from anybody without the capability", async () => {
    await addEntry(admin, ptTm, tmProject, { seconds: 3600, billableRate: 15000, costRate: 6000 });

    const asAdmin = await teamReport(ctxFor(admin, "administrator"), { from: "2026-08-10", to: "2026-08-16" });
    expect(asAdmin.rows.find((r) => r.userId === admin)!.costCents).toBe(6000);

    const asExec = await teamReport(ctxFor(admin, "executive_manager"), { from: "2026-08-10", to: "2026-08-16" });
    expect(asExec.rows.find((r) => r.userId === admin)!.costCents).toBe(0);
  });
});

/* ======================================================= invoicing report */

describe("the invoicing report", () => {
  beforeEach(async () => {
    await db.insert(s.invoices).values([
      {
        id: newId(), clientId, number: "A-1", issueDate: "2026-08-01", dueDate: "2026-08-31",
        state: "open", totalCents: 100000, paidCents: 0,
      },
      {
        id: newId(), clientId, number: "A-2", issueDate: "2026-06-01", dueDate: "2026-06-15",
        state: "open", totalCents: 50000, paidCents: 20000,
      },
      {
        id: newId(), clientId, number: "A-3", issueDate: "2026-08-05", dueDate: "2026-09-05",
        state: "paid", totalCents: 75000, paidCents: 75000,
      },
    ]);
  });

  it("buckets outstanding invoices by how late they are", async () => {
    const ctx = ctxFor(admin, "administrator");
    const report = await invoicingReport(ctx, { from: "2026-08-01", to: "2026-08-31" });

    // A-1 is due at the end of the month, so it is current.
    expect(report.aging.find((a) => a.bucket === "Current")!.amountCents).toBe(100000);
    // A-2 was due 15 June, sixty days before 14 August.
    expect(report.aging.find((a) => a.bucket === "31 to 60 days")!.amountCents).toBe(30000);
  });

  it("separates issued in the period from outstanding overall", async () => {
    const ctx = ctxFor(admin, "administrator");
    const report = await invoicingReport(ctx, { from: "2026-08-01", to: "2026-08-31" });

    expect(report.totals.issuedCents).toBe(100000 + 75000);
    expect(report.totals.outstandingCents).toBe(100000 + 30000);
    expect(report.totals.overdueCents).toBe(30000);
  });

  it("derives late from the due date rather than storing it", async () => {
    const ctx = ctxFor(admin, "administrator");
    const report = await invoicingReport(ctx, { from: "2026-01-01", to: "2026-12-31" });

    expect(report.rows.find((r) => r.number === "A-1")!.displayState).toBe("sent");
    expect(report.rows.find((r) => r.number === "A-2")!.displayState).toBe("late");
    expect(report.rows.find((r) => r.number === "A-3")!.displayState).toBe("paid");
  });
});

/* ======================================================== project summary */

describe("the project summary", () => {
  it("splits hours, values them, and computes what is left to invoice", async () => {
    const ctx = ctxFor(admin, "administrator");
    await addEntry(admin, ptTm, tmProject, { seconds: 3600, billableRate: 15000, costRate: 6000 });
    await addEntry(admin, ptTm, tmProject, { seconds: 1800, billableRate: 0, costRate: 6000, isBillable: false });

    const summary = await projectSummary(ctx, tmProject);

    expect(summary.totalSeconds).toBe(5400);
    expect(summary.billableSeconds).toBe(3600);
    expect(summary.nonBillableSeconds).toBe(1800);
    expect(summary.billableCents).toBe(15000);
    expect(summary.costCents).toBe(9000); // 1.5h at $60
    expect(summary.uninvoicedCents).toBe(15000);
  });

  it("floors a fixed-fee project at zero rather than showing a negative receivable", async () => {
    const ctx = ctxFor(admin, "administrator");
    await addEntry(admin, ptFixed, fixedProject, { seconds: 3600, billableRate: 0, costRate: 6000, isBillable: false });

    // Invoiced beyond the fee.
    const invoiceId = newId();
    await db.insert(s.invoices).values({
      id: invoiceId, clientId, number: "OVER-1", issueDate: TODAY, dueDate: "2026-09-14",
      state: "open", totalCents: 1_500_000,
    });
    await db.insert(s.invoiceProjects).values({ invoiceId, projectId: fixedProject });

    const summary = await projectSummary(ctx, fixedProject);
    expect(summary.invoicedCents).toBe(1_500_000);
    expect(summary.uninvoicedCents).toBe(0);
  });

  it("scopes a monthly budget to the current month", async () => {
    const ctx = ctxFor(admin, "administrator");
    await db
      .update(s.projects)
      .set({ budgetBy: "project_hours", budgetSeconds: 36000, budgetResetsMonthly: true })
      .where(eqProject(tmProject));

    await addEntry(admin, ptTm, tmProject, { spentOn: "2026-07-15", seconds: 18000, billableRate: 15000, costRate: 6000 });
    await addEntry(admin, ptTm, tmProject, { spentOn: "2026-08-05", seconds: 7200, billableRate: 15000, costRate: 6000 });

    const summary = await projectSummary(ctx, tmProject);

    // Total hours cover the whole project; the budget only counts August.
    expect(summary.totalSeconds).toBe(25200);
    expect(summary.budget.spent).toBe(7200);
    expect(summary.budget.monthly).toBe(true);
    expect(summary.budget.percentUsed).toBeCloseTo(0.2);
  });
});

import { eq } from "drizzle-orm";
const eqProject = (id: string) => eq(s.projects.id, id);
