/**
 * Profitability.
 *
 * Revenue minus internal cost, for a period and a grouping dimension. The hard
 * part is not the subtraction, it is fixed-fee revenue: a fee is earned over a
 * window, and attributing it to a month, a person, or a task requires an
 * explicit allocation choice rather than a convenient one.
 *
 * Every recognition decision here is surfaced in the report's information
 * popover, so the number is never a black box.
 *
 * Specification: docs/BACKEND_PRD.md section 4.7.
 */

import { intersectRange, wholeMonthsBetween, type IsoDate } from "./calendar";
import { assertSafeCents, type Cents } from "./money";

export type FeeAllocation = "evenly" | "by_hours" | "by_billable";
export type RevenueBasis = "tracked" | "invoiced";

export interface ProfitFigures {
  revenueCents: Cents;
  costCents: Cents;
  profitCents: Cents;
  /** Null when revenue is zero: a margin on nothing is not zero, it is undefined. */
  marginPct: number | null;
  /** Null when cost is zero, for the same reason. */
  returnOnCostPct: number | null;
}

export function profitFrom(revenueCents: Cents, costCents: Cents): ProfitFigures {
  const profitCents = assertSafeCents(revenueCents - costCents, "profit");
  return {
    revenueCents,
    costCents,
    profitCents,
    marginPct: revenueCents > 0 ? profitCents / revenueCents : null,
    returnOnCostPct: costCents > 0 ? profitCents / costCents : null,
  };
}

/* -------------------------------------------------- fixed fee recognition */

export interface FeeRecognitionInput {
  feeCents: Cents;
  cadence: "single" | "monthly";
  /** The project's active window. Either end may be missing. */
  startsOn: IsoDate | null;
  endsOn: IsoDate | null;
  /** The reporting period. */
  period: { from: IsoDate; to: IsoDate };
  /** Hours tracked on the project inside the period, and across its whole life. */
  hoursInPeriod: number;
  hoursTotal: number;
}

export interface FeeRecognition {
  cents: Cents;
  /** How the number was arrived at, for the popover. */
  method: "monthly_elapsed" | "window_prorated" | "hours_prorated" | "whole_fee";
  /** True when the project has no dates and recognition had to fall back. */
  missingProjectDates: boolean;
}

/**
 * How much of a fixed fee belongs to this period.
 *
 * Monthly cadence is arithmetic: the monthly fee times the months of the active
 * window that fall inside the period.
 *
 * Single cadence has no natural per-period answer, so there is a preference
 * order. Dates are the honest basis when the project has them, because a fee
 * covers a span of calendar time. Without dates the only signal left is effort,
 * so it pro-rates by hours, and the result is flagged `missingProjectDates` so
 * the report can offer to fix the underlying data rather than quietly guessing
 * forever.
 */
export function recogniseFee(input: FeeRecognitionInput): FeeRecognition {
  const { period } = input;

  if (input.cadence === "monthly") {
    const windowStart = input.startsOn ?? period.from;
    const windowEnd = input.endsOn ?? period.to;
    const overlap = intersectRange({ from: windowStart, to: windowEnd }, period);
    if (!overlap) return { cents: 0, method: "monthly_elapsed", missingProjectDates: !input.startsOn };

    // A month is recognised once it is complete, plus the month in progress.
    const months = wholeMonthsBetween(overlap.from, overlap.to) + 1;
    return {
      cents: assertSafeCents(input.feeCents * months, "recognised fee"),
      method: "monthly_elapsed",
      missingProjectDates: !input.startsOn,
    };
  }

  if (input.startsOn && input.endsOn) {
    const overlap = intersectRange({ from: input.startsOn, to: input.endsOn }, period);
    if (!overlap) return { cents: 0, method: "window_prorated", missingProjectDates: false };

    const totalDays = daysInclusive(input.startsOn, input.endsOn);
    const periodDays = daysInclusive(overlap.from, overlap.to);
    return {
      cents: Math.round((input.feeCents * periodDays) / totalDays),
      method: "window_prorated",
      missingProjectDates: false,
    };
  }

  if (input.hoursTotal > 0) {
    return {
      cents: Math.round((input.feeCents * input.hoursInPeriod) / input.hoursTotal),
      method: "hours_prorated",
      missingProjectDates: true,
    };
  }

  // No dates and no hours: the whole fee, or nothing has happened yet.
  return {
    cents: input.hoursInPeriod > 0 ? input.feeCents : 0,
    method: "whole_fee",
    missingProjectDates: true,
  };
}

/* ------------------------------------------------------------- allocation */

export interface AllocationShare {
  key: string;
  hours: number;
  billableCents: Cents;
  /** For 'evenly': whether this member was active in the period at all. */
  active: boolean;
}

/**
 * Splits an amount across a dimension.
 *
 * The remainder goes to the largest share rather than being dropped, so the
 * parts always sum back to the whole. An allocation that loses three cents is
 * an allocation somebody will eventually have to explain.
 */
export function allocate(
  amountCents: Cents,
  shares: readonly AllocationShare[],
  mode: FeeAllocation
): Map<string, Cents> {
  const out = new Map<string, Cents>();
  if (shares.length === 0 || amountCents === 0) return out;

  const weightOf = (s: AllocationShare): number =>
    mode === "evenly" ? (s.active ? 1 : 0) : mode === "by_hours" ? s.hours : s.billableCents;

  const total = shares.reduce((a, s) => a + weightOf(s), 0);

  if (total <= 0) {
    // Nothing to weight by: fall back to an even split across everyone present,
    // which is at least explicable.
    const per = Math.floor(amountCents / shares.length);
    shares.forEach((s) => out.set(s.key, per));
    const remainder = amountCents - per * shares.length;
    if (remainder !== 0 && shares[0]) out.set(shares[0].key, per + remainder);
    return out;
  }

  let assigned = 0;
  let largest: { key: string; weight: number } | null = null;

  for (const s of shares) {
    const weight = weightOf(s);
    const cents = Math.floor((amountCents * weight) / total);
    out.set(s.key, cents);
    assigned += cents;
    if (!largest || weight > largest.weight) largest = { key: s.key, weight };
  }

  const remainder = amountCents - assigned;
  if (remainder !== 0 && largest) out.set(largest.key, (out.get(largest.key) ?? 0) + remainder);

  return out;
}

/* --------------------------------------------------------- data quality */

export type ProfitabilityFlag =
  | "missing_cost_rate"
  | "missing_billable_rate"
  | "missing_project_dates"
  | "overbilled";

export interface DataQualityFlag {
  kind: ProfitabilityFlag;
  /** The specific entities, so the UI can offer an inline fix. */
  entityIds: string[];
  message: string;
}

export const FLAG_MESSAGES: Record<ProfitabilityFlag, string> = {
  missing_cost_rate: "Some people have no cost rate, so profit is overstated for their time.",
  missing_billable_rate: "Some billable time has no rate, so revenue is understated.",
  missing_project_dates: "Some fixed-fee projects have no dates, so their fee is spread by hours instead.",
  overbilled: "Some projects have been invoiced beyond their fee.",
};

/* ------------------------------------------------------------------ util */

function daysInclusive(from: IsoDate, to: IsoDate): number {
  const a = Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, Number(from.slice(8, 10)));
  const b = Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1, Number(to.slice(8, 10)));
  return Math.round((b - a) / 86_400_000) + 1;
}
