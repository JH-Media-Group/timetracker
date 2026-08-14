/**
 * The calendar arithmetic behind recurring invoices.
 *
 * Pure, so it is tested exhaustively rather than through the service. The
 * failure this guards is a client billed on the wrong day, or a schedule that
 * drifts until it silently stops being the day anybody agreed to.
 */

import { describe, expect, it } from "vitest";
import {
  anchorDayOf,
  anchorWeekdayOf,
  hasFinished,
  nextOccurrence,
  nextOccurrenceAfter,
} from "@/domain/recurrence";

describe("nextOccurrence", () => {
  it("steps a monthly schedule", () => {
    expect(nextOccurrence("2026-01-15", "monthly", 1, 15)).toBe("2026-02-15");
    expect(nextOccurrence("2026-11-15", "monthly", 1, 15)).toBe("2026-12-15");
    expect(nextOccurrence("2026-12-15", "monthly", 1, 15)).toBe("2027-01-15");
  });

  it("steps quarterly and yearly, which are the other cadences in use", () => {
    expect(nextOccurrence("2026-01-10", "quarterly", 1, 10)).toBe("2026-04-10");
    expect(nextOccurrence("2026-10-07", "quarterly", 1, 7)).toBe("2027-01-07");
    expect(nextOccurrence("2026-08-04", "yearly", 1, 4)).toBe("2027-08-04");
  });

  it("honours an interval greater than one", () => {
    // "every 3 years" and "every 4 years" are both live schedules.
    expect(nextOccurrence("2026-10-10", "yearly", 3, 10)).toBe("2029-10-10");
    expect(nextOccurrence("2028-09-02", "yearly", 4, 2)).toBe("2032-09-02");
    expect(nextOccurrence("2026-01-01", "monthly", 2, 1)).toBe("2026-03-01");
  });

  it("steps weekly by whole weeks", () => {
    expect(nextOccurrence("2026-08-14", "weekly", 1, 14)).toBe("2026-08-21");
    expect(nextOccurrence("2026-08-14", "weekly", 2, 14)).toBe("2026-08-28");
  });

  /**
   * The case the whole module exists for.
   *
   * Chaining `addMonths` gives 31 Jan, 28 Feb, 28 Mar: February's clamp is
   * inherited and the schedule walks backwards for good. Anchoring gives the
   * 31st back as soon as a month can hold it.
   */
  it("returns to the anchor day after a short month", () => {
    const anchor = anchorDayOf("2026-01-31");
    const jan = "2026-01-31";
    const feb = nextOccurrence(jan, "monthly", 1, anchor);
    const mar = nextOccurrence(feb, "monthly", 1, anchor);
    const apr = nextOccurrence(mar, "monthly", 1, anchor);

    expect(feb).toBe("2026-02-28");
    expect(mar, "March has a 31st, so the schedule takes it back").toBe("2026-03-31");
    expect(apr, "April does not, so it clamps again").toBe("2026-04-30");
  });

  it("handles a leap February", () => {
    expect(nextOccurrence("2028-01-31", "monthly", 1, 31)).toBe("2028-02-29");
    expect(nextOccurrence("2026-01-31", "monthly", 1, 31)).toBe("2026-02-28");
  });

  it("clamps the 30th and 29th too, not just the 31st", () => {
    expect(nextOccurrence("2026-01-30", "monthly", 1, 30)).toBe("2026-02-28");
    expect(nextOccurrence("2026-01-29", "monthly", 1, 29)).toBe("2026-02-28");
    expect(nextOccurrence("2028-01-29", "monthly", 1, 29)).toBe("2028-02-29");
  });

  it("never drifts across a year of monthly steps", () => {
    let at = "2026-01-31";
    const days: number[] = [];
    for (let i = 0; i < 12; i++) {
      at = nextOccurrence(at, "monthly", 1, 31);
      days.push(Number(at.slice(8)));
    }
    // Every month takes the 31st where it exists, and its last day where it does not.
    expect(days).toEqual([28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31, 31]);
  });
});

describe("nextOccurrenceAfter", () => {
  it("skips the periods a paused schedule missed rather than backfilling them", () => {
    // Paused in January, resumed in June. The next invoice is the next one due,
    // not five at once.
    const next = nextOccurrenceAfter("2026-01-15", "monthly", 1, 15, "2026-06-10");
    expect(next).toBe("2026-06-15");
  });

  it("returns the immediate next occurrence when only one is missed", () => {
    expect(nextOccurrenceAfter("2026-01-15", "monthly", 1, 15, "2026-01-20")).toBe("2026-02-15");
  });

  it("leaves a future date alone", () => {
    expect(nextOccurrenceAfter("2026-09-01", "monthly", 1, 1, "2026-08-14")).toBe("2026-09-01");
  });

  it("is bounded, so an ancient anchor cannot spin", () => {
    const next = nextOccurrenceAfter("1990-01-01", "monthly", 1, 1, "2026-08-14", 12);
    expect(next).toBe("1991-01-01"); // stopped at the cap rather than looping
  });
});

describe("hasFinished", () => {
  it("stops on the occurrence count", () => {
    expect(hasFinished("2026-09-01", null, 0)).toBe(true);
    expect(hasFinished("2026-09-01", null, 1)).toBe(false);
  });

  it("stops past the end date", () => {
    expect(hasFinished("2026-09-01", "2026-08-31", null)).toBe(true);
    expect(hasFinished("2026-08-01", "2026-08-31", null)).toBe(false);
  });

  /** The two can disagree, and the earlier one wins. */
  it("stops on whichever limit comes first", () => {
    expect(hasFinished("2026-09-01", "2027-12-31", 0), "count exhausted first").toBe(true);
    expect(hasFinished("2026-09-01", "2026-08-31", 99), "end date passed first").toBe(true);
    expect(hasFinished("2026-09-01", "2027-12-31", 5), "neither reached").toBe(false);
  });

  it("treats no next date as finished", () => {
    expect(hasFinished(null, null, 5)).toBe(true);
  });
});

describe("anchors", () => {
  it("reads the day of the month a schedule starts on", () => {
    expect(anchorDayOf("2026-01-31")).toBe(31);
    expect(anchorDayOf("2026-02-01")).toBe(1);
  });

  it("reads the ISO weekday, Monday through Sunday", () => {
    expect(anchorWeekdayOf("2026-08-14")).toBe(5); // a Friday
    expect(anchorWeekdayOf("2026-08-16")).toBe(7); // Sunday is 7, not 0
  });
});
