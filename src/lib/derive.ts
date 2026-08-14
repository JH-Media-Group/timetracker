/**
 * Derived figures: budgets, spend, uninvoiced, profitability.
 *
 * These implement the formulas in docs/BACKEND_PRD.md section 4. In production
 * they run in SQL and arrive on the wire; here they run over the mock store so
 * the UI can be built and tested against the same numbers.
 *
 * The money rule is enforced throughout: aggregate `seconds * rate_cents` first
 * and divide by 3600 exactly once, at the end. Dividing per row and summing
 * afterwards accumulates rounding error across thousands of entries.
 */

import type { Expense, Invoice, Project, TimeEntry, User } from "./types";

/**
 * The value of one entry's time.
 *
 * Correct for a single row and wrong for a set of them: rounding each entry and
 * adding the results accumulates error in one direction, and the server does
 * not do that, so the two would disagree by a growing number of cents. Use
 * `sumValue` for anything with more than one row in it.
 */
export const secondsToCents = (seconds: number, rateCents: number) =>
  Math.round((seconds * rateCents) / 3600);

/**
 * The value of many entries' time: sum the products, divide once at the end.
 *
 * This is the same rule as `sumSecondsToCents` in `src/domain/money.ts` and the
 * `ROUND(SUM(seconds * rate) / 3600)` in every report query. All three have to
 * agree to the cent, because a person reading a total on one screen and an
 * invoice built from another will notice if they do not.
 */
export function sumValue<T>(
  rows: Iterable<T>,
  seconds: (row: T) => number,
  rateCents: (row: T) => number
): number {
  let product = 0;
  for (const row of rows) product += seconds(row) * rateCents(row);
  return Math.round(product / 3600);
}

/** An accumulator for the same rule, when the rows arrive one at a time. */
export class ValueAccumulator {
  private product = 0;
  add(seconds: number, rateCents: number) { this.product += seconds * rateCents; }
  get cents() { return Math.round(this.product / 3600); }
}

/* ------------------------------------------------------------------ budgets */

/**
 * Re-exported from the domain rather than reimplemented.
 *
 * There were two of these: this one, which the app used, and the one in
 * `src/domain/budgets.ts`, which nothing called. Both compared against a
 * hard-coded 0.8, so fixing TALLY-37 in one place would have left the bug
 * sitting in the other, waiting for whichever caller found it first.
 */
import { budgetHealth, DEFAULT_ALERT_PERCENT, type BudgetHealth } from "@/domain/budgets";

export { budgetHealth, DEFAULT_ALERT_PERCENT, type BudgetHealth };

export interface BudgetView {
  kind: "hours" | "fees" | "none";
  /** Seconds for an hour budget, cents for a fee budget. */
  budget: number | null;
  spent: number;
  remaining: number | null;
  percentUsed: number | null;
  health: BudgetHealth;
  resetsMonthly: boolean;
}

export function projectBudget(project: Project, entries: TimeEntry[], monthOnly?: { from: string; to: string }): BudgetView {
  const scoped = project.budgetResetsMonthly && monthOnly
    ? entries.filter((e) => e.spentOn >= monthOnly.from && e.spentOn <= monthOnly.to)
    : entries;

  // The project's own alert threshold, not a constant (TALLY-37).
  const alertPercent = project.budgetAlertPercent ?? null;

  if (project.budgetBy === "project_hours" && project.budgetSeconds) {
    const spent = scoped.reduce((a, e) => a + e.durationSeconds, 0);
    const pct = spent / project.budgetSeconds;
    return { kind: "hours", budget: project.budgetSeconds, spent, remaining: project.budgetSeconds - spent, percentUsed: pct, health: budgetHealth(pct, alertPercent), resetsMonthly: project.budgetResetsMonthly };
  }
  if (project.budgetBy === "project_fees" && project.budgetFeeCents) {
    const spent = sumValue(scoped, (e) => e.durationSeconds, (e) => e.billableRateCents ?? 0);
    const pct = spent / project.budgetFeeCents;
    return { kind: "fees", budget: project.budgetFeeCents, spent, remaining: project.budgetFeeCents - spent, percentUsed: pct, health: budgetHealth(pct, alertPercent), resetsMonthly: project.budgetResetsMonthly };
  }
  const spent = sumValue(scoped, (e) => e.durationSeconds, (e) => e.billableRateCents ?? 0);
  return { kind: "none", budget: null, spent, remaining: null, percentUsed: null, health: "none", resetsMonthly: false };
}

/* ------------------------------------------------------------- project view */

export interface ProjectSummary {
  totalSeconds: number;
  billableSeconds: number;
  nonBillableSeconds: number;
  billableCents: number;      // hours x billable rate ("if billed hourly")
  costCents: number;          // hours x cost rate + expenses
  expenseCents: number;
  invoicedCents: number;
  uninvoicedCents: number;
  budget: BudgetView;
}

