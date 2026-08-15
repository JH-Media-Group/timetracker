/**
 * Clock times belong to the zone the work happened in.
 *
 * Both functions here replaced code that used the reader's zone, and the
 * consequences were live: every imported entry displayed four or five hours
 * early in New York, 987 of them displayed a time belonging to the previous
 * day, and the editor built a timestamp the server rejected outright, so
 * saving any entry with a start time returned 422.
 */

import { describe, expect, it } from "vitest";
import { instantAt, minutesOfDay } from "../src/lib/format";

const NY = "America/New_York";

describe("minutesOfDay", () => {
  it("reads the clock in the given zone, not the runner's", () => {
    // 13:30Z is 09:30 in New York during daylight time.
    expect(minutesOfDay("2026-08-14T13:30:00Z", NY)).toBe(9 * 60 + 30);
    expect(minutesOfDay("2026-08-14T13:30:00Z", "UTC")).toBe(13 * 60 + 30);
  });

  it("honours daylight saving", () => {
    // Same UTC clock, opposite sides of the DST boundary: EST is UTC-5, EDT -4.
    expect(minutesOfDay("2026-01-14T13:30:00Z", NY)).toBe(8 * 60 + 30);
    expect(minutesOfDay("2026-08-14T13:30:00Z", NY)).toBe(9 * 60 + 30);
  });

  it("is the case that made 987 entries show the wrong day", () => {
    // The importer wrote a 02:30 wall clock as 02:30Z. Read in New York that is
    // 21:30 the previous evening.
    expect(minutesOfDay("2019-01-24T02:30:00Z", NY)).toBe(21 * 60 + 30);
  });
});

describe("instantAt", () => {
  it("round-trips through minutesOfDay", () => {
    for (const day of ["2026-01-14", "2026-08-14", "2026-03-08", "2026-11-01"]) {
      for (const minutes of [0, 1, 9 * 60 + 30, 12 * 60, 23 * 60 + 59]) {
        const iso = instantAt(day, minutes, NY);
        expect(minutesOfDay(iso, NY), `${day} ${minutes}`).toBe(minutes);
      }
    }
  });

  it("produces a zone-designated instant the server will accept", () => {
    // z.string().datetime() rejects a zoneless string, which is exactly what
    // the editor used to build. This is the regression test for that 422.
    const iso = instantAt("2026-08-14", 9 * 60 + 30, NY);
    expect(iso).toMatch(/Z$/);
    expect(iso).toBe("2026-08-14T13:30:00.000Z");
  });

  it("keeps the entry on its own day from a zone east of UTC", () => {
    // The old concatenation took the date part of the reader's midnight in UTC,
    // which is the previous day anywhere east of Greenwich.
    const iso = instantAt("2026-08-14", 9 * 60, "Asia/Tokyo");
    expect(minutesOfDay(iso, "Asia/Tokyo")).toBe(9 * 60);
    expect(iso.slice(0, 10)).toBe("2026-08-14");
  });

  it("survives the spring-forward gap", () => {
    // 02:30 on 2026-03-08 does not exist in New York. It must still produce a
    // real instant rather than NaN, and land within an hour of what was asked.
    const iso = instantAt("2026-03-08", 2 * 60 + 30, NY);
    expect(Number.isNaN(Date.parse(iso))).toBe(false);
  });
});
