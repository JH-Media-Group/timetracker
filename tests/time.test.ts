/**
 * Time entries, through the service layer.
 *
 * The cases that matter are the ones where the domain rules and the database
 * have to agree: the stop-then-insert timer transaction, the calendar day
 * resolving in the owner's timezone, rate snapshots that do not drift, and the
 * period lock that a back-dated entry must not slip past.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { closeDb, db, resetDb, s } from "./helpers";
import { newId } from "@/server/db/ids";
import { syncBaseProfiles } from "@/server/auth/profiles";
import { createCtx, type Actor, type Ctx } from "@/server/ctx";
import type { Capability } from "@/server/auth/capabilities";
import { BASE_PROFILES } from "@/server/auth/capabilities";
import { invalidateSettings } from "@/server/services/settings";
import {
  copyDay, createTimeEntry, deleteTimeEntry, duplicateTimeEntry, getTimeEntry,
  listTimeEntries, restoreTimeEntry, runningEntry, splitTimeEntry, stopTimer,
  timesheetSummary, updateTimeEntry, upsertWeek,
} from "@/server/services/time";

let profiles: Record<string, string>;
let alice: string; // administrator, New York
let karachi: string; // member, Asia/Karachi
let clientId: string;
let projectId: string;
let fixedFeeProjectId: string;
let designTaskId: string;
let supportTaskId: string;

const TODAY = "2026-08-14";
const at = (iso: string) => new Date(iso);

function ctxFor(userId: string, key: keyof typeof BASE_PROFILES, timezone = "America/New_York"): Ctx {
  const actor: Actor = {
    userId,
    profileId: profiles[key]!,
    baseKey: key,
    capabilities: new Set(BASE_PROFILES[key].capabilities as readonly Capability[]),
    kind: "user",
    timezone,
    isOwner: key === "administrator",
  };
  // A fixed clock, so "today" is a constant and the tests do not drift.
  return createCtx({ actor, now: () => at(`${TODAY}T15:00:00Z`) });
}

beforeEach(async () => {
  await resetDb();
  invalidateSettings();
  const synced = await syncBaseProfiles(db);
  profiles = synced.ids;

  await db.insert(s.settings).values({
    id: 1,
    companyName: "JH Media Group",
    timezone: "America/New_York",
    allowFutureDates: false,
    flagMissingBelowSeconds: 8 * 3600,
  });

  alice = newId();
  karachi = newId();
  await db.insert(s.users).values([
    {
      id: alice, email: "alice@jhmediagroup.com", firstName: "Alice", lastName: "A",
      profileId: profiles.administrator!, timezone: "America/New_York",
    },
    {
      id: karachi, email: "kamran@jhmediagroup.com", firstName: "Kamran", lastName: "K",
      profileId: profiles.member!, timezone: "Asia/Karachi",
    },
  ]);

  await db.insert(s.userRates).values([
    { id: newId(), userId: alice, kind: "billable", amountCents: 15000 },
    { id: newId(), userId: alice, kind: "cost", amountCents: 6000 },
    { id: newId(), userId: karachi, kind: "billable", amountCents: 9000 },
    { id: newId(), userId: karachi, kind: "cost", amountCents: 3000 },
  ]);

  clientId = newId();
  await db.insert(s.clients).values({ id: clientId, name: "Test Client" });

  projectId = newId();
  fixedFeeProjectId = newId();
  await db.insert(s.projects).values([
    { id: projectId, clientId, name: "T&M Project", billingType: "time_and_materials", billBy: "people" },
    {
      id: fixedFeeProjectId, clientId, name: "Fixed Fee Project",
      billingType: "fixed_fee", billBy: "none", feeCents: 500000, feeCadence: "single",
    },
  ]);

  designTaskId = newId();
  supportTaskId = newId();
  await db.insert(s.tasks).values([
    { id: designTaskId, name: "Design", isDefaultBillable: true },
    { id: supportTaskId, name: "Non-billable Support", isDefaultBillable: false },
  ]);

  for (const project of [projectId, fixedFeeProjectId]) {
    await db.insert(s.projectTasks).values([
      { id: newId(), projectId: project, taskId: designTaskId, isBillable: project !== fixedFeeProjectId },
      { id: newId(), projectId: project, taskId: supportTaskId, isBillable: false },
    ]);
  }

  await db.insert(s.projectMembers).values([
    { id: newId(), projectId, userId: alice, isManager: true },
    { id: newId(), projectId, userId: karachi },
    { id: newId(), projectId: fixedFeeProjectId, userId: alice, isManager: true },
  ]);
});

afterAll(async () => {
  await closeDb();
});

/* =============================================================== creating */

