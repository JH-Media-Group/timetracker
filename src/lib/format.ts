/**
 * Formatting and parsing. The domain layer of the front end.
 *
 * Two rules from the PRD live here and must not be relaxed:
 *   - Money is integer cents. Never a float in a calculation that reaches storage.
 *   - Durations are integer seconds, and parsing is generous because people type
 *     "1.5", "90m", "1h30" and "1:30" and all four mean the same thing.
 */

import type { Settings } from "./types";

/* ------------------------------------------------------------------- money */

export function formatMoney(cents: number | null | undefined, currency = "USD"): string {
  if (cents == null) return "";
  const neg = cents < 0;
  const s = (Math.abs(cents) / 100).toLocaleString("en-US", {
    style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
  return neg ? `-${s}` : s;
}

/** Compact form for axis labels only. Never for a figure someone might act on. */
export function formatMoneyShort(cents: number): string {
  const v = cents / 100;
  if (Math.abs(v) >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1000) return `$${Math.round(v / 1000)}k`;
  return `$${Math.round(v)}`;
}

export function parseMoney(input: string): number | null {
  const cleaned = input.replace(/[^0-9.\-]/g, "");
  if (!cleaned || cleaned === "-" || cleaned === ".") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/* ---------------------------------------------------------------- duration */

export function formatDuration(seconds: number | null | undefined, mode: Settings["timeDisplay"] = "decimal"): string {
  if (seconds == null) return "";
  if (mode === "hours_minutes") {
    const total = Math.round(seconds / 60);
    const h = Math.floor(total / 60);
    const m = total % 60;
    return `${h}:${String(m).padStart(2, "0")}`;
  }
  return (seconds / 3600).toFixed(2);
}

/** Always H:MM:SS, for the running timer readout. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

/**
 * Accepts 1.5 · 1,5 · 90 · 90m · 1h30 · 1h 30m · 1:30 · :45 · 1h
 * A bare number is hours when it has a decimal separator or is under 24,
 * minutes otherwise. Ambiguity resolves toward hours because that is what
 * people mean when they type "2" into a timesheet.
 */
export function parseDuration(input: string): number | null {
  const s = input.trim().toLowerCase().replace(",", ".");
  if (!s) return null;

  let m = s.match(/^(\d+)\s*h\s*(\d+)\s*m?$/);            // 1h30 / 1h 30m
  if (m) return (+m[1]! * 60 + +m[2]!) * 60;

  m = s.match(/^(\d+(?:\.\d+)?)\s*h$/);                    // 1.5h
  if (m) return Math.round(+m[1]! * 3600);

  m = s.match(/^(\d+(?:\.\d+)?)\s*m(?:in)?$/);             // 90m
  if (m) return Math.round(+m[1]! * 60);

  m = s.match(/^(\d*):(\d{1,2})$/);                        // 1:30 / :45
  if (m) return ((+(m[1] || 0)) * 60 + +m[2]!) * 60;

  m = s.match(/^\d+(?:\.\d+)?$/);
  if (m) {
    const n = +s;
    if (s.includes(".") || n < 24) return Math.round(n * 3600);
    return Math.round(n * 60);
  }
  return null;
}

/** "9-10:30", "9am-10:30am", "09:00 to 10:30" -> {startMin, endMin} from midnight. */
export function parseTimeRange(input: string): { start: number; end: number } | null {
  const parts = input.toLowerCase().split(/\s*(?:-|to|–)\s*/);
  if (parts.length !== 2) return null;
  const a = parseClockTime(parts[0]!), b = parseClockTime(parts[1]!);
  if (a == null || b == null) return null;
  let end = b;
  if (end <= a) { if (a - end < 12 * 60) return null; end += 24 * 60; }
  return { start: a, end };
}

export function parseClockTime(input: string): number | null {
  const s = input.trim().toLowerCase();
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let h = +m[1]!;
  const min = m[2] ? +m[2]! : 0;
  const mer = m[3];
  if (mer === "pm" && h < 12) h += 12;
  if (mer === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export function formatClockTime(minutes: number): string {
  const h24 = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  const mer = h24 >= 12 ? "pm" : "am";
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h}:${String(m).padStart(2, "0")}${mer}`;
}

export function minutesOfDay(isoString: string): number {
  const d = new Date(isoString);
  return d.getHours() * 60 + d.getMinutes();
}

/* ------------------------------------------------------------------- dates */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const toDate = (d: string | Date): Date => (typeof d === "string" ? new Date(d + (d.length === 10 ? "T00:00:00" : "")) : d);
export const isoDate = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const addDays = (d: Date, n: number): Date => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
export const addMonths = (d: Date, n: number): Date => { const x = new Date(d); x.setMonth(x.getMonth() + n); return x; };
export const startOfWeek = (d: Date, weekStartsOn: 0 | 1 = 1): Date =>
  addDays(d, -((d.getDay() - weekStartsOn + 7) % 7));
export const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);
export const endOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth() + 1, 0);
export const sameDay = (a: Date, b: Date) => isoDate(a) === isoDate(b);

/** "Thu, 13 Aug" — the format used in page chrome. */
export const formatDayLong = (d: string | Date) => {
  const x = toDate(d);
  return `${DOW[x.getDay()]}, ${x.getDate()} ${MONTHS[x.getMonth()]}`;
};
/** "13 Aug" */
export const formatDayShort = (d: string | Date) => {
  const x = toDate(d);
  return `${x.getDate()} ${MONTHS[x.getMonth()]}`;
};
/** "08/13/2026" — the format used inside tables. */
export const formatDateUS = (d: string | Date) => {
  const x = toDate(d);
  return `${String(x.getMonth() + 1).padStart(2, "0")}/${String(x.getDate()).padStart(2, "0")}/${x.getFullYear()}`;
};
export const formatMonthYear = (d: string | Date) => {
  const x = toDate(d);
  return `${MONTHS[x.getMonth()]} ${x.getFullYear()}`;
};
export const formatWeekRange = (start: Date) => {
  const end = addDays(start, 6);
  const sameMonth = start.getMonth() === end.getMonth();
  return sameMonth
    ? `${start.getDate()} - ${end.getDate()} ${MONTHS[end.getMonth()]} ${end.getFullYear()}`
    : `${start.getDate()} ${MONTHS[start.getMonth()]} - ${end.getDate()} ${MONTHS[end.getMonth()]} ${end.getFullYear()}`;
};

/** "Due in 3 days" / "Due today" / "28 days overdue" */
export function formatDueIn(due: string, today: Date): string {
  const diff = Math.round((toDate(due).getTime() - today.getTime()) / 86400000);
  if (diff === 0) return "Due today";
  if (diff > 0) return `Due in ${diff} day${diff === 1 ? "" : "s"}`;
  return `${-diff} day${diff === -1 ? "" : "s"} overdue`;
}

export function relativeTime(at: string, now = new Date()): string {
  const diff = Math.round((now.getTime() - new Date(at).getTime()) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return formatDateUS(at);
}

/* ------------------------------------------------------------------ others */

export const formatPercent = (fraction: number | null | undefined, dp = 0): string =>
  fraction == null ? "" : `${(fraction * 100).toFixed(Math.abs(fraction) < 0.1 && dp === 0 ? 1 : dp)}%`;

export const formatHours = (seconds: number) => (seconds / 3600).toFixed(2);

export const initials = (first: string, last: string) =>
  `${first.charAt(0)}${last.charAt(0)}`.toUpperCase();

/** Deterministic avatar gradient from a user ID. Never from list position:
 *  position-derived colour changes when a list re-sorts. */
export function avatarGradient(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const a = h % 360;
  return `linear-gradient(135deg, hsl(${a} 62% 58%), hsl(${(a + 40) % 360} 58% 45%))`;
}
