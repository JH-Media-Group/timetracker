import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, s, closeDb } from "./helpers";
import { newId } from "@/server/db/ids";
import { timeEditFixture } from "./support/time-edit-fixture";
import { updateTimeEntry } from "@/server/services/time";
import { invalidateSettings } from "@/server/services/settings";

let f: Awaited<ReturnType<typeof timeEditFixture>>;
beforeEach(async () => { f = await timeEditFixture(); });
afterAll(closeDb);
const stored = () => db.select().from(s.timeEntries).where(eq(s.timeEntries.id, f.id));
async function approved() {
  await db.insert(s.timesheetSubmissions).values({ id: newId(), userId: f.owner, periodStart: "2026-10-19", periodEnd: "2026-10-25", state: "approved" });
}

describe("t-SFiXCS destination date protection", () => {
  it.each(["approved", "locked", "future"])("rejects a move into a %s period without changing any original fields", async (kind) => {
    if (kind === "approved") await approved();
    if (kind === "locked") { await db.update(s.settings).set({ lockTimesheetsAfterDays: 7 }); invalidateSettings(); }
    const before = await stored();
    await expect(updateTimeEntry(f.member, f.id, { spentOn: kind === "future" ? "2026-11-06" : "2026-10-20", notes: "Changed", durationSeconds: 7200 })).rejects.toMatchObject({ code: kind === "future" ? "validation_failed" : "record_locked" });
    expect(await stored()).toEqual(before);
    expect(await db.select().from(s.auditLog)).toHaveLength(0);
  });

  it("allows an unlocked date and an administrator override with audit evidence", async () => {
    await updateTimeEntry(f.member, f.id, { spentOn: "2026-11-04" });
    await approved();
    await updateTimeEntry(f.administrator, f.id, { spentOn: "2026-10-20" });
    expect((await stored())[0]!.spentOn).toBe("2026-10-20");
    expect(await db.select().from(s.auditLog).where(eq(s.auditLog.action, "time_entry.update.override"))).toHaveLength(1);
  });

  it("uses the owner's calendar for future dates even when an administrator edits", async () => {
    await db.update(s.users).set({ timezone: "Pacific/Kiritimati" }).where(eq(s.users.id, f.owner));
    await updateTimeEntry(f.administrator, f.id, { spentOn: "2026-11-06" });
    await expect(updateTimeEntry(f.administrator, f.id, { spentOn: "2026-11-07" })).rejects.toMatchObject({ code: "validation_failed" });
  });
});
