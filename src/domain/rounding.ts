/**
 * Rounding.
 *
 * A presentation and invoicing concern, never a storage concern. What people
 * tracked is what is stored; rounding decides what a client is charged for it.
 *
 * The rule that matters and that naive implementations get wrong: rounding
 * applies **per aggregated group**, not per entry. Ten six-minute entries under
 * fifteen-minute rounding are 1.0 hours, not 2.5. Rounding each entry first and
 * summing afterwards inflates every invoice, and the inflation grows with how
 * granular somebody's tracking habits are, which is the opposite of fair.
 *
 * Specification: docs/BACKEND_PRD.md section 4.3.
 */

export type RoundingMode = "nearest" | "up" | "down";

export interface RoundingRule {
  minutes: number; // 0 = no rounding
  mode: RoundingMode;
}

export const NO_ROUNDING: RoundingRule = { minutes: 0, mode: "nearest" };

/** Rounds a total, in seconds, to the rule's increment. */
export function roundSeconds(totalSeconds: number, rule: RoundingRule): number {
  if (!rule.minutes || rule.minutes <= 0) return totalSeconds;
  const increment = rule.minutes * 60;
  const ratio = totalSeconds / increment;

  const rounded =
    rule.mode === "up" ? Math.ceil(ratio) : rule.mode === "down" ? Math.floor(ratio) : Math.round(ratio);

  return rounded * increment;
}

/**
 * Sum first, round once.
 *
 * The signature takes the whole group rather than a single value so that
 * calling it per entry is awkward, which is the point: the shape of the
 * function discourages the bug.
 */
export function roundGroup(entrySeconds: readonly number[], rule: RoundingRule): number {
  const total = entrySeconds.reduce((a, b) => a + b, 0);
  return roundSeconds(total, rule);
}

/**
 * Where rounding does and does not apply.
 *
 * Exported as data rather than buried in conditionals, so the answer to "is
 * this report rounded?" is one lookup and the list is reviewable.
 */
export const ROUNDING_APPLIES_TO = {
  summaryTimeReport: true,
  invoiceLineGeneration: true,
  ifBilledHourlyColumns: true,

  timesheet: false,
  detailedTimeReport: false,
  utilization: false,
  capacity: false,
  profitabilityCost: false,
} as const satisfies Record<string, boolean>;