describe("creating an entry", () => {
  it("snapshots the rates at write time", async () => {
    const ctx = ctxFor(alice, "administrator");
    const { entry } = await createTimeEntry(ctx, {
      projectId, taskId: designTaskId, spentOn: TODAY, durationSeconds: 3600,
    });

    expect(entry.billableRateCents).toBe(15000);
    expect(entry.costRateCents).toBe(6000);
  });

  it("does not reprice an entry when the rate later changes", async () => {
    const ctx = ctxFor(alice, "administrator");
    const { entry } = await createTimeEntry(ctx, {
      projectId, taskId: designTaskId, spentOn: TODAY, durationSeconds: 3600,
    });

    // A raise, effective from tomorrow.
    await db.update(s.userRates).set({ endsOn: TODAY }).where(
      and(eq(s.userRates.userId, alice), eq(s.userRates.kind, "billable"))
    );
    await db.insert(s.userRates).values({
      id: newId(), userId: alice, kind: "billable", amountCents: 20000, startsOn: "2026-08-15",
    });

    const after = await getTimeEntry(ctx, entry.id);
    expect(after.billableRateCents).toBe(15000);
  });

  it("resolves the calendar day in the owner's timezone, not the actor's", async () => {
    // 19:00 UTC on the 14th is 15:00 in New York and midnight on the 15th in
    // Karachi. An administrator in New York logging time for Kamran must land
    // on Kamran's day.
    const ctx = createCtx({
      actor: ctxFor(alice, "administrator").actor,
      now: () => at("2026-08-14T19:30:00Z"),
    });

    const { entry } = await createTimeEntry(ctx, {
      userId: karachi, projectId, taskId: designTaskId, durationSeconds: 3600,
    });

    expect(entry.spentOn).toBe("2026-08-15");
  });

  it("gives a non-billable task a zero rate", async () => {
    const ctx = ctxFor(alice, "administrator");
    const { entry } = await createTimeEntry(ctx, {
      projectId, taskId: supportTaskId, spentOn: TODAY, durationSeconds: 3600,
    });

    expect(entry.isBillable).toBe(false);
    expect(entry.billableRateCents).toBe(0);
    // Cost is independent of billing: the hour still costs what it costs.
    expect(entry.costRateCents).toBe(6000);
  });

  it("gives fixed-fee time a zero billable rate, because the fee is the revenue", async () => {
    const ctx = ctxFor(alice, "administrator");
    const { entry } = await createTimeEntry(ctx, {
      projectId: fixedFeeProjectId, taskId: designTaskId, spentOn: TODAY, durationSeconds: 3600,
    });
    expect(entry.billableRateCents).toBe(0);
  });

  it("refuses a task that is not on the project", async () => {
    const ctx = ctxFor(alice, "administrator");
    const orphanTask = newId();
    await db.insert(s.tasks).values({ id: orphanTask, name: "Orphan" });

    await expect(
      createTimeEntry(ctx, { projectId, taskId: orphanTask, spentOn: TODAY, durationSeconds: 3600 })
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("refuses an archived project", async () => {
    const ctx = ctxFor(alice, "administrator");
    await db.update(s.projects).set({ archivedAt: new Date() }).where(eq(s.projects.id, projectId));

    await expect(
      createTimeEntry(ctx, { projectId, taskId: designTaskId, spentOn: TODAY, durationSeconds: 3600 })
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("refuses a future date when the account does not allow them", async () => {
    const ctx = ctxFor(alice, "administrator");
    await expect(
      createTimeEntry(ctx, { projectId, taskId: designTaskId, spentOn: "2026-09-01", durationSeconds: 3600 })
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("refuses a Member logging time for somebody else", async () => {
    const ctx = ctxFor(karachi, "member", "Asia/Karachi");
    await expect(
      createTimeEntry(ctx, { userId: alice, projectId, taskId: designTaskId, durationSeconds: 3600 })
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});

/* ================================================================= timers */

describe("timers", () => {
  it("starts a timer with no duration and a start time", async () => {
    const ctx = ctxFor(alice, "administrator");
    const { entry } = await createTimeEntry(ctx, { projectId, taskId: designTaskId, start: true });

    expect(entry.timerStartedAt).not.toBeNull();
    expect(entry.durationSeconds).toBe(0);
  });

  it("stops the running timer before starting another, in one transaction", async () => {
    const ctx = ctxFor(alice, "administrator");
    const first = await createTimeEntry(ctx, { projectId, taskId: designTaskId, start: true });
    expect(first.stopped).toBeNull();

    const second = await createTimeEntry(ctx, { projectId, taskId: supportTaskId, start: true });

    // The API returns both, so the client can show one combined toast.
    expect(second.stopped?.id).toBe(first.entry.id);
    expect(second.stopped?.timerStartedAt).toBeNull();

    const running = await db
      .select()
      .from(s.timeEntries)
      .where(and(eq(s.timeEntries.userId, alice), isNull(s.timeEntries.deletedAt)));
    expect(running.filter((r) => r.timerStartedAt !== null)).toHaveLength(1);
  });

  it("keeps each person's timer separate", async () => {
    const aliceCtx = ctxFor(alice, "administrator");
    const kamranCtx = ctxFor(karachi, "member", "Asia/Karachi");

    await createTimeEntry(aliceCtx, { projectId, taskId: designTaskId, start: true });
    await createTimeEntry(kamranCtx, { projectId, taskId: designTaskId, start: true });

    expect(await runningEntry(aliceCtx)).not.toBeNull();
    expect(await runningEntry(kamranCtx)).not.toBeNull();
  });

  it("accrues duration from the server clock when stopped", async () => {
    const ctx = ctxFor(alice, "administrator");
    const { entry } = await createTimeEntry(ctx, { projectId, taskId: designTaskId, start: true });

    // Backdate the start so there is measurable elapsed time.
    await db
      .update(s.timeEntries)
      .set({ timerStartedAt: new Date(Date.now() - 90_000) })
      .where(eq(s.timeEntries.id, entry.id));

    const stopped = await stopTimer(ctx);
    expect(stopped?.durationSeconds).toBeGreaterThanOrEqual(89);
    expect(stopped?.timerStartedAt).toBeNull();
  });

  it("returns null when there is nothing to stop", async () => {
    const ctx = ctxFor(alice, "administrator");
    await expect(stopTimer(ctx)).resolves.toBeNull();
  });
});

/* =============================================================== editing */

describe("editing", () => {
  it("re-resolves rates when the date moves", async () => {
    const ctx = ctxFor(alice, "administrator");
    await db.update(s.userRates).set({ endsOn: "2026-08-10" }).where(
      and(eq(s.userRates.userId, alice), eq(s.userRates.kind, "billable"))
    );
    await db.insert(s.userRates).values({
      id: newId(), userId: alice, kind: "billable", amountCents: 20000, startsOn: "2026-08-11",
    });

    const { entry } = await createTimeEntry(ctx, {
      projectId, taskId: designTaskId, spentOn: TODAY, durationSeconds: 3600,
    });
    expect(entry.billableRateCents).toBe(20000);

    const moved = await updateTimeEntry(ctx, entry.id, { spentOn: "2026-08-05" });
    expect(moved.billableRateCents).toBe(15000);
  });

  it("leaves rates alone when only the note changes", async () => {
    const ctx = ctxFor(alice, "administrator");
    const { entry } = await createTimeEntry(ctx, {
      projectId, taskId: designTaskId, spentOn: TODAY, durationSeconds: 3600,
    });

    await db.update(s.userRates).set({ amountCents: 99999 }).where(
      and(eq(s.userRates.userId, alice), eq(s.userRates.kind, "billable"))
    );

    const edited = await updateTimeEntry(ctx, entry.id, { notes: "Changed my mind about the note" });
    expect(edited.billableRateCents).toBe(15000);
  });

  it("refuses to edit an entry on a sent invoice", async () => {
    // A Member, not an administrator: administrators legitimately override
    // every lock, which is asserted separately below.
    const ctx = ctxFor(karachi, "member", "Asia/Karachi");
    const { entry } = await createTimeEntry(ctx, {
      projectId, taskId: designTaskId, spentOn: TODAY, durationSeconds: 3600,
    });

    const invoiceId = newId();
    await db.insert(s.invoices).values({
      id: invoiceId, clientId, number: "INV-1", issueDate: TODAY, dueDate: "2026-09-14", state: "open",
    });
    await db.update(s.timeEntries).set({ invoiceId }).where(eq(s.timeEntries.id, entry.id));

    await expect(updateTimeEntry(ctx, entry.id, { durationSeconds: 7200 })).rejects.toMatchObject({
      code: "record_locked",
    });
  });

  it("lets an administrator override an invoice lock, and records it", async () => {
    const member = ctxFor(karachi, "member", "Asia/Karachi");
    const { entry } = await createTimeEntry(member, {
      projectId, taskId: designTaskId, spentOn: TODAY, durationSeconds: 3600,
    });

    const invoiceId = newId();
    await db.insert(s.invoices).values({
      id: invoiceId, clientId, number: "INV-3", issueDate: TODAY, dueDate: "2026-09-14", state: "open",
    });
    await db.update(s.timeEntries).set({ invoiceId }).where(eq(s.timeEntries.id, entry.id));

    const admin = ctxFor(alice, "administrator");
    await expect(updateTimeEntry(admin, entry.id, { durationSeconds: 7200 })).resolves.toMatchObject({
      durationSeconds: 7200,
    });
  });

  it("allows editing an entry on a draft invoice", async () => {
    const ctx = ctxFor(karachi, "member", "Asia/Karachi");
    const { entry } = await createTimeEntry(ctx, {
      projectId, taskId: designTaskId, spentOn: TODAY, durationSeconds: 3600,
    });

    const invoiceId = newId();
    await db.insert(s.invoices).values({
      id: invoiceId, clientId, number: "INV-2", issueDate: TODAY, dueDate: "2026-09-14", state: "draft",
    });
    await db.update(s.timeEntries).set({ invoiceId }).where(eq(s.timeEntries.id, entry.id));

    await expect(updateTimeEntry(ctx, entry.id, { durationSeconds: 7200 })).resolves.toMatchObject({
      durationSeconds: 7200,
    });
  });

  it("refuses to create into an approved week, for the owner", async () => {
    await db.insert(s.timesheetSubmissions).values({
      id: newId(), userId: karachi, periodStart: "2026-08-03", periodEnd: "2026-08-09", state: "approved",
    });

    const ctx = ctxFor(karachi, "member", "Asia/Karachi");
    await expect(
      createTimeEntry(ctx, { projectId, taskId: designTaskId, spentOn: "2026-08-05", durationSeconds: 3600 })
    ).rejects.toMatchObject({ code: "period_approved" });
  });

  it("lets an administrator write into an approved week, and records the override", async () => {
    await db.insert(s.timesheetSubmissions).values({
      id: newId(), userId: karachi, periodStart: "2026-08-03", periodEnd: "2026-08-09", state: "approved",
    });

    const ctx = ctxFor(alice, "administrator");
    const { entry } = await createTimeEntry(ctx, {
      userId: karachi, projectId, taskId: designTaskId, spentOn: "2026-08-05", durationSeconds: 3600,
    });
    expect(entry.spentOn).toBe("2026-08-05");

    const audits = await db.select().from(s.auditLog);
    expect(audits.some((a) => a.action.endsWith(".override"))).toBe(true);
  });

  it("marks an entry in an approved week as locked when listing", async () => {
    const ctx = ctxFor(alice, "administrator");
    const { entry } = await createTimeEntry(ctx, {
      userId: karachi, projectId, taskId: designTaskId, spentOn: TODAY, durationSeconds: 3600,
    });

    await db.insert(s.timesheetSubmissions).values({
      id: newId(), userId: karachi, periodStart: "2026-08-10", periodEnd: "2026-08-16", state: "approved",
    });

    const kamranCtx = ctxFor(karachi, "member", "Asia/Karachi");
    const [listed] = await listTimeEntries(kamranCtx, { userId: karachi });
    expect(listed!.id).toBe(entry.id);
    expect(listed!.locked).toBe(true);
    expect(listed!.lockReasons).toContain("period_approved");
  });
});

/* ============================================================== deleting */

describe("deleting", () => {
  it("soft deletes and restores", async () => {
    const ctx = ctxFor(alice, "administrator");
    const { entry } = await createTimeEntry(ctx, {
      projectId, taskId: designTaskId, spentOn: TODAY, durationSeconds: 3600,
    });

    await deleteTimeEntry(ctx, entry.id);
    await expect(getTimeEntry(ctx, entry.id)).rejects.toMatchObject({ code: "not_found" });

    const restored = await restoreTimeEntry(ctx, entry.id);
    expect(restored.id).toBe(entry.id);
  });
});

/* =============================================== split, duplicate, copy day */

describe("split and duplicate", () => {
  it("splits an entry into two that sum to the original", async () => {
    const ctx = ctxFor(alice, "administrator");
    const { entry } = await createTimeEntry(ctx, {
      projectId, taskId: designTaskId, spentOn: TODAY, durationSeconds: 3600,
    });

    const [first, second] = await splitTimeEntry(ctx, entry.id, 1200);
    expect(first!.durationSeconds + second!.durationSeconds).toBe(3600);
    // The split inherits the snapshot rather than repricing half the work.
    expect(second!.billableRateCents).toBe(entry.billableRateCents);
  });

  it("refuses a split outside the entry", async () => {
    const ctx = ctxFor(alice, "administrator");
    const { entry } = await createTimeEntry(ctx, {
      projectId, taskId: designTaskId, spentOn: TODAY, durationSeconds: 3600,
    });
    await expect(splitTimeEntry(ctx, entry.id, 3600)).rejects.toMatchObject({ code: "validation_failed" });
    await expect(splitTimeEntry(ctx, entry.id, 0)).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("duplicates onto another day", async () => {
    const ctx = ctxFor(alice, "administrator");
    const { entry } = await createTimeEntry(ctx, {
      projectId, taskId: designTaskId, spentOn: "2026-08-12", durationSeconds: 3600, notes: "Same work",
    });

    const copy = await duplicateTimeEntry(ctx, entry.id, "2026-08-13");
    expect(copy.spentOn).toBe("2026-08-13");
    expect(copy.notes).toBe("Same work");
    expect(copy.id).not.toBe(entry.id);
  });

  it("copies a day, optionally without the durations", async () => {
    const ctx = ctxFor(alice, "administrator");
    await createTimeEntry(ctx, { projectId, taskId: designTaskId, spentOn: "2026-08-12", durationSeconds: 3600 });
    await createTimeEntry(ctx, { projectId, taskId: supportTaskId, spentOn: "2026-08-12", durationSeconds: 1800 });

    const copied = await copyDay(ctx, { from: "2026-08-12", to: "2026-08-13" });
    expect(copied).toHaveLength(2);
    expect(copied.every((e) => e.durationSeconds === 0)).toBe(true);

    const withDurations = await copyDay(ctx, { from: "2026-08-12", to: "2026-08-14", includeDurations: true });
    expect(withDurations.map((e) => e.durationSeconds).sort()).toEqual([1800, 3600]);
  });
});

/* ============================================================== week grid */

describe("the week grid", () => {
  it("creates, updates, and removes in one round trip", async () => {
    const ctx = ctxFor(alice, "administrator");

    const first = await upsertWeek(ctx, {
      weekStart: "2026-08-10",
      rows: [
        {
          projectId, taskId: designTaskId, notes: null,
          days: { "2026-08-10": 3600, "2026-08-11": 7200 },
        },
      ],
    });
    expect(first.entries).toHaveLength(2);

    // Change one day, remove the other, add a third.
    const second = await upsertWeek(ctx, {
      weekStart: "2026-08-10",
      rows: [
        {
          projectId, taskId: designTaskId, notes: null,
          days: { "2026-08-10": 5400, "2026-08-11": 0, "2026-08-12": 1800 },
        },
      ],
    });

    const byDay = Object.fromEntries(second.entries.map((e) => [e.spentOn, e.durationSeconds]));
    expect(byDay["2026-08-10"]).toBe(5400);
    expect(byDay["2026-08-11"]).toBeUndefined();
    expect(byDay["2026-08-12"]).toBe(1800);
  });

  it("skips locked days rather than failing the whole week", async () => {
    const ctx = ctxFor(alice, "administrator");

    // Kamran has an approved week; he is filling in the rest himself.
    await db.insert(s.timesheetSubmissions).values({
      id: newId(), userId: karachi, periodStart: "2026-08-10", periodEnd: "2026-08-11", state: "approved",
    });

    const kamranCtx = ctxFor(karachi, "member", "Asia/Karachi");
    const result = await upsertWeek(kamranCtx, {
      weekStart: "2026-08-10",
      rows: [
        {
          projectId, taskId: designTaskId, notes: null,
          days: { "2026-08-10": 3600, "2026-08-13": 7200 },
        },
      ],
    });

    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.spentOn).toBe("2026-08-10");
    // The unlocked day still landed.
    expect(result.entries.map((e) => e.spentOn)).toContain("2026-08-13");
  });

  it("treats a different note as a different row", async () => {
    const ctx = ctxFor(alice, "administrator");
    await upsertWeek(ctx, {
      weekStart: "2026-08-10",
      rows: [
        { projectId, taskId: designTaskId, notes: "Morning", days: { "2026-08-10": 3600 } },
        { projectId, taskId: designTaskId, notes: "Afternoon", days: { "2026-08-10": 1800 } },
      ],
    });

    const entries = await listTimeEntries(ctx, { userId: alice, from: "2026-08-10", to: "2026-08-10" });
    expect(entries).toHaveLength(2);
  });
});

/* ================================================================ summary */

describe("the timesheet summary", () => {
  it("totals per day and flags missing working days", async () => {
    const ctx = ctxFor(alice, "administrator");
    await createTimeEntry(ctx, { projectId, taskId: designTaskId, spentOn: "2026-08-10", durationSeconds: 3600 });
    await createTimeEntry(ctx, { projectId, taskId: designTaskId, spentOn: "2026-08-11", durationSeconds: 8 * 3600 });

    const summary = await timesheetSummary(ctx, { from: "2026-08-10", to: "2026-08-16" });
    const byDay = Object.fromEntries(summary.days.map((d) => [d.spentOn, d]));

    expect(byDay["2026-08-10"]!.totalSeconds).toBe(3600);
    expect(byDay["2026-08-10"]!.missing).toBe(true); // under the 8h threshold
    expect(byDay["2026-08-11"]!.missing).toBe(false);
    // Today is still in progress, so it is not a gap.
    expect(byDay["2026-08-14"]!.missing).toBe(false);
    // Neither is a weekend.
    expect(byDay["2026-08-15"]!.missing).toBe(false);
    expect(byDay["2026-08-16"]!.missing).toBe(false);
  });
});
