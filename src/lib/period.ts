import {
  addDays, addMonths, endOfMonth, formatDayLong, formatMonthYear, formatWeekRange,
  isoDate, startOfMonth, startOfWeek, toDate,
} from "./format";

export type CalendarGranularity = "day" | "week" | "month" | "quarter" | "year" | "all";
export type Granularity = CalendarGranularity | "custom";
export interface DateRange { from: string; to: string }
export interface Period extends DateRange { granularity: Granularity; label: string }

export function isCalendarDate(value: string): boolean {
  if (!/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) return false;
  // A calendar date must validate identically in every browser's timezone,
  // including zones that skipped a whole local day, such as Apia in 2011.
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function dateRangeError(range: DateRange): string | null {
  if (!isCalendarDate(range.from) || !isCalendarDate(range.to)) return "Choose valid start and end dates.";
  if (range.from > range.to) return "The end date must be on or after the start date.";
  return null;
}

export function resolvePeriod(granularity: Granularity, anchor: Date, custom?: DateRange): Period {
  switch (granularity) {
    case "custom": {
      if (!custom || dateRangeError(custom)) throw new RangeError("Invalid custom date range.");
      return { granularity, from: custom.from, to: custom.to, label: `${custom.from} to ${custom.to}` };
    }
    case "day":
      return { granularity, from: isoDate(anchor), to: isoDate(anchor), label: formatDayLong(anchor) };
    case "week": {
      const s = startOfWeek(anchor);
      return { granularity, from: isoDate(s), to: isoDate(addDays(s, 6)), label: formatWeekRange(s) };
    }
    case "month": {
      const s = startOfMonth(anchor);
      return { granularity, from: isoDate(s), to: isoDate(endOfMonth(anchor)), label: formatMonthYear(anchor) };
    }
    case "quarter": {
      const q = Math.floor(anchor.getMonth() / 3);
      const s = new Date(anchor.getFullYear(), q * 3, 1);
      const e = new Date(anchor.getFullYear(), q * 3 + 3, 0);
      return { granularity, from: isoDate(s), to: isoDate(e), label: `Q${q + 1} ${anchor.getFullYear()}` };
    }
    case "year": {
      const s = new Date(anchor.getFullYear(), 0, 1);
      const e = new Date(anchor.getFullYear(), 11, 31);
      return { granularity, from: isoDate(s), to: isoDate(e), label: String(anchor.getFullYear()) };
    }
    case "all":
      return { granularity, from: "1970-01-01", to: "2999-12-31", label: "All time" };
  }
}

export function stepPeriod(granularity: Granularity, anchor: Date, dir: -1 | 1): Date {
  switch (granularity) {
    case "day": return addDays(anchor, dir);
    case "week": return addDays(anchor, 7 * dir);
    case "month": return addMonths(anchor, dir);
    case "quarter": return addMonths(anchor, 3 * dir);
    case "year": return addMonths(anchor, 12 * dir);
    default: return anchor;
  }
}

const CALENDAR_GRANULARITIES: readonly string[] = ["day", "week", "month", "quarter", "year", "all"];

/** Invalid shared ranges show an error instead of silently querying another period. */
export function readPeriod(
  params: Pick<URLSearchParams, "get">,
  fallback: CalendarGranularity,
  allowed?: readonly Granularity[],
  today = new Date(),
) {
  const requested = params.get("g");
  const date = params.get("date") ?? "";
  const anchor = isCalendarDate(date) ? toDate(date) : today;
  const accepts = (g: Granularity) => !allowed || allowed.includes(g);
  if (requested === "custom" && allowed?.includes("custom")) {
    const custom = { from: params.get("from") ?? "", to: params.get("to") ?? "" };
    const error = dateRangeError(custom);
    if (!error) return { anchor: toDate(custom.from), granularity: "custom" as const, period: resolvePeriod("custom", anchor, custom), error: null };
    return { anchor, granularity: fallback, period: resolvePeriod(fallback, anchor), error };
  }
  const granularity = requested && CALENDAR_GRANULARITIES.includes(requested) && accepts(requested as CalendarGranularity)
    ? requested as CalendarGranularity : fallback;
  return { anchor, granularity, period: resolvePeriod(granularity, anchor), error: null };
}

export function periodUrlPatch(granularity: Granularity, anchor: Date, custom?: DateRange) {
  if (granularity === "custom") {
    if (!custom || dateRangeError(custom)) throw new RangeError("Invalid custom date range.");
    return { g: granularity, date: null, from: custom.from, to: custom.to };
  }
  return { g: granularity, date: isoDate(anchor), from: null, to: null };
}
