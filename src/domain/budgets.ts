/**
 * Budgets.
 *
 * `budget_by` decides two things at once: the unit (hours or currency) and the
 * grain (whole project, per task, per person). Conflating those is how a
 * budget bar ends up showing 340% because it compared hours against a fee.
 *
 * Specification: docs/BACKEND_PRD.md section 4.6.
 */

import type { Cents } from "./money";

export type BudgetBy =
  | "project_hours"
  | "project_fees"
  | "task_hours"
  | "task_fees"
  | "person_hours"
  | "none";

export type BudgetUnit = "hours" | "currency" | "none";
export type BudgetGrain = "project" | "task" | "person" | "none";
export type BudgetHealth = "none" | "ok" | "near" | "over";

export const budgetUnit = (by: BudgetBy): BudgetUnit =>
  by === "none" ? "none" : by.endsWith("_fees") ? "currency" : "hours";

export const budgetGrain = (by: BudgetBy): BudgetGrain =>
  by === "none" ? "none" : by.startsWith("project_") ? "project" : by.startsWith("task_") ? "task" : "person";

/**
 * Health thresholds. Under 80% is fine, 80 to 100% wants attention, over 100%
 * is over. The bands come from FRONTEND_PRD section 2 so the meter colours and
 * this function cannot disagree.
 */
export function budgetHealth(percentUsed: number | null): BudgetHealth {
  if (percentUsed == null) return "none";
  if (percentUsed > 1) return "over";
  if (percentUsed >= 0.8) return "near";
  return "ok";
}

export interface BudgetView {
  by: BudgetBy;
  unit: BudgetUnit;
  grain: BudgetGrain;
  /** Seconds for an hours budget, cents for a fees budget. Null when unbudgeted. */
  budget: number | null;
  spent: number;
  remaining: number | null;
  percentUsed: number | null;
  health: BudgetHealth;
  /** True when "spent" covers only the current calendar month. */
  monthly: boolean;
}

export interface BudgetInput {
  by: BudgetBy;
  budgetSeconds: number | null;
  budgetFeeCents: Cents | null;
  resetsMonthly: boolean;
  /** Seconds tracked in the relevant window at the relevant grain. */
  spentSeconds: number;
  /** Billable value tracked in the relevant window at the relevant grain. */
  spentCents: Cents;
}

export function computeBudget(input: BudgetInput): BudgetView {
  const unit = budgetUnit(input.by);
  const grain = budgetGrain(input.by);

  const budget = unit === "hours" ? input.budgetSeconds : unit === "currency" ? input.budgetFeeCents : null;
  const spent = unit === "currency" ? input.spentCents : input.spentSeconds;

  const percentUsed = budget && budget > 0 ? spent / budget : null;

  return {
    by: input.by,
    unit,
    grain,
    budget: budget ?? null,
    spent,
    remaining: budget == null ? null : budget - spent,
    percentUsed,
    health: budgetHealth(percentUsed),
    monthly: input.resetsMonthly,
  };
}

/**
 * Validates that the populated column matches `budget_by`.
 *
 * The database CHECK forbids both columns being set at once, but it cannot know
 * that `project_hours` requires the seconds column specifically: that is a
 * cross-column rule, and for task and person grain it is cross-table. So it
 * lives here and every write path calls it.
 */
export function validateBudgetShape(input: {
  by: BudgetBy;
  budgetSeconds: number | null;
  budgetFeeCents: Cents | null;
}): { ok: true } | { ok: false; field: "budgetSeconds" | "budgetFeeCents" | "budgetBy"; message: string } {
  const unit = budgetUnit(input.by);

  if (unit === "none") {
    if (input.budgetSeconds != null || input.budgetFeeCents != null) {
      return { ok: false, field: "budgetBy", message: "A budget amount was given but no budget type was chosen." };
    }
    return { ok: true };
  }

  if (unit === "hours") {
    if (input.budgetFeeCents != null) {
      return { ok: false, field: "budgetFeeCents", message: "An hours budget cannot carry a fee amount." };
    }
    if (input.budgetSeconds == null) {
      return { ok: false, field: "budgetSeconds", message: "An hours budget needs a number of hours." };
    }
    if (input.budgetSeconds <= 0) {
      return { ok: false, field: "budgetSeconds", message: "A budget must be greater than zero." };
    }
    return { ok: true };
  }

  if (input.budgetSeconds != null) {
    return { ok: false, field: "budgetSeconds", message: "A fee budget cannot carry an hours amount." };
  }
  if (input.budgetFeeCents == null) {
    return { ok: false, field: "budgetFeeCents", message: "A fee budget needs an amount." };
  }
  if (input.budgetFeeCents <= 0) {
    return { ok: false, field: "budgetFeeCents", message: "A budget must be greater than zero." };
  }
  return { ok: true };
}

/**
 * The thresholds an alert fires at, and whether this reading crosses one.
 *
 * Alerts fire once per crossing per budget period. Dropping back under clears
 * the marker, so a later re-crossing alerts again; that is deliberate, because
 * a budget that crosses 80% three times in a month is three separate pieces of
 * news.
 */
export function crossedThreshold(
  previousPercent: number | null,
  currentPercent: number | null,
  alertPercent: number | null
): number | null {
  if (currentPercent == null) return null;
  const thresholds = [alertPercent != null ? alertPercent / 100 : null, 1].filter(
    (t): t is number => t != null && t > 0
  );
  for (const t of thresholds.sort((a, b) => b - a)) {
    if (currentPercent >= t && (previousPercent == null || previousPercent < t)) return t;
  }
  return null;
}
