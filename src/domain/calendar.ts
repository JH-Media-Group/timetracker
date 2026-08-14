/**
 * Calendar days, weeks, and timezones.
 *
 * `spent_on` is a calendar date, not an instant. A timer started at 11:45pm in
 * New York and stopped at 12:30am belongs to the day it started, in the
 * timezone of the person it belongs to, not the server's and not the actor's.
 *
 * Everything here works on `YYYY-MM-DD` strings. Turning a calendar day into a
 * Date to do arithmetic on it is how days shift by one for anyone east of UTC,
 * and it is the single most common bug in software that tracks time.
 *
 * Specification: docs/BACKEND_PRD.md section 4.4.
 */

export type IsoDate = string; // YYYY-MM-DD

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const isIsoDate = (v: unknown): v is IsoDate => typeof v === "string" && DATE_RE.test(v);

export function assertIsoDate(v: unknown, what = "date"): IsoDate {
  if (!isIsoDate(v)) throw new RangeError(`${what} must be YYYY-MM-DD, got ${String(v)}`);
  return v;
}

/**
 * The calendar day an instant falls on, in a named timezone.
 *
 * Uses Intl rather than arithmetic on UTC offsets, so daylight saving,
 * half-hour zones, and historical offset changes are all handled by the
 * platform's timezone database instead of by us.
 */
export function dayIn(timezone: string, at: Date = new Date()): IsoDate {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Clock minutes from midnight for an instant, in a named timezone. */
export function minutesIn(timezone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  return get("hour") * 60 + get("minute");
}

/* ------------------------------------------------------- day arithmetic */

/** Days between two calendar dates, positive when `b` is later. */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  return Math.round((Date.UTC(...split(b)) - Date.UTC(...split(a))) / 86_400_000);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const d = new Date(Date.UTC(...split(date)));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function addMonths(date: IsoDate, months: number): IsoDate {
  const [y, m, day] = split(date);
  const target = new Date(Date.UTC(y, m + months, 1));
  // Clamp: 31 January plus one month is 28 or 29 February, not 3 March.
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

/** ISO weekday, 1 = Monday through 7 = Sunday. */
export function weekday(date: IsoDate): number {
  const dow = new Date(Date.UTC(...split(date))).getUTCDay();
  return dow === 0 ? 7 : dow;
}

/** `weekStartsOn` is ISO: 1 = Monday, 7 = Sunday. */
export function startOfWeek(date: IsoDate, weekStartsOn = 1): IsoDate {
  const current = weekday(date);
  const back = (current - weekStartsOn + 7) % 7;
  return addDays(date, -back);
}

export const endOfWeek = (date: IsoDate, weekStartsOn = 1): IsoDate =>
  addDays(startOfWeek(date, weekStartsOn), 6);

export const startOfMonth = (date: IsoDate): IsoDate => `${date.slice(0, 7)}-01`;

export function endOfMonth(date: IsoDate): IsoDate {
  const [y, m] = split(date);
  return new Date(Date.UTC(y, m + 1, 0)).toISOString().slice(0, 10);
}

export function eachDay(from: IsoDate, to: IsoDate): IsoDate[] {
  const out: IsoDate[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Whole months between two dates, counting only complete ones. */
export function wholeMonthsBetween(from: IsoDate, to: IsoDate): number {
  const [fy, fm, fd] = split(from);
  const [ty, tm, td] = split(to);
  let months = (ty - fy) * 12 + (tm - fm);
  if (td < fd) months -= 1;
  return Math.max(0, months);
}

export const isWeekend = (date: IsoDate): boolean => weekday(date) >= 6;

/** Overlap of two inclusive date ranges, or null when they do not touch. */
export function intersectRange(
  a: { from: IsoDate; to: IsoDate },
  b: { from: IsoDate; to: IsoDate }
): { from: IsoDate; to: IsoDate } | null {
  const from = a.from > b.from ? a.from : b.from;
  const to = a.to < b.to ? a.to : b.to;
  return from <= to ? { from, to } : null;
}

/** Month-scoped window containing `date`, for budgets that reset monthly. */
export const monthWindow = (date: IsoDate) => ({ from: startOfMonth(date), to: endOfMonth(date) });

/* ---------------------------------------------------------------- private */

function split(date: IsoDate): [number, number, number] {
  assertIsoDate(date);
  return [Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))];
}
