/**
 * Reading a typed clock time.
 *
 * These rules came out of four bug reports that were all the same bug: the
 * parser read exactly what was typed, and a timesheet needs it to read what was
 * meant. "3:15" in a workday became 3:15am, which put the end before the start,
 * which surfaced as `time_entries_clock_ordered` in a toast.
 *
 * Every case named in a report is a case here, with the report's own numbers.
 */

import { describe, expect, it } from "vitest";
import {
  clockTimeIsAmbiguous, crossesMidnight, elapsedMinutes, formatClockTime,
  implausibleSpanWarning, nextIsoDay, parseClockTime, resolveClockTime,
} from "@/lib/format";

const at = (h: number, m = 0) => h * 60 + m;

describe("clockTimeIsAmbiguous", () => {
  it("is true only when a bare hour could be either half of the day", () => {
    expect(clockTimeIsAmbiguous("3:15")).toBe(true);
    expect(clockTimeIsAmbiguous("12")).toBe(true);
    expect(clockTimeIsAmbiguous("11:59")).toBe(true);
    expect(clockTimeIsAmbiguous("3:15pm")).toBe(false);
    expect(clockTimeIsAmbiguous("15:15")).toBe(false); // 13 through 23 say it themselves
    expect(clockTimeIsAmbiguous("0:30")).toBe(false);
    expect(clockTimeIsAmbiguous("banana")).toBe(false);
  });

  it("agrees with the parser about what a clock time even is", () => {
    // The two shared a regex by copy for a while. Anything the parser accepts
    // must be classified here rather than silently falling through as "not
    // ambiguous", which reads as 3am.
    for (const s of ["3", "3:15", "3pm", "3 pm", "03:15", "23:59", "12:00"]) {
      expect(parseClockTime(s), s).not.toBeNull();
      expect(typeof clockTimeIsAmbiguous(s), s).toBe("boolean");
    }
  });
});

describe("resolveClockTime", () => {
  it("leaves an unambiguous time exactly as typed", () => {
    expect(resolveClockTime("3:15pm")).toBe(at(15, 15));
    expect(resolveClockTime("15:15")).toBe(at(15, 15));
    expect(resolveClockTime("3:15pm", { after: at(20) })).toBe(at(15, 15));
  });

  it("reads a bare hour as an office day when there is nothing to go on", () => {
    expect(resolveClockTime("3:15")).toBe(at(15, 15)); // the report's own case
    expect(resolveClockTime("1")).toBe(at(13));
    expect(resolveClockTime("6")).toBe(at(18));
    expect(resolveClockTime("7")).toBe(at(7));
    expect(resolveClockTime("11")).toBe(at(11));
    expect(resolveClockTime("12")).toBe(at(12)); // noon, standing alone
  });

  it("uses the start to settle an end", () => {
    expect(resolveClockTime("12", { after: at(20) })).toBe(at(0)); // 8pm to midnight
    expect(resolveClockTime("5", { after: at(9) })).toBe(at(17)); // 9am to 5pm
    expect(resolveClockTime("2", { after: at(19) })).toBe(at(2)); // 7pm to 2am
    expect(resolveClockTime("11", { after: at(9) })).toBe(at(11)); // a short morning
  });

  it("uses the end to settle a start", () => {
    expect(resolveClockTime("8", { before: at(0) })).toBe(at(20)); // 8pm to midnight
    expect(resolveClockTime("9", { before: at(17) })).toBe(at(9));
  });

  it("returns null for something that is not a time at all", () => {
    expect(resolveClockTime("")).toBeNull();
    expect(resolveClockTime("25:00")).toBeNull();
    expect(resolveClockTime("3:75")).toBeNull();
  });
});

describe("elapsedMinutes", () => {
  it("treats an end before its start as the next day", () => {
    expect(elapsedMinutes(at(20), at(0))).toBe(4 * 60); // the report's case
    expect(elapsedMinutes(at(19), at(2))).toBe(7 * 60);
    expect(elapsedMinutes(at(9), at(17))).toBe(8 * 60);
  });

  it("treats the same time twice as an empty entry, not a whole day", () => {
    expect(elapsedMinutes(at(9), at(9))).toBe(0);
  });
});

describe("implausibleSpanWarning", () => {
  // Exactly the three cases the report listed, with its own verdicts.
  it("says nothing about a late but ordinary shift", () => {
    expect(implausibleSpanWarning(at(19), at(2))).toBeNull(); // 7pm to 2am, seven hours
    expect(implausibleSpanWarning(at(9), at(17))).toBeNull();
  });

  it("speaks up about a span that is probably a mistake", () => {
    expect(implausibleSpanWarning(at(11), at(0))).toContain("13"); // 11am to 12am
    expect(implausibleSpanWarning(at(8), at(3))).toContain("19"); // 8am to 3am
  });

  it("is a warning and not a refusal, so it returns a sentence rather than throwing", () => {
    expect(typeof implausibleSpanWarning(at(8), at(3))).toBe("string");
  });

  it("does not warn at exactly the threshold", () => {
    expect(implausibleSpanWarning(at(8), at(20))).toBeNull(); // twelve hours
    expect(implausibleSpanWarning(at(8), at(20, 1))).not.toBeNull();
  });
});

describe("crossesMidnight and nextIsoDay", () => {
  it("knows which entries need their end on the following day", () => {
    expect(crossesMidnight(at(20), at(0))).toBe(true);
    expect(crossesMidnight(at(9), at(17))).toBe(false);
    expect(crossesMidnight(at(9), at(9))).toBe(false);
  });

  it("steps a date over a month end and a leap day", () => {
    expect(nextIsoDay("2026-08-21")).toBe("2026-08-22");
    expect(nextIsoDay("2026-08-31")).toBe("2026-09-01");
    expect(nextIsoDay("2026-12-31")).toBe("2027-01-01");
    expect(nextIsoDay("2028-02-28")).toBe("2028-02-29");
  });
});

describe("formatClockTime", () => {
  it("round-trips everything resolveClockTime can produce", () => {
    for (let m = 0; m < 24 * 60; m++) {
      expect(parseClockTime(formatClockTime(m)), String(m)).toBe(m);
    }
  });
});
