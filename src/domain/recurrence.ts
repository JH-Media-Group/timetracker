/**
 * When a recurring invoice next falls due.
 *
 * Small, pure, and separate from the service because the awkward part is
 * calendar arithmetic rather than anything about invoices, and it is the part
 * worth testing exhaustively. Getting it wrong bills a client on the wrong day
 * or, worse, twice.
 *
 * THE ANCHOR, WHICH IS THE WHOLE POINT
 *
 * A schedule that starts on the 31st should read 31 January, 28 February,
 * 31 March. Chaining `addMonths` over the previous result gives 31 January,
 * 28 February, 28 March: February's clamp is inherited and the schedule quietly
 * walks backwards until it settles on the 28th forever. So every occurrence is
 * computed from a stored anchor day rather than from the date before it, and
 * the clamp is applied fresh each month.
 *
 * `addMonths` in `calendar.ts` clamps correctly for a single hop and is the
 * right tool there. It is the wrong tool for a sequence.
 */

import { type IsoDate, endOfMonth } from "./calendar";

export type Frequency = "weekly" | "monthly" | "quarterly" | "yearly";

/** How many months one period covers. Weekly is handled separately. */
const MONTHS: Record<Exclude<Frequency, "weekly">, number> = {
  monthly: 1,
  quarterly: 3,
  yearly: 12,
};

const split = (date: IsoDate) => date.split("-").map(Number) as [number, number, number];

/** The day of the month a schedule anchors to, taken from where it starts. */
export const anchorDayOf = (startsOn: IsoDate): number => split(startsOn)[2];

/** The ISO weekday a weekly schedule anchors to, 1 = Monday through 7 = Sunday. */
export function anchorWeekdayOf(startsOn: IsoDate): number {
  const [y, m, d] = split(startsOn);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow === 0 ? 7 : dow;
}

/**
 * The occurrence one period after `from`.
 *
 * `from` is a date the schedule actually landed on, and `anchorDay` is the day
 * it wants to land on, which may be later in the month than February allows.
 *
 * A month that is too short takes its last day. That is the defensible reading
 * of "the 31st": the end of the month, not a spill into the next one. The
 * alternative, skipping February entirely, means a client is not billed at all
 * that month, which is worse than being billed a few days early.
 */
export function nextOccurrence(
  from: IsoDate,
  frequency: Frequency,
  interval: number,
  anchorDay: number
): IsoDate {
  const step = Math.max(1, Math.trunc(interval));

  if (frequency === "weekly") {
    const [y, m, d] = split(from);
    const at = new Date(Date.UTC(y, m - 1, d));
    at.setUTCDate(at.getUTCDate() + 7 * step);
    return at.toISOString().slice(0, 10);
  }

  const [y, m] = split(from);
  const monthsForward = MONTHS[frequency] * step;

  // Month arithmetic in a UTC Date, then the anchor clamped to what that month
  // actually has. Day 1 avoids the target month being overshot on the way.
  const target = new Date(Date.UTC(y, m - 1 + monthsForward, 1));
  const iso = target.toISOString().slice(0, 10);
  const lastDay = split(endOfMonth(iso))[2];

  const day = Math.min(anchorDay, lastDay);
  return `${iso.slice(0, 7)}-${String(day).padStart(2, "0")}`;
}

/**
 * The first occurrence strictly after `after`, starting from `from`.
 *
 * Used when resuming a schedule that was paused across one or more periods, and
 * on the first run after an import, where `nextIssueOn` arrives in the past.
 * Both cases want the next date the schedule would naturally land on, not a
 * backfill of everything missed: raising eight months of invoices at once
 * because nobody logged in is a worse failure than being a month late.
 *
 * Bounded, because a schedule anchored decades ago should not spin.
 */
export function nextOccurrenceAfter(
  from: IsoDate,
  frequency: Frequency,
  interval: number,
  anchorDay: number,
  after: IsoDate,
  maxSteps = 1200
): IsoDate {
  let at = from;
  for (let i = 0; i < maxSteps && at <= after; i++) {
    at = nextOccurrence(at, frequency, interval, anchorDay);
  }
  return at;
}

/**
 * Whether a schedule has run out, by either of the two ways it can.
 *
 * `endsOn` and `occurrencesRemaining` are independent and can disagree.
 * **Whichever comes first wins**, which is the reading that never bills
 * somebody after they were told the schedule would stop.
 */
export function hasFinished(
  next: IsoDate | null,
  endsOn: IsoDate | null,
  occurrencesRemaining: number | null
): boolean {
  if (occurrencesRemaining != null && occurrencesRemaining <= 0) return true;
  if (next == null) return true;
  if (endsOn != null && next > endsOn) return true;
  return false;
}
