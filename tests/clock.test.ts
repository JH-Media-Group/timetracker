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
    /*
      The two shared a regex by copy for a while, so this checks they still
      classify the same strings the same way.

      It used to assert `typeof ... === "boolean"`, which is the declared return
      type and therefore true of every possible implementation, `return false`
      included. Both reviewers named it as the one vacuous test in the file.
      What it asserts now is the actual property: a bare hour the parser accepts
      is ambiguous, and one carrying a meridiem or a 24-hour hour is not.
    */
    const ambiguous = ["3", "3:15", "1", "11:59", "12", "12:00"];
    const settled = ["3pm", "3 pm", "23:59", "0:30", "13:00", "00:00"];

    for (const s of [...ambiguous, ...settled]) {
      expect(parseClockTime(s), `${s} should parse`).not.toBeNull();
    }
    for (const s of ambiguous) {
      expect(clockTimeIsAmbiguous(s), `${s} needs resolving`).toBe(true);
    }
    for (const s of settled) {
      expect(clockTimeIsAmbiguous(s), `${s} says which half of the day it is`).toBe(false);
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

  it("warns at exactly twelve hours, which is where the real mistake lands", () => {
    /*
      This used to assert the opposite, and the opposite was the bug.

      The boundary was exclusive, so exactly 720 minutes said nothing. Every
      "H" to "H" pair resolves to exactly 720 minutes, because a bare hour at
      the end takes the soonest reading after the start and the same hour is
      twelve hours later. So the one span the check most needed to catch was
      the one span it was written to ignore. Person02 saved 10:00am to 10:00pm
      meaning ten past ten and got 12.00 hours in silence (t-iqTVyw).
    */
    expect(implausibleSpanWarning(at(8), at(20))).not.toBeNull();
    expect(implausibleSpanWarning(at(8), at(20, 1))).not.toBeNull();
    expect(implausibleSpanWarning(at(8), at(19, 59))).toBeNull();
  });

  it("names the typo when the same clock time is entered twice", () => {
    // The generic sentence invites "yes, I worked a long day". This one says
    // what actually went wrong, which is the minutes falling off the second
    // time. Both readings of the reported case are covered.
    const same = implausibleSpanWarning(at(10), at(22));
    expect(same).toContain("exactly twelve hours");
    // The worked example uses the hour they typed. A fixed example from the
    // original bug report reads as advice about somebody else's entry.
    expect(same, "echoes their own start hour").toContain("10:15 rather than 10");
    expect(implausibleSpanWarning(at(7), at(19)), "and somebody else's").toContain("7:15 rather than 7");

    // There is no such thing as a twelve-hour span between different clock
    // readings: twelve hours later is the same face. So every exactly-720
    // span gets this sentence, and anything longer gets the generic one.
    expect(implausibleSpanWarning(at(8), at(20))).toContain("exactly twelve hours");
    expect(implausibleSpanWarning(at(8), at(21))).toContain("13 hours");
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
  it("round-trips every minute of the day", () => {
    for (let m = 0; m < 24 * 60; m++) {
      expect(parseClockTime(formatClockTime(m)), String(m)).toBe(m);
    }
  });

  it("wraps past midnight without help, which is why the caller adds no modulo", () => {
    // `syncFromDuration` hands it start-plus-duration, which can exceed 1440.
    // It carried a modulo and a comment claiming that was necessary; it is not,
    // and a reviewer pointed out the line changed nothing.
    expect(formatClockTime(24 * 60)).toBe(formatClockTime(0));
    expect(formatClockTime(25 * 60 + 30)).toBe(formatClockTime(60 + 30));
  });
});

describe("resolveClockTime stays inside a day", () => {
  it("never returns a value outside 0..1439, for any input the parser accepts", () => {
    // The reviewers proved this by reading the two candidate expressions. This
    // is the executable version, over every hour and both resolution contexts.
    for (let h = 0; h <= 23; h++) {
      for (const suffix of ["", "am", "pm"]) {
        const s = `${h}:30${suffix}`;
        for (const ctx of [{}, { after: 0 }, { after: 1439 }, { before: 0 }, { before: 1439 }]) {
          const v = resolveClockTime(s, ctx);
          if (v === null) continue;
          expect(v, `${s} ${JSON.stringify(ctx)}`).toBeGreaterThanOrEqual(0);
          expect(v, `${s} ${JSON.stringify(ctx)}`).toBeLessThan(24 * 60);
        }
      }
    }
  });
});
