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

/**
 * Tidy a money amount somebody typed into a form field, for display on blur.
 *
 * Not `formatMoney`, which prepends a currency symbol. These fields sit inside
 * an `Affix` that already shows the "$", so the symbol would appear twice.
 *
 * Anything unparseable comes back untouched, so a half-typed value is never
 * destroyed mid-edit, and an empty field stays empty rather than becoming 0.00.
 * `parseMoney` strips separators, so re-formatting an already-formatted value
 * is stable.
 */
export function formatMoneyInput(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  const cents = parseMoney(trimmed);
  if (cents == null) return input;
  return (cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
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

/**
 * One regex, read by both the parser and the ambiguity check.
 *
 * They had a copy each for about an hour. Two regexes that must agree about
 * what a clock time looks like are one edit away from disagreeing, and the
 * failure would be silent: a form the parser accepts and the resolver thinks
 * is unambiguous gets read as 3am.
 */
const CLOCK_RE = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/;

export function parseClockTime(input: string): number | null {
  const m = input.trim().toLowerCase().match(CLOCK_RE);
  if (!m) return null;
  let h = +m[1]!;
  const min = m[2] ? +m[2]! : 0;
  const mer = m[3];
  if (mer === "pm" && h < 12) h += 12;
  if (mer === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Was the meridiem left off a time that needs one?
 *
 * "3:15" is two different times and the machine has to pick. "3:15pm" and
 * "15:15" are one time each and it must not.
 *
 * Twelve counts, and an earlier version of this said it did not, on the
 * grounds that a bare "12" reads as noon to everybody. It does, standing
 * alone. It does not after a start of 8pm, which is the case that opened the
 * ticket. So twelve is ambiguous like the rest, and the no-context fallback
 * below is what keeps it meaning noon when there is nothing to resolve it
 * against.
 */
export function clockTimeIsAmbiguous(input: string): boolean {
  const m = input.trim().toLowerCase().match(CLOCK_RE);
  if (!m || m[3]) return false;
  const h = +m[1]!;
  return h >= 1 && h <= 12;
}

/**
 * Resolve a typed time, using the other end of the entry to settle a bare hour.
 *
 * `parseClockTime` reads what was typed and nothing more, which is right for a
 * parser and wrong for a timesheet: somebody who types 3:15 into a workday
 * means the afternoon, and reading it as 3:15am produced an end before its
 * start and a raw `time_entries_clock_ordered` error in their face.
 *
 * Two rules, in order:
 *
 *   1. **If there is a time at the other end, use it.** The reading that makes
 *      the shortest positive shift wins. From 8pm, a bare "12" is midnight (4
 *      hours) rather than noon (16). From 9am, a bare "5" is 5pm (8 hours)
 *      rather than 5am (20). This is what makes an overnight shift work without
 *      anybody typing "am".
 *   2. **Otherwise read it as an office day.** 1 through 6 are the afternoon, 7
 *      through 11 the morning. Chosen because it is a rule somebody can hold in
 *      their head and predict, which "nearest to noon" is not: it makes 6
 *      a coin toss and 3:15 depend on the minutes.
 *
 * Anything unambiguous is returned exactly as typed, both rules skipped.
 */
export function resolveClockTime(
  input: string,
  opts: { after?: number | null; before?: number | null } = {}
): number | null {
  const literal = parseClockTime(input);
  if (literal == null || !clockTimeIsAmbiguous(input)) return literal;

  // Modulo, because the other reading of a bare 12 is midnight, not 24:00.
  const other = (literal + 12 * 60) % (24 * 60);
  const { after, before } = opts;

  /*
    A shift of zero sorts last rather than first.

    This is not the same claim `elapsedMinutes` makes, and a reviewer caught the
    two comments contradicting each other. `elapsedMinutes` answers "how long is
    an entry from 9:00 to 9:00", and the answer is nothing, because somebody who
    types one time twice means an empty entry. This answers "which reading of a
    bare hour should win", and there a candidate landing exactly on the other end
    is the worst of the two rather than the best: nobody types a start and an end
    meaning a zero-length entry, so the other reading is what they meant.
  */
  const shift = (n: number) => (n === 0 ? 24 * 60 : n);

  if (after != null) {
    return shift(elapsedMinutes(after, literal)) <= shift(elapsedMinutes(after, other))
      ? literal
      : other;
  }
  if (before != null) {
    return shift(elapsedMinutes(literal, before)) <= shift(elapsedMinutes(other, before))
      ? literal
      : other;
  }

  // Nothing to resolve against: read it as an office day. Noon stays noon.
  const hour = Math.floor(literal / 60);
  return hour >= 1 && hour <= 6 ? other : literal;
}

/**
 * Minutes from one clock time to another, going forwards.
 *
 * An end before its start is the next day, not a negative number: 8pm to 12am
 * is four hours. Equal is zero rather than a full day, because somebody who
 * types the same time twice means an empty entry, not a 24 hour one.
 */
export function elapsedMinutes(startMinutes: number, endMinutes: number): number {
  const raw = endMinutes - startMinutes;
  return raw >= 0 ? raw : raw + 24 * 60;
}

/** Whether an entry running from `start` to `end` runs past midnight. */
export const crossesMidnight = (startMinutes: number, endMinutes: number) => endMinutes < startMinutes;

/**
 * Longer than this and we say so, without refusing it.
 *
 * The number comes from the cases somebody actually listed: 7pm to 2am is
 * seven hours and fine, 11am to 12am is thirteen and probably a missing "pm",
 * 8am to 3am is nineteen and certainly wrong. Twelve separates them.
 *
 * It warns rather than blocks on purpose. Long days happen, and a system that
 * refuses to record one teaches people to log it wrong instead.
 */
export const IMPLAUSIBLE_SPAN_MINUTES = 12 * 60;

/**
 * The sentence shown under a span that looks like a mistake, or null.
 *
 * **Twelve hours exactly warns.** The boundary used to be exclusive, and that
 * excluded the single most likely way to get a wrong span: a bare hour at the
 * end resolving half a day out. Any "H" to "H" pair lands on exactly 720
 * minutes, so the one case the check most needed to catch was the one case it
 * let through.
 *
 * Person02 logged 10:00am to 10:00pm meaning ten past ten, and Tally saved 12.00
 * hours in silence (t-iqTVyw). Nothing was calculated wrongly: the app was
 * asked for 10 to 10 and answered correctly. It just never said that twelve
 * hours was a strange thing to have been asked for.
 */
export function implausibleSpanWarning(startMinutes: number, endMinutes: number): string | null {
  const minutes = elapsedMinutes(startMinutes, endMinutes);
  if (minutes < IMPLAUSIBLE_SPAN_MINUTES) return null;

  /*
    Exactly twelve hours is the same clock time twice, always.

    Not a heuristic: an end twelve hours after a start reads identically on the
    clock face, so this branch is the "10 to 10" case by construction. It is
    also how a bare hour resolves when the minutes fall off, which is what
    makes it worth its own sentence. The generic warning invites "yes, I worked
    a long day"; this one names the actual mistake.

    A first version of this guarded on `startMinutes % 720 === endMinutes % 720`
    as well. That condition can never be false here, so it was removed rather
    than left looking like it discriminated between two cases.
  */
  if (minutes === IMPLAUSIBLE_SPAN_MINUTES) {
    return `${formatClockTime(startMinutes)} to ${formatClockTime(endMinutes)} is exactly twelve hours. If you meant minutes past the hour, type them: 10:10 rather than 10.`;
  }

  const hours = Math.round((minutes / 60) * 10) / 10;
  return `That is ${hours} hours. Check the start and end are the right way round.`;
}

/** The day after an ISO date, for an end time that landed past midnight. */
export function nextIsoDay(spentOn: string): string {
  const [y, m, d] = spentOn.split("-").map(Number) as [number, number, number];
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  // `Date.UTC` maps years 0 to 99 onto 1900 + y, so "0099-01-01" would come back
  // as 1999. Unreachable from a date input, and one line to close.
  if (y >= 0 && y <= 99) next.setUTCFullYear(y, m - 1, d + 1);
  return next.toISOString().slice(0, 10);
}

export function formatClockTime(minutes: number): string {
  const h24 = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  const mer = h24 >= 12 ? "pm" : "am";
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h}:${String(m).padStart(2, "0")}${mer}`;
}

/**
 * The wall-clock minute a stored instant falls on, in a named timezone.
 *
 * `started_at` and `ended_at` are instants, which is what `timestamptz` means
 * and what the running timer records (`new Date().toISOString()`). The clock a
 * person reads off them is not a property of the instant, it is a property of
 * the instant plus a zone, and the zone that matters is the one the work was
 * done in, not the one the reader happens to be sitting in.
 *
 * This used to be `new Date(iso).getHours()`, which is the reader's zone. Two
 * consequences, both real: every one of the 55,177 imported entries with a
 * clock displayed four or five hours early for anybody in New York, and 987 of
 * them displayed a time belonging to the day before their own `spent_on`.
 *
 * Pass the entry owner's timezone. `America/New_York` is not a default here on
 * purpose: a silent default is how the reader's zone crept in.
 */
export function minutesOfDay(isoString: string, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(isoString));

  const at = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return at("hour") * 60 + at("minute");
}

/**
 * The instant at which a wall-clock minute occurs on a given day in a zone.
 *
 * The inverse of `minutesOfDay`, and the thing the entry editor needs. It has
 * to be built rather than concatenated: the previous version did
 * `new Date(\`${spentOn}T00:00:00\`).toISOString().slice(0, 11)`, which parses
 * as the *reader's* midnight, converts to UTC, and then takes the date part. In
 * any zone east of UTC that is the previous day, and the result carried no zone
 * designator at all, so the server rejected it outright.
 *
 * Two passes because an offset is itself a function of the date: guess UTC,
 * measure how far off the guess lands in the target zone, correct, and measure
 * again so a DST boundary between the guess and the answer is caught.
 */
export function instantAt(spentOn: string, minutes: number, timeZone: string): string {
  const [y, mo, d] = spentOn.split("-").map(Number) as [number, number, number];
  let guess = Date.UTC(y, mo - 1, d, Math.floor(minutes / 60), minutes % 60);

  for (let i = 0; i < 2; i++) {
    const landed = minutesOfDay(new Date(guess).toISOString(), timeZone);
    let delta = minutes - landed;
    // A correction should never be more than half a day; anything larger means
    // the clock wrapped past midnight, so take the short way round.
    if (delta > 720) delta -= 1440;
    if (delta < -720) delta += 1440;
    if (delta === 0) break;
    guess += delta * 60_000;
  }
  return new Date(guess).toISOString();
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

/** "Thu, 13 Aug", the format used in page chrome. */
export const formatDayLong = (d: string | Date) => {
  const x = toDate(d);
  return `${DOW[x.getDay()]}, ${x.getDate()} ${MONTHS[x.getMonth()]}`;
};
/** "13 Aug" */
export const formatDayShort = (d: string | Date) => {
  const x = toDate(d);
  return `${x.getDate()} ${MONTHS[x.getMonth()]}`;
};
/** "08/13/2026", the format used inside tables. */
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

/**
 * Hours with their unit, for anywhere the value sits beside money.
 *
 * A project budgeted in hours and one budgeted in fees share the Budget, Spent
 * and Remaining columns, so the same column shows `26.67` on one row and
 * `$12,000.00` on the next. Without the unit the first reads as twenty-six
 * dollars. Use `formatHours` only where the unit is already established by a
 * label or the field is an editable number.
 */
export const formatHoursUnit = (seconds: number) => `${formatHours(seconds)} hrs`;

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
