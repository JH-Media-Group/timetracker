/**
 * Durations and time ranges.
 *
 * Stored as integer seconds. The parser is deliberately forgiving because
 * people type time in whatever shape is in their head: "1.5", "90m", "1h30",
 * "1:30", ":45". Getting this wrong shows up as a support question every week.
 *
 * Specification: docs/BACKEND_PRD.md section 4.2.
 */

export type Seconds = number;

const HOUR = 3600;
const MINUTE = 60;

/**
 * Parse a duration into seconds. Null when the input is not a duration.
 *
 * The ambiguous case is a bare number. The rule: a decimal separator or a value
 * under 24 means hours, anything else means minutes. So "8" is eight hours,
 * "90" is ninety minutes, "1.5" is ninety minutes, and "0.25" is fifteen. That
 * matches what a person means often enough to be worth the asymmetry.
 */
export function parseDuration(input: string): Seconds | null {
  const raw = input.trim().toLowerCase();
  if (!raw) return null;

  // :45 → 45 minutes
  if (/^:\d{1,2}$/.test(raw)) {
    const minutes = Number(raw.slice(1));
    return minutes < 60 ? minutes * MINUTE : null;
  }

  // 1:30 → 1h30m
  const clock = raw.match(/^(\d{1,3}):([0-5]?\d)$/);
  if (clock) return Number(clock[1]) * HOUR + Number(clock[2]) * MINUTE;

  // 1h30, 1h 30m, 1h, 30m, 1 h 30 min
  const composite = raw.match(/^(?:(\d+(?:[.,]\d+)?)\s*h(?:ours?|rs?)?)?\s*(?:(\d+(?:[.,]\d+)?)\s*m(?:in(?:ute)?s?)?)?$/);
  if (composite && (composite[1] || composite[2])) {
    const hours = composite[1] ? Number(composite[1].replace(",", ".")) : 0;
    const minutes = composite[2] ? Number(composite[2].replace(",", ".")) : 0;
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
    return Math.round(hours * HOUR + minutes * MINUTE);
  }

  // "1h30" without the trailing m
  const hAndDigits = raw.match(/^(\d+)\s*h\s*([0-5]?\d)$/);
  if (hAndDigits) return Number(hAndDigits[1]) * HOUR + Number(hAndDigits[2]) * MINUTE;

  // Bare number
  const bare = raw.match(/^(\d+(?:[.,]\d+)?)$/);
  if (bare) {
    const text = bare[1]!;
    const value = Number(text.replace(",", "."));
    if (!Number.isFinite(value)) return null;
    const looksLikeHours = /[.,]/.test(text) || value < 24;
    return Math.round(looksLikeHours ? value * HOUR : value * MINUTE);
  }

  return null;
}

/** Decimal hours to two places, or H:MM, per the account setting. */
export function formatDuration(seconds: Seconds, mode: "decimal" | "hours_minutes" = "decimal"): string {
  const safe = Math.max(0, Math.round(seconds));
  if (mode === "hours_minutes") {
    const h = Math.floor(safe / HOUR);
    const m = Math.round((safe % HOUR) / MINUTE);
    // 59.6 minutes rounds to 60, which should read as the next hour.
    return m === 60 ? `${h + 1}:00` : `${h}:${String(m).padStart(2, "0")}`;
  }
  return (safe / HOUR).toFixed(2);
}

/** H:MM:SS, for a live timer. */
export function formatClock(seconds: Seconds): string {
  const safe = Math.max(0, Math.round(seconds));
  const h = Math.floor(safe / HOUR);
  const m = Math.floor((safe % HOUR) / MINUTE);
  const s = safe % MINUTE;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/* ------------------------------------------------------------ time ranges */

export interface TimeRange {
  /** Minutes from midnight. */
  startMinutes: number;
  endMinutes: number;
  /** True when the end rolled past midnight. */
  crossesMidnight: boolean;
}

/** "9:30am", "0930", "9", "17:00" into minutes from midnight. Null if not a time. */
export function parseClockTime(input: string): number | null {
  const raw = input.trim().toLowerCase().replace(/\s+/g, "");
  if (!raw) return null;

  const m = raw.match(/^(\d{1,2})(?::?(\d{2}))?(am|pm)?$/);
  if (!m) return null;

  let hours = Number(m[1]);
  const minutes = m[2] ? Number(m[2]) : 0;
  const meridiem = m[3];

  if (minutes > 59) return null;
  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    if (meridiem === "pm" && hours !== 12) hours += 12;
    if (meridiem === "am" && hours === 12) hours = 0;
  } else if (hours > 23) return null;

  return hours * 60 + minutes;
}

export function formatClockTime(minutes: number): string {
  const normalised = ((minutes % 1440) + 1440) % 1440;
  const h24 = Math.floor(normalised / 60);
  const m = normalised % 60;
  const meridiem = h24 < 12 ? "am" : "pm";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, "0")}${meridiem}`;
}

/**
 * "9-10:30", "9am-10:30am", "09:00 to 10:30".
 *
 * An end before the start rolls to the next day only when the span is under
 * twelve hours. Beyond that it is far more likely to be a typo than a genuine
 * overnight shift, and silently recording nineteen hours is worse than
 * rejecting the input.
 */
export function parseTimeRange(input: string): TimeRange | null {
  const parts = input.trim().toLowerCase().split(/\s*(?:-|–|to|until)\s*/).filter(Boolean);
  if (parts.length !== 2) return null;

  const startMinutes = parseClockTime(parts[0]!);
  const endMinutes = parseClockTime(parts[1]!);
  if (startMinutes == null || endMinutes == null) return null;

  if (endMinutes > startMinutes) {
    return { startMinutes, endMinutes, crossesMidnight: false };
  }
  if (endMinutes === startMinutes) return null;

  const overnightSpan = 1440 - startMinutes + endMinutes;
  if (overnightSpan >= 12 * 60) return null;
  return { startMinutes, endMinutes, crossesMidnight: true };
}

export const rangeSeconds = (r: TimeRange): Seconds =>
  ((r.crossesMidnight ? 1440 - r.startMinutes + r.endMinutes : r.endMinutes - r.startMinutes)) * MINUTE;
