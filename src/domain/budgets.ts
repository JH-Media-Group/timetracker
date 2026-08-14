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
 * The account-wide fallback when a project sets no threshold of its own.
 *
 * FRONTEND_PRD section 2 fixes the meter colours to these bands, so the number
 * lives here rather than being written into each caller.
 */
export const DEFAULT_ALERT_PERCENT = 80;

/**
 * Which band a budget is in: fine, wants attention, or over.
 *
 * `alertPercent` is the project's `budgetAlertPercent`, **as a percentage**
 * (80, not 0.8), because that is how the column stores it and how the editor
 * asks for it. Null means the project never chose one and takes the default.
 *
 * TALLY-37: this took no threshold at all and compared against a hard-coded
 * 0.8, so every project warned at 80% no matter what its editor said. The
 * feature was never missing; one number was written where a column should have
 * been read, which is why nothing looked broken.
 */
export function budgetHealth(
  percentUsed: number | null,
  alertPercent: number | null = null
): BudgetHealth {
  if (percentUsed == null) return "none";
  if (percentUsed > 1) return "over";

  /**
   * The write path holds 1 to 100 (`projectSchema`), so this is a backstop for
   * a row that arrived another way: an import, a hand-edit, an older value from
   * when the schema allowed 0 to 999. Out of range falls back rather than making
   * a project either permanently fine or permanently alarming.
   */
  const percent = alertPercent ?? DEFAULT_ALERT_PERCENT;
  const safe = percent >= 1 && percent <= 100 ? percent : DEFAULT_ALERT_PERCENT;

  return percentUsed >= safe / 100 ? "near" : "ok";
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
  /** The project's own alert threshold as a percentage. Null takes the default. */
  alertPercent?: number | null;
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
    health: budgetHealth(percentUsed, input.alertPercent ?? null),
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
