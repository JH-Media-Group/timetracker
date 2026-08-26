import { describe, expect, it } from "vitest";
import { timeEntryClockValues } from "@/lib/time-entry-clock";

describe("timeEntryClockValues", () => {
  it("does not rewrite a running timer during an unrelated edit", () => {
    expect(timeEntryClockValues({
      existing: { spentOn: "2026-08-25", durationSeconds: 0 },
      initialStartMinutes: 8 * 60 + 37,
      spentOn: "2026-08-25",
      startMinutes: 8 * 60 + 37,
      endMinutes: null,
      durationSeconds: 0,
      timezone: "America/New_York",
    })).toEqual({});
  });

  it("records 8:37am to 9:15am as 38 minutes", () => {
    expect(timeEntryClockValues({
      spentOn: "2026-08-25",
      startMinutes: 8 * 60 + 37,
      endMinutes: 9 * 60 + 15,
      durationSeconds: 0,
      timezone: "America/New_York",
    })).toEqual({
      startedAt: "2026-08-25T12:37:00.000Z",
      endedAt: "2026-08-25T13:15:00.000Z",
      durationSeconds: 38 * 60,
    });
  });

  it("rebuilds timestamps when the calendar date is intentionally changed", () => {
    expect(timeEntryClockValues({
      existing: { spentOn: "2026-08-25", durationSeconds: 38 * 60 },
      initialStartMinutes: 8 * 60 + 37,
      initialEndMinutes: 9 * 60 + 15,
      spentOn: "2026-08-26",
      startMinutes: 8 * 60 + 37,
      endMinutes: 9 * 60 + 15,
      durationSeconds: 38 * 60,
      timezone: "America/New_York",
    })).toEqual({
      startedAt: "2026-08-26T12:37:00.000Z",
      endedAt: "2026-08-26T13:15:00.000Z",
    });
  });

  it("sends a duration edit without touching unchanged clock fields", () => {
    expect(timeEntryClockValues({
      existing: { spentOn: "2026-08-25", durationSeconds: 30 * 60 },
      initialStartMinutes: 8 * 60 + 37,
      initialEndMinutes: 9 * 60 + 15,
      spentOn: "2026-08-25",
      startMinutes: 8 * 60 + 37,
      endMinutes: 9 * 60 + 15,
      durationSeconds: 45 * 60,
      timezone: "America/New_York",
    })).toEqual({ durationSeconds: 45 * 60 });
  });

  it("uses elapsed instants across a daylight-saving boundary", () => {
    expect(timeEntryClockValues({
      spentOn: "2026-03-07",
      startMinutes: 23 * 60,
      endMinutes: 3 * 60,
      durationSeconds: 4 * 60 * 60,
      timezone: "America/New_York",
    })).toMatchObject({ durationSeconds: 3 * 60 * 60 });
  });
});
