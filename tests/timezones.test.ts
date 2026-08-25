import { describe, expect, it } from "vitest";
import {
  describeTimeZone,
  isTimeZone,
  supportedTimeZoneIds,
  timeZoneOptions,
} from "@/lib/timezones";

const AUGUST_2026 = new Date("2026-08-25T12:00:00Z");

describe("timezone choices", () => {
  it("uses the runtime's complete worldwide IANA timezone set", () => {
    const ids = supportedTimeZoneIds();

    expect(ids.length).toBeGreaterThan(350);
    expect(ids[0]).toBe("UTC");
    expect(ids).toEqual(expect.arrayContaining([
      "Africa/Johannesburg",
      "America/Cancun",
      "America/New_York",
      "Asia/Karachi",
      "Australia/Sydney",
      "Europe/Paris",
      "Pacific/Auckland",
    ]));
    expect(ids.every(isTimeZone)).toBe(true);
  });

  it("distinguishes Cancun's fixed offset from New York daylight saving", () => {
    const cancun = describeTimeZone("America/Cancun", AUGUST_2026, 2026);
    const newYork = describeTimeZone("America/New_York", AUGUST_2026, 2026);

    expect(cancun.currentOffset).toBe("UTC-05:00");
    expect(cancun.region).toBe("America");
    expect(cancun.changesOffset).toBe(false);
    expect(cancun.changeLabel).toBe("No offset change in 2026");

    expect(newYork.currentOffset).toBe("UTC-04:00");
    expect(newYork.changesOffset).toBe(true);
    expect(newYork.changeLabel).toBe("Offset changes in 2026");
  });

  it("detects non-hour seasonal changes and makes DST terms searchable", () => {
    const lordHowe = describeTimeZone("Australia/Lord_Howe", AUGUST_2026, 2026);
    expect(lordHowe.changesOffset).toBe(true);
    expect(lordHowe.searchText).toContain("daylight saving");
    expect(lordHowe.searchText).toContain("lord howe");
  });

  it("retains a valid existing alias even when it is not canonical", () => {
    const aliases = ["US/Eastern", "Asia/Calcutta"].filter(isTimeZone);
    const alias = aliases.find((id) => !supportedTimeZoneIds().includes(id));
    if (!alias) return;

    expect(timeZoneOptions(alias, AUGUST_2026).some((option) => option.id === alias)).toBe(true);
  });
});
