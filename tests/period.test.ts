import { describe, expect, it } from "vitest";
import { dateRangeError, isCalendarDate, periodUrlPatch, readPeriod, resolvePeriod, stepPeriod } from "@/lib/period";

const today = new Date(2026, 9, 27);
const reports = ["week", "month", "quarter", "year", "all", "custom"] as const;

describe("report periods", () => {
  it("restores an inclusive custom range from a shared URL", () => {
    const params = new URLSearchParams("g=custom&from=2026-09-14&to=2026-10-03&r=profitability&by=task");
    const selection = readPeriod(params, "month", reports, today);
    expect(selection.error).toBeNull();
    expect(selection.period).toEqual({ granularity: "custom", from: "2026-09-14", to: "2026-10-03", label: "2026-09-14 to 2026-10-03" });
  });

  it("allows a single day and a leap day", () => {
    expect(dateRangeError({ from: "2028-02-29", to: "2028-02-29" })).toBeNull();
  });

  it("accepts calendar days skipped in a local timezone", () => {
    const previous = process.env.TZ;
    try {
      process.env.TZ = "Pacific/Apia";
      expect(isCalendarDate("2011-12-30")).toBe(true);
      expect(dateRangeError({ from: "2011-12-30", to: "2011-12-31" })).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  it.each([
    ["", "2026-09-01"], ["2026-09-01", ""], ["2026-02-29", "2026-03-01"],
    ["2026-04-31", "2026-05-01"], ["2026-13-01", "2027-01-01"],
    ["2026-9-01", "2026-09-02"], ["0000-01-01", "2026-09-01"],
    ["2026-09-02", "2026-09-01"],
  ])("rejects invalid or reversed custom dates: %s to %s", (from, to) => {
    const selection = readPeriod(new URLSearchParams({ g: "custom", from, to }), "month", reports, today);
    expect(selection.error).toBeTruthy();
    expect(() => periodUrlPatch("custom", today, { from, to })).toThrow(RangeError);
  });

  it("clears custom bounds when switching to a calendar period", () => {
    expect(periodUrlPatch("month", today)).toEqual({ g: "month", date: "2026-10-27", from: null, to: null });
    expect(periodUrlPatch("custom", today, { from: "2026-08-19", to: "2026-09-03" }))
      .toEqual({ g: "custom", date: null, from: "2026-08-19", to: "2026-09-03" });
  });

  it("ignores custom range URLs on screens that do not offer custom periods", () => {
    const selection = readPeriod(new URLSearchParams("g=custom&from=2026-09-01&to=2026-09-02"), "week", ["week", "month"], today);
    expect(selection.granularity).toBe("week");
    expect(selection.error).toBeNull();
  });

  it("falls back safely for invalid anchor dates and unsupported granularities", () => {
    expect(readPeriod(new URLSearchParams("g=nonsense&date=2026-02-31"), "month", reports, today).period)
      .toMatchObject({ from: "2026-10-01", to: "2026-10-31" });
  });

  it.each([
    ["week", "2026-10-26", "2026-11-01"], ["month", "2026-10-01", "2026-10-31"],
    ["quarter", "2026-10-01", "2026-12-31"], ["year", "2026-01-01", "2026-12-31"],
    ["all", "1970-01-01", "2999-12-31"],
  ] as const)("keeps the existing %s period", (g, from, to) => {
    expect(resolvePeriod(g, today)).toMatchObject({ from, to });
  });

  it("does not step custom dates or all-time periods", () => {
    expect(stepPeriod("custom", today, 1)).toBe(today);
    expect(stepPeriod("all", today, -1)).toBe(today);
  });
});
