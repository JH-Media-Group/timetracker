import { describe, it } from "vitest";
import { resolveClockTime, elapsedMinutes, formatDuration, parseDuration } from "@/lib/format";

const read = (s: string, e: string) => {
  const a = resolveClockTime(s);
  const b = resolveClockTime(e, { after: a });
  return { start: a, end: b };
};

describe("probe", () => {
  it("10 to 10:10 and neighbours", () => {
    for (const [s, e] of [["10", "10:10"], ["10:00", "10:10"], ["10am", "10:10am"], ["10", "10:10pm"], ["10:10", "10"]]) {
      const { start, end } = read(s, e);
      const mins = start != null && end != null ? elapsedMinutes(start, end) : null;
      console.log(
        `start=${JSON.stringify(s)}->${start}  end=${JSON.stringify(e)}->${end}  mins=${mins}` +
        `  decimal=${mins != null ? formatDuration(mins * 60, "decimal") : "-"}` +
        `  hm=${mins != null ? formatDuration(mins * 60, "hours_minutes") : "-"}`
      );
    }
    console.log("parseDuration('10:10') =", parseDuration("10:10"), "seconds");
    console.log("parseDuration('0:10')  =", parseDuration("0:10"), "seconds");
    console.log("parseDuration('10')    =", parseDuration("10"), "seconds");
  });
});
