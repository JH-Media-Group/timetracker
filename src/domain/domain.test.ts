/**
 * The domain rules are the specification, so these tests are the specification
 * too. Where a case here disagrees with docs/BACKEND_PRD.md section 4, the PRD
 * wins and this file is the bug.
 */

import { describe, expect, it } from "vitest";
import {
  computeInvoiceTotals, formatCents, invoiceBalance, lineAmount, parseMoney,
  percentOf, roundHalfEven, secondsToCents, sumSecondsToCents,
} from "./money";
import {
  formatClock, formatClockTime, formatDuration, parseClockTime, parseDuration,
  parseTimeRange, rangeSeconds,
} from "./duration";
import {
  addDays, addMonths, dayIn, daysBetween, eachDay, endOfMonth, endOfWeek,
  intersectRange, startOfMonth, startOfWeek, weekday, wholeMonthsBetween,
} from "./calendar";
import { NO_ROUNDING, roundGroup, roundSeconds } from "./rounding";
import { rateOn, resolveRates, type DatedRate } from "./rates";
import { budgetHealth, computeBudget, crossedThreshold, validateBudgetShape } from "./budgets";
import { canCreateOn, canEdit, isUninvoiced } from "./editability";
import {
  canDelete, canTransition, clientCodeFrom, displayState, dueDateFor,
  renderInvoiceNumber, stateAfterPayment,
} from "./invoices";
import { allocate, profitFrom, recogniseFee } from "./profitability";

/* ==================================================================== money */

describe("roundHalfEven", () => {
  it("rounds halves to the even neighbour", () => {
    expect(roundHalfEven(0.5)).toBe(0);
    expect(roundHalfEven(1.5)).toBe(2);
    expect(roundHalfEven(2.5)).toBe(2);
    expect(roundHalfEven(3.5)).toBe(4);
    expect(roundHalfEven(-0.5)).toBe(0); // 0 is the even neighbour
    expect(roundHalfEven(-1.5)).toBe(-2);
  });

  it("rounds non-halves normally", () => {
    expect(roundHalfEven(1.4)).toBe(1);
    expect(roundHalfEven(1.6)).toBe(2);
    expect(roundHalfEven(-1.4)).toBe(-1);
    expect(roundHalfEven(-1.6)).toBe(-2);
  });

  it("does not drift upward across many halves, the way half-up does", () => {
    const values = Array.from({ length: 1000 }, (_, i) => i + 0.5);
    const halfEven = values.reduce((a, v) => a + roundHalfEven(v), 0);
    const halfUp = values.reduce((a, v) => a + Math.round(v), 0);
    const exact = values.reduce((a, v) => a + v, 0);
    expect(Math.abs(halfEven - exact)).toBeLessThan(Math.abs(halfUp - exact));
  });
});

describe("secondsToCents", () => {
  it("values an hour at the rate", () => {
    expect(secondsToCents(3600, 15000)).toBe(15000);
  });

  it("values a half hour at half the rate", () => {
    expect(secondsToCents(1800, 15000)).toBe(7500);
  });

  it("aggregates before dividing, so rounding cannot accumulate", () => {
    // Ten 6-minute entries at $105/h. Per-entry rounding gives 10 x 1050 = 10500.
    // The correct total is 6000 seconds x 10500 / 3600 = 17500.
    const rows = Array.from({ length: 10 }, () => ({ seconds: 360, rateCents: 10500 }));
    const perRow = rows.reduce((a, r) => a + secondsToCents(r.seconds, r.rateCents), 0);
    const aggregate = sumSecondsToCents(rows);
    expect(aggregate).toBe(10500);
    expect(perRow).toBe(10500);

    // A rate that does not divide evenly is where the two diverge. Seven rows
    // of 100 seconds at $123.45/h: the true value is 2400.42 cents.
    const awkward = Array.from({ length: 7 }, () => ({ seconds: 100, rateCents: 12345 }));
    const perRowAwkward = awkward.reduce((a, r) => a + secondsToCents(r.seconds, r.rateCents), 0);
    expect(sumSecondsToCents(awkward)).toBe(2400); // divide once, at the end
    expect(perRowAwkward).toBe(2401); // round per row and the error accumulates
  });
});

