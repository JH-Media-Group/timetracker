/**
 * Rate resolution.
 *
 * Runs once, when a time entry is created or when its project, task, person, or
 * date changes, and the result is *stored on the entry*. Rates are snapshots,
 * not lookups: a raise in March must not retroactively rewrite what January
 * cost, and an invoice sent in June must still reconcile in December.
 *
 * Specification: docs/BACKEND_PRD.md section 4.5.
 */

import type { IsoDate } from "./calendar";
import type { Cents } from "./money";

export interface DatedRate {
  kind: "billable" | "cost";
  amountCents: Cents;
  startsOn: IsoDate | null; // null = all prior
  endsOn: IsoDate | null; // null = all future
}

export interface RateInputs {
  project: {
    billingType: "time_and_materials" | "fixed_fee" | "non_billable";
    billBy: "project" | "tasks" | "people" | "none";
    hourlyRateCents: Cents | null;
  };
  projectTask: {
    isBillable: boolean;
    hourlyRateCents: Cents | null;
  };
  task: { defaultHourlyRateCents: Cents | null };
  member: { hourlyRateCents: Cents | null } | null;
  /** The person's dated rates, both kinds, unfiltered. */
  userRates: readonly DatedRate[];
  spentOn: IsoDate;
  /** An explicit override, used by imports carrying Harvest's stored rate. */
  overrideBillableCents?: Cents | null;
}

export interface ResolvedRates {
  billableRateCents: Cents;
  costRateCents: Cents;
  /**
   * True when a billable rate was expected and none was found. The service puts
   * this on the response and the reporting layer surfaces it in the
   * data-quality banner. We never guess a rate.
   */
  rateMissing: boolean;
}

/** The dated rate covering a day, or null. At most one by the exclusion constraint. */
export function rateOn(rates: readonly DatedRate[], kind: "billable" | "cost", on: IsoDate): DatedRate | null {
  for (const r of rates) {
    if (r.kind !== kind) continue;
    if (r.startsOn && on < r.startsOn) continue;
    if (r.endsOn && on > r.endsOn) continue;
    return r;
  }
  return null;
}

/**
 * The billable ladder, in order. Each rung is tried only when the one above it
 * does not apply, and the first two rungs are hard zeroes rather than
 * fallthroughs: non-billable means non-billable.
 */
export function resolveRates(input: RateInputs): ResolvedRates {
  const costRateCents = rateOn(input.userRates, "cost", input.spentOn)?.amountCents ?? 0;

  // 1 and 2: not billable at all.
  if (input.project.billingType === "non_billable" || !input.projectTask.isBillable) {
    return { billableRateCents: 0, costRateCents, rateMissing: false };
  }

  if (input.overrideBillableCents != null) {
    return { billableRateCents: input.overrideBillableCents, costRateCents, rateMissing: false };
  }

  let billableRateCents: Cents | null = null;

  switch (input.project.billBy) {
    case "people":
      billableRateCents =
        input.member?.hourlyRateCents ??
        rateOn(input.userRates, "billable", input.spentOn)?.amountCents ??
        null;
      break;
    case "tasks":
      billableRateCents = input.projectTask.hourlyRateCents ?? input.task.defaultHourlyRateCents ?? null;
      break;
    case "project":
      billableRateCents = input.project.hourlyRateCents ?? null;
      break;
    case "none":
      // A fixed-fee project bills the fee, not the hours. Zero here is correct
      // and expected, so it is not a missing rate.
      return { billableRateCents: 0, costRateCents, rateMissing: false };
  }

  return {
    billableRateCents: billableRateCents ?? 0,
    costRateCents,
    rateMissing: billableRateCents == null,
  };
}

/**
 * Whether a rate change should reach an entry.
 *
 * `rates_locked_at` is set when an entry lands on a sent invoice. After that
 * only an explicit forced re-rate may touch it, because the client has already
 * been billed at the old number.
 */
export const canReRate = (entry: { ratesLockedAt: Date | null }, force = false): boolean =>
  force || entry.ratesLockedAt == null;