export function projectSummary(
  project: Project,
  entries: TimeEntry[],
  expenses: Expense[],
  invoices: Invoice[],
  monthWindow?: { from: string; to: string },
): ProjectSummary {
  const mine = entries.filter((e) => e.projectId === project.id);
  const myExp = expenses.filter((e) => e.projectId === project.id);
  const billable = mine.filter((e) => e.isBillable);

  const totalSeconds = mine.reduce((a, e) => a + e.durationSeconds, 0);
  const billableSeconds = billable.reduce((a, e) => a + e.durationSeconds, 0);
  const billableCents = sumValue(billable, (e) => e.durationSeconds, (e) => e.billableRateCents ?? 0);
  const timeCostCents = sumValue(mine, (e) => e.durationSeconds, (e) => e.costRateCents ?? 0);
  const expenseCents = myExp.reduce((a, e) => a + e.totalCents, 0);

  const invoicedCents = invoices
    .filter((i) => i.projectIds.includes(project.id) && i.state !== "draft")
    .reduce((a, i) => a + i.totalCents, 0);

  // Uninvoiced: not attached to an invoice, and not marked billed before migration.
  let uninvoicedCents: number;
  if (project.billingType === "fixed_fee") {
    const fees = project.feeCents ?? 0;
    uninvoicedCents = Math.max(0, fees - invoicedCents);       // floored: over-billing is not a negative receivable
  } else {
    uninvoicedCents = sumValue(
      billable.filter((e) => !e.invoiceId && !e.billedExternally),
      (e) => e.durationSeconds,
      (e) => e.billableRateCents ?? 0
    )
      + myExp.filter((e) => e.isBillable && !e.invoiceId).reduce((a, e) => a + e.totalCents, 0);
  }

  return {
    totalSeconds, billableSeconds,
    nonBillableSeconds: totalSeconds - billableSeconds,
    billableCents,
    costCents: timeCostCents + expenseCents,
    expenseCents,
    invoicedCents,
    uninvoicedCents,
    budget: projectBudget(project, mine, monthWindow),
  };
}

/* ------------------------------------------------------------ profitability */

export interface ProfitRow {
  id: string; name: string; sub?: string;
  revenueCents: number; costCents: number; profitCents: number;
  marginPct: number | null; returnOnCostPct: number | null;
  archived?: boolean; missingRate?: boolean;
}

export function profitFor(revenueCents: number, costCents: number): Pick<ProfitRow, "profitCents" | "marginPct" | "returnOnCostPct"> {
  const profitCents = revenueCents - costCents;
  return {
    profitCents,
    marginPct: revenueCents > 0 ? profitCents / revenueCents : null,
    returnOnCostPct: costCents > 0 ? profitCents / costCents : null,
  };
}

/**
 * Revenue on the accrual ("tracked time") basis.
 * T&M: billable hours x rate, plus billable expenses.
 * Fixed fee: the fee recognised to date, which for this mock is the whole fee
 * once any time exists on the project.
 */
export function projectRevenue(project: Project, entries: TimeEntry[], expenses: Expense[]): number {
  if (project.billingType === "non_billable") return 0;
  if (project.billingType === "fixed_fee") return project.feeCents ?? 0;
  return sumValue(entries.filter((e) => e.isBillable), (e) => e.durationSeconds, (e) => e.billableRateCents ?? 0)
    + expenses.filter((e) => e.isBillable).reduce((a, e) => a + e.totalCents, 0);
}

export function projectCost(entries: TimeEntry[], expenses: Expense[]): number {
  return sumValue(entries, (e) => e.durationSeconds, (e) => e.costRateCents ?? 0)
    + expenses.reduce((a, e) => a + e.totalCents, 0);
}

/* ------------------------------------------------------------- utilization */

export interface UtilizationRow {
  user: User;
  totalSeconds: number;
  billableSeconds: number;
  capacitySeconds: number;
  utilization: number;
  costCents: number;
}

export function utilization(users: User[], entries: TimeEntry[], weeks = 1): UtilizationRow[] {
  return users.map((user) => {
    const mine = entries.filter((e) => e.userId === user.id);
    const totalSeconds = mine.reduce((a, e) => a + e.durationSeconds, 0);
    const billableSeconds = mine.filter((e) => e.isBillable).reduce((a, e) => a + e.durationSeconds, 0);
    const capacitySeconds = user.weeklyCapacitySeconds * weeks;
    return {
      user, totalSeconds, billableSeconds, capacitySeconds,
      utilization: capacitySeconds ? totalSeconds / capacitySeconds : 0,
      costCents: sumValue(mine, (e) => e.durationSeconds, (e) => e.costRateCents ?? 0),
    };
  });
}

/* ---------------------------------------------------------------- grouping */

export function groupBy<T, K extends string>(rows: T[], key: (row: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = out.get(k);
    if (list) list.push(r); else out.set(k, [r]);
  }
  return out;
}

export function sumBy<T>(rows: T[], value: (row: T) => number): number {
  return rows.reduce((a, r) => a + value(r), 0);
}

/** Live elapsed seconds for a running entry: committed duration plus the time
 *  since the timer started. Computed from the server timestamp, never from a
 *  client-side counter, so a sleeping laptop cannot drift. */
export function liveSeconds(entry: { durationSeconds: number; timerStartedAt?: string }, now = Date.now()): number {
  if (!entry.timerStartedAt) return entry.durationSeconds;
  return entry.durationSeconds + Math.max(0, Math.round((now - new Date(entry.timerStartedAt).getTime()) / 1000));
}