describe("computeInvoiceTotals", () => {
  const line = (amount: number, taxed = true) => ({
    quantity: 1, unitPriceCents: amount, amountCents: amount, isTaxed: taxed, isTaxed2: false,
  });

  it("sums a plain invoice", () => {
    const t = computeInvoiceTotals([line(10000), line(2500)]);
    expect(t.subtotalCents).toBe(12500);
    expect(t.totalCents).toBe(12500);
  });

  it("applies the discount to the subtotal", () => {
    const t = computeInvoiceTotals([line(10000)], { discountPercent: 10 });
    expect(t.discountCents).toBe(1000);
    expect(t.totalCents).toBe(9000);
  });

  it("taxes the post-discount amount, not the gross", () => {
    const t = computeInvoiceTotals([line(10000)], { discountPercent: 10, taxPercent: 10 });
    expect(t.discountCents).toBe(1000);
    expect(t.taxCents).toBe(900); // 10% of 9000, not of 10000
    expect(t.totalCents).toBe(9900);
  });

  it("pro-rates the discount across taxed and untaxed lines", () => {
    // Half the invoice is taxable. A 10% discount should reduce the taxable
    // base by its share, not by the whole discount.
    const t = computeInvoiceTotals([line(10000, true), line(10000, false)], {
      discountPercent: 10,
      taxPercent: 10,
    });
    expect(t.subtotalCents).toBe(20000);
    expect(t.discountCents).toBe(2000);
    expect(t.taxCents).toBe(900); // 10% of (10000 - 1000)
    expect(t.totalCents).toBe(18900);
  });

  it("computes line amounts when they are not supplied", () => {
    const t = computeInvoiceTotals([
      { quantity: 3.5, unitPriceCents: 10000, isTaxed: false, isTaxed2: false },
    ]);
    expect(t.subtotalCents).toBe(35000);
  });

  it("handles an empty invoice", () => {
    const t = computeInvoiceTotals([], { taxPercent: 10, discountPercent: 5 });
    expect(t.totalCents).toBe(0);
    expect(t.taxCents).toBe(0);
  });
});

describe("money helpers", () => {
  it("computes a balance net of payments and any retainer draw", () => {
    expect(invoiceBalance(100000, 25000, 10000)).toBe(65000);
  });

  it("rounds line amounts half-even", () => {
    expect(lineAmount(2.5, 101)).toBe(252); // 252.5 rounds to the even 252
  });

  it("treats a null percentage as zero", () => {
    expect(percentOf(10000, null)).toBe(0);
    expect(percentOf(10000, undefined)).toBe(0);
  });

  it("parses money the way people type it", () => {
    expect(parseMoney("1,234.56")).toBe(123456);
    expect(parseMoney("$99")).toBe(9900);
    expect(parseMoney("0.01")).toBe(1);
    expect(parseMoney("")).toBeNull();
    expect(parseMoney("abc")).toBeNull();
  });

  it("formats cents as currency", () => {
    expect(formatCents(123456)).toBe("$1,234.56");
  });
});

/* ================================================================= duration */

describe("parseDuration", () => {
  it("reads a decimal as hours", () => {
    expect(parseDuration("1.5")).toBe(5400);
    expect(parseDuration("1,5")).toBe(5400);
    expect(parseDuration("0.25")).toBe(900);
  });

  it("reads a bare number under 24 as hours", () => {
    expect(parseDuration("8")).toBe(28800);
    expect(parseDuration("1")).toBe(3600);
  });

  it("reads a bare number of 24 or more as minutes", () => {
    expect(parseDuration("90")).toBe(5400);
    expect(parseDuration("30")).toBe(1800);
  });

  it("reads explicit units", () => {
    expect(parseDuration("90m")).toBe(5400);
    expect(parseDuration("2h")).toBe(7200);
    expect(parseDuration("1h30m")).toBe(5400);
    expect(parseDuration("1h 30m")).toBe(5400);
    expect(parseDuration("1h30")).toBe(5400);
  });

  it("reads clock notation", () => {
    expect(parseDuration("1:30")).toBe(5400);
    expect(parseDuration(":45")).toBe(2700);
    expect(parseDuration("10:00")).toBe(36000);
  });

  it("rejects nonsense", () => {
    expect(parseDuration("")).toBeNull();
    expect(parseDuration("abc")).toBeNull();
    expect(parseDuration("1:99")).toBeNull();
    expect(parseDuration(":99")).toBeNull();
  });
});

describe("formatDuration", () => {
  it("formats decimal hours to two places", () => {
    expect(formatDuration(5400)).toBe("1.50");
    expect(formatDuration(0)).toBe("0.00");
  });

  it("formats hours and minutes", () => {
    expect(formatDuration(5400, "hours_minutes")).toBe("1:30");
    expect(formatDuration(3660, "hours_minutes")).toBe("1:01");
  });

  it("carries 60 minutes into the next hour rather than printing 1:60", () => {
    expect(formatDuration(3599, "hours_minutes")).toBe("1:00");
  });

  it("formats a live clock", () => {
    expect(formatClock(3661)).toBe("1:01:01");
  });
});

describe("time ranges", () => {
  it("parses a range", () => {
    expect(parseTimeRange("9-10:30")).toEqual({ startMinutes: 540, endMinutes: 630, crossesMidnight: false });
    expect(parseTimeRange("9am-10:30am")).toEqual({ startMinutes: 540, endMinutes: 630, crossesMidnight: false });
    expect(parseTimeRange("09:00 to 17:00")).toEqual({ startMinutes: 540, endMinutes: 1020, crossesMidnight: false });
  });

  it("rolls a short overnight range to the next day", () => {
    const r = parseTimeRange("11pm-1am");
    expect(r).toEqual({ startMinutes: 1380, endMinutes: 60, crossesMidnight: true });
    expect(rangeSeconds(r!)).toBe(2 * 3600);
  });

  it("refuses an overnight range of twelve hours or more, which is a typo", () => {
    expect(parseTimeRange("9pm-9am")).toBeNull();
  });

  it("refuses a zero-length range", () => {
    expect(parseTimeRange("9-9")).toBeNull();
  });

  it("parses and formats clock times", () => {
    expect(parseClockTime("9:30am")).toBe(570);
    expect(parseClockTime("12am")).toBe(0);
    expect(parseClockTime("12pm")).toBe(720);
    expect(parseClockTime("0930")).toBe(570);
    expect(parseClockTime("25:00")).toBeNull();
    expect(formatClockTime(570)).toBe("9:30am");
    expect(formatClockTime(0)).toBe("12:00am");
    expect(formatClockTime(720)).toBe("12:00pm");
  });
});

/* ================================================================= calendar */

describe("calendar", () => {
  it("adds days without moving through a timezone", () => {
    expect(addDays("2026-08-14", 1)).toBe("2026-08-15");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("clamps when adding months", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2024-01-31", 1)).toBe("2024-02-29"); // leap year
    expect(addMonths("2026-08-14", -1)).toBe("2026-07-14");
  });

  it("counts days between dates", () => {
    expect(daysBetween("2026-08-01", "2026-08-14")).toBe(13);
    expect(daysBetween("2026-08-14", "2026-08-01")).toBe(-13);
  });

  it("finds week boundaries for both week starts", () => {
    // 2026-08-14 is a Friday.
    expect(weekday("2026-08-14")).toBe(5);
    expect(startOfWeek("2026-08-14", 1)).toBe("2026-08-10"); // Monday
    expect(startOfWeek("2026-08-14", 7)).toBe("2026-08-09"); // Sunday
    expect(endOfWeek("2026-08-14", 1)).toBe("2026-08-16");
  });

  it("finds month boundaries", () => {
    expect(startOfMonth("2026-08-14")).toBe("2026-08-01");
    expect(endOfMonth("2026-02-14")).toBe("2026-02-28");
    expect(endOfMonth("2024-02-14")).toBe("2024-02-29");
  });

  it("resolves a calendar day in a named timezone", () => {
    // 04:00 UTC on 14 August is still 15 August in Tokyo but already the 14th
    // in New York, an hour that has caused a lot of misfiled time entries.
    const at = new Date("2026-08-14T04:00:00Z");
    expect(dayIn("America/New_York", at)).toBe("2026-08-14");
    expect(dayIn("Asia/Tokyo", at)).toBe("2026-08-14");

    const late = new Date("2026-08-14T03:45:00Z"); // 11:45pm on the 13th in New York
    expect(dayIn("America/New_York", late)).toBe("2026-08-13");
    expect(dayIn("UTC", late)).toBe("2026-08-14");
  });

  it("lets today advance independently in zones with different midnight", () => {
    const beforeCancunMidnight = new Date("2026-08-26T04:59:59Z");
    const afterCancunMidnight = new Date("2026-08-26T05:00:00Z");
    expect(dayIn("America/Cancun", beforeCancunMidnight)).toBe("2026-08-25");
    expect(dayIn("America/Cancun", afterCancunMidnight)).toBe("2026-08-26");
    expect(dayIn("Asia/Tokyo", beforeCancunMidnight)).toBe("2026-08-26");
  });

  it("counts whole months", () => {
    expect(wholeMonthsBetween("2026-01-15", "2026-04-15")).toBe(3);
    expect(wholeMonthsBetween("2026-01-15", "2026-04-14")).toBe(2);
  });

  it("intersects ranges", () => {
    expect(intersectRange({ from: "2026-01-01", to: "2026-06-30" }, { from: "2026-04-01", to: "2026-12-31" }))
      .toEqual({ from: "2026-04-01", to: "2026-06-30" });
    expect(intersectRange({ from: "2026-01-01", to: "2026-02-01" }, { from: "2026-03-01", to: "2026-04-01" }))
      .toBeNull();
  });

  it("enumerates days inclusively", () => {
    expect(eachDay("2026-08-14", "2026-08-16")).toEqual(["2026-08-14", "2026-08-15", "2026-08-16"]);
  });
});

/* ================================================================= rounding */

describe("rounding", () => {
  it("does nothing when the rule is off", () => {
    expect(roundSeconds(3661, NO_ROUNDING)).toBe(3661);
  });

  it("rounds to the nearest increment", () => {
    // 900-second increments: 4000 is nearer 3600, 4100 is nearer 4500.
    expect(roundSeconds(4000, { minutes: 15, mode: "nearest" })).toBe(3600);
    expect(roundSeconds(4100, { minutes: 15, mode: "nearest" })).toBe(4500);
  });

  it("rounds up and down on demand", () => {
    expect(roundSeconds(3601, { minutes: 15, mode: "up" })).toBe(4500);
    expect(roundSeconds(4499, { minutes: 15, mode: "down" })).toBe(3600);
  });

  it("rounds the group, not each entry, which is the whole point", () => {
    // Ten 6-minute entries under 15-minute rounding, rounded up: the honest
    // total is one hour, and rounding each entry first bills two and a half.
    const entries = Array.from({ length: 10 }, () => 360);
    const rule = { minutes: 15, mode: "up" as const };

    const correct = roundGroup(entries, rule);
    const naive = entries.reduce((a, e) => a + roundSeconds(e, rule), 0);

    expect(correct).toBe(3600); // 1.0 hours
    expect(naive).toBe(9000); // 2.5 hours, an invoice 150% too big
  });

  it("rounding to nearest can also erase short entries when applied per row", () => {
    const entries = Array.from({ length: 10 }, () => 360);
    const rule = { minutes: 15, mode: "nearest" as const };
    expect(roundGroup(entries, rule)).toBe(3600);
    // Each 6-minute entry is nearer to zero than to 15 minutes.
    expect(entries.reduce((a, e) => a + roundSeconds(e, rule), 0)).toBe(0);
  });
});

/* ==================================================================== rates */

describe("rate resolution", () => {
  const rates: DatedRate[] = [
    { kind: "cost", amountCents: 5000, startsOn: null, endsOn: "2026-06-30" },
    { kind: "cost", amountCents: 6000, startsOn: "2026-07-01", endsOn: null },
    { kind: "billable", amountCents: 15000, startsOn: null, endsOn: null },
  ];

  const base = {
    project: { billingType: "time_and_materials" as const, billBy: "people" as const, hourlyRateCents: null },
    projectTask: { isBillable: true, hourlyRateCents: null },
    task: { defaultHourlyRateCents: null },
    member: null,
    userRates: rates,
    spentOn: "2026-08-14",
  };

  it("picks the dated rate covering the day", () => {
    expect(rateOn(rates, "cost", "2026-03-01")?.amountCents).toBe(5000);
    expect(rateOn(rates, "cost", "2026-08-01")?.amountCents).toBe(6000);
    expect(rateOn(rates, "cost", "2026-06-30")?.amountCents).toBe(5000);
  });

  it("is zero for a non-billable project, whatever the rates say", () => {
    const r = resolveRates({ ...base, project: { ...base.project, billingType: "non_billable" } });
    expect(r.billableRateCents).toBe(0);
    expect(r.rateMissing).toBe(false);
    expect(r.costRateCents).toBe(6000); // cost is independent of billing
  });

  it("is zero for a non-billable task", () => {
    const r = resolveRates({ ...base, projectTask: { isBillable: false, hourlyRateCents: null } });
    expect(r.billableRateCents).toBe(0);
    expect(r.rateMissing).toBe(false);
  });

  it("bills by person, preferring the member override", () => {
    expect(resolveRates(base).billableRateCents).toBe(15000);
    expect(resolveRates({ ...base, member: { hourlyRateCents: 20000 } }).billableRateCents).toBe(20000);
  });

  it("bills by task, preferring the project task rate over the task default", () => {
    const byTask = { ...base, project: { ...base.project, billBy: "tasks" as const } };
    expect(resolveRates({ ...byTask, task: { defaultHourlyRateCents: 9000 } }).billableRateCents).toBe(9000);
    expect(
      resolveRates({
        ...byTask,
        projectTask: { isBillable: true, hourlyRateCents: 11000 },
        task: { defaultHourlyRateCents: 9000 },
      }).billableRateCents
    ).toBe(11000);
  });

  it("bills by project", () => {
    const r = resolveRates({
      ...base,
      project: { billingType: "time_and_materials", billBy: "project", hourlyRateCents: 25000 },
    });
    expect(r.billableRateCents).toBe(25000);
  });

  it("flags a missing rate rather than guessing one", () => {
    const r = resolveRates({ ...base, userRates: [] });
    expect(r.billableRateCents).toBe(0);
    expect(r.rateMissing).toBe(true);
  });

  it("does not flag bill_by none, where zero is the right answer", () => {
    const r = resolveRates({ ...base, project: { ...base.project, billBy: "none" } });
    expect(r.billableRateCents).toBe(0);
    expect(r.rateMissing).toBe(false);
  });

  it("honours an explicit override, for imports carrying a stored rate", () => {
    const r = resolveRates({ ...base, overrideBillableCents: 7777 });
    expect(r.billableRateCents).toBe(7777);
  });
});

/* ================================================================== budgets */

describe("budgets", () => {
  it("maps budget_by to a unit and a grain", () => {
    const hours = computeBudget({
      by: "project_hours", budgetSeconds: 360000, budgetFeeCents: null,
      resetsMonthly: false, spentSeconds: 180000, spentCents: 999,
    });
    expect(hours.unit).toBe("hours");
    expect(hours.grain).toBe("project");
    expect(hours.spent).toBe(180000);
    expect(hours.percentUsed).toBe(0.5);

    const fees = computeBudget({
      by: "task_fees", budgetSeconds: null, budgetFeeCents: 100000,
      resetsMonthly: false, spentSeconds: 999, spentCents: 25000,
    });
    expect(fees.unit).toBe("currency");
    expect(fees.grain).toBe("task");
    expect(fees.spent).toBe(25000);
  });

  it("has no percentage without a budget", () => {
    const none = computeBudget({
      by: "none", budgetSeconds: null, budgetFeeCents: null,
      resetsMonthly: false, spentSeconds: 100, spentCents: 100,
    });
    expect(none.percentUsed).toBeNull();
    expect(none.health).toBe("none");
    expect(none.remaining).toBeNull();
  });

  it("bands health at 80 and 100 percent by default", () => {
    expect(budgetHealth(0.79)).toBe("ok");
    expect(budgetHealth(0.8)).toBe("near");
    expect(budgetHealth(1)).toBe("near");
    expect(budgetHealth(1.01)).toBe("over");
    expect(budgetHealth(null)).toBe("none");
  });

  /**
   * TALLY-37. The threshold used to be a hard-coded 0.8, so a project asking to
   * be flagged at 50% was flagged at 80% like everything else. Nothing looked
   * broken, because the band still appeared; it just appeared at the wrong time.
   */
  it("uses the project's own alert threshold", () => {
    expect(budgetHealth(0.5, 50), "flagged at the point the project asked for").toBe("near");
    expect(budgetHealth(0.49, 50)).toBe("ok");

    expect(budgetHealth(0.6, 95), "and not flagged before it").toBe("ok");
    expect(budgetHealth(0.95, 95)).toBe("near");
  });

  it("takes a percentage, not a fraction", () => {
    // The column is numeric(5,2) holding 80, not 0.8.
    expect(budgetHealth(0.5, 80)).toBe("ok");
    expect(budgetHealth(0.85, 80)).toBe("near");
  });

  /**
   * The write path holds 1 to 100, so these can only arrive from an import or a
   * hand-edited row. Falling back beats alarming from the first tracked minute.
   */
  it("falls back when the stored threshold is out of range", () => {
    expect(budgetHealth(0.5, 0.8), "a fraction stored where a percentage belongs").toBe("ok");
    expect(budgetHealth(0.5, 0)).toBe("ok");
    expect(budgetHealth(0.5, 900)).toBe("ok");
    expect(budgetHealth(0.85, 900), "and still bands at the default").toBe("near");
  });

  it("keeps the old behaviour for a project that set no threshold", () => {
    // Or every existing project silently changes on deploy.
    expect(budgetHealth(0.8, null)).toBe("near");
    expect(budgetHealth(0.79, null)).toBe("ok");
  });

  it("stays over budget regardless of the threshold", () => {
    expect(budgetHealth(1.01, 50)).toBe("over");
    expect(budgetHealth(1.01, 99)).toBe("over");
  });

  it("rejects a budget whose amount does not match its type", () => {
    expect(validateBudgetShape({ by: "project_hours", budgetSeconds: null, budgetFeeCents: 5000 }).ok).toBe(false);
    expect(validateBudgetShape({ by: "project_fees", budgetSeconds: 3600, budgetFeeCents: null }).ok).toBe(false);
    expect(validateBudgetShape({ by: "none", budgetSeconds: 3600, budgetFeeCents: null }).ok).toBe(false);
    expect(validateBudgetShape({ by: "project_hours", budgetSeconds: 3600, budgetFeeCents: null }).ok).toBe(true);
  });

  it("fires an alert once per crossing", () => {
    expect(crossedThreshold(0.5, 0.85, 80)).toBe(0.8);
    expect(crossedThreshold(0.85, 0.9, 80)).toBeNull(); // already crossed
    expect(crossedThreshold(0.9, 1.05, 80)).toBe(1); // the 100% line is separate
    expect(crossedThreshold(null, 0.5, 80)).toBeNull();
  });
});

/* ============================================================== editability */

describe("canEdit", () => {
  const ctx = {
    today: "2026-08-14",
    approvedPeriods: [{ periodStart: "2026-08-03", periodEnd: "2026-08-09" }],
    lockTimesheetsAfterDays: null,
    canOverride: false,
  };
  const open = {
    spentOn: "2026-08-14", userId: "u1", invoiceId: null, invoiceState: null, billedExternally: false,
  };

  it("allows an ordinary entry", () => {
    expect(canEdit(open, ctx).editable).toBe(true);
  });

  it("locks an entry on a sent invoice, but not on a draft", () => {
    expect(canEdit({ ...open, invoiceId: "i1", invoiceState: "open" }, ctx).reasons).toContain("invoiced");
    expect(canEdit({ ...open, invoiceId: "i1", invoiceState: "draft" }, ctx).editable).toBe(true);
  });

  it("locks anything billed before the migration", () => {
    expect(canEdit({ ...open, billedExternally: true }, ctx).reasons).toContain("billed_externally");
  });

  it("locks by period, so a back-dated entry cannot slip into an approved week", () => {
    const backdated = { ...open, spentOn: "2026-08-05" };
    expect(canEdit(backdated, ctx).editable).toBe(false);
    expect(canEdit(backdated, ctx).reasons).toContain("period_approved");
  });

  it("locks entries older than the account's window", () => {
    const old = { ...open, spentOn: "2026-06-01" };
    expect(canEdit(old, { ...ctx, lockTimesheetsAfterDays: 30 }).reasons).toContain("period_locked");
  });

  it("lets an administrator through, and says the override was needed", () => {
    const locked = { ...open, spentOn: "2026-08-05" };
    const result = canEdit(locked, { ...ctx, canOverride: true });
    expect(result.editable).toBe(true);
    expect(result.requiresOverride).toBe(true);
  });

  it("reports every reason, not just the first", () => {
    const doubly = { ...open, spentOn: "2026-08-05", billedExternally: true };
    expect(canEdit(doubly, ctx).reasons).toHaveLength(2);
  });

  it("refuses to create into an approved period", () => {
    expect(canCreateOn("2026-08-05", ctx).editable).toBe(false);
    expect(canCreateOn("2026-08-14", ctx).editable).toBe(true);
  });
});

describe("isUninvoiced", () => {
  it("is true only for billable, un-invoiced, not-externally-billed records", () => {
    expect(isUninvoiced({ invoiceId: null, billedExternally: false, isBillable: true })).toBe(true);
    expect(isUninvoiced({ invoiceId: "i1", billedExternally: false, isBillable: true })).toBe(false);
    expect(isUninvoiced({ invoiceId: null, billedExternally: true, isBillable: true })).toBe(false);
    expect(isUninvoiced({ invoiceId: null, billedExternally: false, isBillable: false })).toBe(false);
  });
});

/* ================================================================= invoices */

describe("invoice state machine", () => {
  it("allows only the transitions the state permits", () => {
    expect(canTransition("draft", "send")).toBe(true);
    expect(canTransition("draft", "record_payment")).toBe(false);
    expect(canTransition("open", "record_payment")).toBe(true);
    expect(canTransition("open", "send")).toBe(false);
    expect(canTransition("paid", "write_off")).toBe(false);
  });

  it("restricts delete to drafts unless the actor is an administrator", () => {
    expect(canDelete("draft", false)).toBe(true);
    expect(canDelete("open", false)).toBe(false);
    expect(canDelete("open", true)).toBe(true);
  });

  it("derives sent, partial, and late rather than storing them", () => {
    const base = { state: "open" as const, totalCents: 10000, today: "2026-08-14" };
    expect(displayState({ ...base, dueDate: "2026-08-31", paidCents: 0 })).toBe("sent");
    expect(displayState({ ...base, dueDate: "2026-08-31", paidCents: 4000 })).toBe("partial");
    expect(displayState({ ...base, dueDate: "2026-08-01", paidCents: 0 })).toBe("late");
    expect(displayState({ ...base, dueDate: "2026-08-01", paidCents: 4000 })).toBe("late");
    expect(displayState({ ...base, state: "draft", dueDate: "2026-08-01", paidCents: 0 })).toBe("draft");
  });

  it("moves to paid only when the balance is cleared", () => {
    expect(stateAfterPayment(10000, 9999, "open")).toBe("open");
    expect(stateAfterPayment(10000, 10000, "open")).toBe("paid");
    expect(stateAfterPayment(10000, 12000, "open")).toBe("paid");
    expect(stateAfterPayment(10000, 10000, "written_off")).toBe("written_off");
  });
});

describe("invoice numbering", () => {
  const ctx = { seq: 42, issueDate: "2026-08-14", clientCode: "ANN", projectCode: "JH-1000" };

  it("renders the tokens", () => {
    expect(renderInvoiceNumber("{seq:5}", ctx)).toBe("00042");
    expect(renderInvoiceNumber("{year}-{seq:4}", ctx)).toBe("2026-0042");
    expect(renderInvoiceNumber("{yy}{month}-{seq}", ctx)).toBe("2608-42");
    expect(renderInvoiceNumber("{client_code}-{seq}", ctx)).toBe("ANN-42");
    expect(renderInvoiceNumber("{project_code}-{seq}", ctx)).toBe("JH-1000-42");
  });

  it("leaves an unknown token visible rather than silently dropping it", () => {
    expect(renderInvoiceNumber("{nonsense}-{seq}", ctx)).toBe("{nonsense}-42");
  });

  it("lets a client prefix override", () => {
    expect(renderInvoiceNumber("{seq:3}", { ...ctx, clientPrefix: "ACME-" })).toBe("ACME-042");
  });

  it("derives a client code from a name", () => {
    expect(clientCodeFrom("Ann & Robert H Example Client 29")).toBe("ANN");
    expect(clientCodeFrom("123")).toBe("XXX");
  });

  it("computes due dates from terms", () => {
    expect(dueDateFor("2026-08-14", "net_30", null)).toBe("2026-09-13");
    expect(dueDateFor("2026-08-14", "upon_receipt", null)).toBe("2026-08-14");
    expect(dueDateFor("2026-08-14", "custom", 7)).toBe("2026-08-21");
  });
});

/* ============================================================ profitability */

describe("profitability", () => {
  it("computes profit, margin, and return on cost", () => {
    const p = profitFrom(100000, 40000);
    expect(p.profitCents).toBe(60000);
    expect(p.marginPct).toBeCloseTo(0.6);
    expect(p.returnOnCostPct).toBeCloseTo(1.5);
  });

  it("leaves margin undefined rather than zero when there is no revenue", () => {
    const p = profitFrom(0, 40000);
    expect(p.marginPct).toBeNull();
    expect(p.profitCents).toBe(-40000);
  });

  it("recognises a monthly fee by elapsed months", () => {
    const r = recogniseFee({
      feeCents: 500000, cadence: "monthly",
      startsOn: "2026-01-01", endsOn: "2026-12-31",
      period: { from: "2026-01-01", to: "2026-03-31" },
      hoursInPeriod: 100, hoursTotal: 400,
    });
    expect(r.method).toBe("monthly_elapsed");
    expect(r.cents).toBe(1500000); // three months
  });

  it("pro-rates a single fee across the project window by days", () => {
    const r = recogniseFee({
      feeCents: 365000, cadence: "single",
      startsOn: "2026-01-01", endsOn: "2026-12-31",
      period: { from: "2026-01-01", to: "2026-01-31" },
      hoursInPeriod: 10, hoursTotal: 100,
    });
    expect(r.method).toBe("window_prorated");
    expect(r.cents).toBe(31000); // 31 of 365 days
    expect(r.missingProjectDates).toBe(false);
  });

  it("falls back to hours when a fixed-fee project has no dates, and flags it", () => {
    const r = recogniseFee({
      feeCents: 400000, cadence: "single",
      startsOn: null, endsOn: null,
      period: { from: "2026-01-01", to: "2026-01-31" },
      hoursInPeriod: 25, hoursTotal: 100,
    });
    expect(r.method).toBe("hours_prorated");
    expect(r.cents).toBe(100000);
    expect(r.missingProjectDates).toBe(true);
  });

  it("allocates without losing cents to rounding", () => {
    const shares = [
      { key: "a", hours: 10, billableCents: 1000, active: true },
      { key: "b", hours: 20, billableCents: 2000, active: true },
      { key: "c", hours: 3, billableCents: 300, active: true },
    ];
    const out = allocate(10000, shares, "by_hours");
    const total = [...out.values()].reduce((a, b) => a + b, 0);
    expect(total).toBe(10000);
    expect(out.get("b")).toBeGreaterThan(out.get("a")!);
  });

  it("splits evenly across active members only", () => {
    const out = allocate(9000, [
      { key: "a", hours: 0, billableCents: 0, active: true },
      { key: "b", hours: 0, billableCents: 0, active: true },
      { key: "c", hours: 0, billableCents: 0, active: false },
    ], "evenly");
    expect(out.get("a")).toBe(4500);
    expect(out.get("b")).toBe(4500);
    expect(out.get("c")).toBe(0);
  });

  it("falls back to an even split when every weight is zero", () => {
    const out = allocate(1000, [
      { key: "a", hours: 0, billableCents: 0, active: false },
      { key: "b", hours: 0, billableCents: 0, active: false },
    ], "by_hours");
    expect([...out.values()].reduce((a, b) => a + b, 0)).toBe(1000);
  });
});
