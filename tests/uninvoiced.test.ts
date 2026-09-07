/**
 * The Uninvoiced screen (TALLY-34).
 *
 * One assertion in this file matters more than the rest: **the total this
 * screen shows a client equals the invoice that client's preview then offers.**
 * A billing screen that quotes a figure the next screen contradicts is worse
 * than no screen, because somebody will trust the first one.
 *
 * The two are computed in different languages. `listUninvoiced` is SQL, because
 * it runs over every client at once; `previewLines` is TypeScript over rows,
 * because it also has to produce the lines. Nothing about the code makes them
 * agree, so the agreement is asserted here, on data shaped to make rounding
 * bite: rates that do not divide evenly into an hour, several rates on one
 * project, and durations that are not whole hours.
 *
 * `tests/invoices.test.ts` already holds the next link in the same chain, that
 * a preview equals the invoice it produces. Together they run from this screen
 * to the money.
 */

import { beforeEach, afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  closeDb, db, makeClient, makeProject, makeProjectTask, makeTask, resetDb, s, seedSettings,
} from "./helpers";
import { newId } from "@/server/db/ids";
import { syncBaseProfiles } from "@/server/auth/profiles";
import { createCtx, type Actor, type Ctx } from "@/server/ctx";
import { BASE_PROFILES, type BaseProfileKey, type Capability } from "@/server/auth/capabilities";
import {
  listUninvoiced, previewLines, createInvoice, markBilledExternally,
} from "@/server/services/invoices";

let profiles: Record<string, string>;
const people: Record<string, string> = {};

async function ctxFor(key: string): Promise<Ctx> {
  const userId = people[key]!;
  const [row] = await db
    .select({
      timezone: s.users.timezone,
      isOwner: s.users.isOwner,
      profileId: s.permissionProfiles.id,
      baseKey: s.permissionProfiles.baseKey,
      capabilities: s.permissionProfiles.capabilities,
    })
    .from(s.users)
    .innerJoin(s.permissionProfiles, eq(s.permissionProfiles.id, s.users.profileId))
    .where(eq(s.users.id, userId))
    .limit(1);

  const actor: Actor = {
    userId,
    profileId: row!.profileId,
    baseKey: row!.baseKey,
    capabilities: new Set(row!.capabilities as Capability[]),
    kind: "user",
    timezone: row!.timezone,
    isOwner: row!.isOwner,
  };
  return createCtx({ actor });
}

/** Billable time on a project, at a rate, for a number of seconds. */
async function logTime(opts: {
  projectId: string;
  projectTaskId: string;
  seconds: number;
  rateCents: number;
  spentOn: string;
  billable?: boolean;
  billedExternally?: boolean;
}) {
  const id = newId();
  await db.insert(s.timeEntries).values({
    id,
    userId: people.administrator!,
    projectId: opts.projectId,
    projectTaskId: opts.projectTaskId,
    spentOn: opts.spentOn,
    durationSeconds: opts.seconds,
    isBillable: opts.billable ?? true,
    billableRateCents: opts.rateCents,
    billedExternally: opts.billedExternally ?? false,
  });
  return id;
}

beforeEach(async () => {
  await resetDb();
  profiles = (await syncBaseProfiles(db)).ids;

  for (const key of Object.keys(BASE_PROFILES) as BaseProfileKey[]) {
    const id = newId();
    people[key] = id;
    await db.insert(s.users).values({
      id,
      email: `${key}@jhmediagroup.com`,
      firstName: key,
      lastName: "Person",
      profileId: profiles[key]!,
    });
  }
  await seedSettings();
});

afterAll(async () => {
  await closeDb();
});

describe("listUninvoiced", () => {
  it("shows nothing when everything has been billed", async () => {
    const ctx = await ctxFor("administrator");
    expect(await listUninvoiced(ctx)).toEqual([]);
  });

  it("takes work off the list when it was billed in QuickBooks, and puts it back", async () => {
    /*
      JH Media Group bills through QuickBooks and logs the time here. Without
      this, every hour they bill stays uninvoiced for ever and reads as a
      receivable nobody is going to collect through Tally.

      `billedExternally` already existed for the Harvest migration and was
      honoured by every read that matters. Nothing in the product could set it,
      so it was import-only. This asserts the round trip, because the undo is
      the part somebody will reach for in a hurry.
    */
    const ctx = await ctxFor("administrator");
    const clientId = await makeClient("QuickBooks Co");
    const projectId = await makeProject(clientId, { name: "Billed elsewhere" });
    const taskId = await makeProjectTask(projectId, await makeTask());

    const entryId = await logTime({
      projectId, projectTaskId: taskId, seconds: 3600, rateCents: 20_000, spentOn: "2026-07-02",
    });

    expect((await previewLines(ctx, { clientId })).length, "available before").toBe(1);

    const marked = await markBilledExternally(ctx, {
      clientId, timeEntryIds: [entryId], billed: true,
    });
    expect(marked.timeEntries).toBe(1);
    expect(await previewLines(ctx, { clientId }), "gone from uninvoiced").toEqual([]);

    // And back again, which is what the toast's undo calls.
    const undone = await markBilledExternally(ctx, {
      clientId, timeEntryIds: [entryId], billed: false,
    });
    expect(undone.timeEntries).toBe(1);
    expect((await previewLines(ctx, { clientId })).length, "available again").toBe(1);
  });

  it("claims nothing on a repeat, so a retry is harmless", async () => {
    // The route carries no idempotency key, on the grounds that setting a
    // boolean to a value it already holds claims no rows. That is the claim,
    // so it is asserted rather than assumed.
    const ctx = await ctxFor("administrator");
    const clientId = await makeClient("Retry Co");
    const projectId = await makeProject(clientId, { name: "Retry" });
    const taskId = await makeProjectTask(projectId, await makeTask());
    const entryId = await logTime({
      projectId, projectTaskId: taskId, seconds: 3600, rateCents: 20_000, spentOn: "2026-07-02",
    });

    expect((await markBilledExternally(ctx, { clientId, timeEntryIds: [entryId], billed: true })).timeEntries).toBe(1);
    expect(
      (await markBilledExternally(ctx, { clientId, timeEntryIds: [entryId], billed: true })).timeEntries,
      "second call claims nothing"
    ).toBe(0);
  });

  it("refuses to mark work belonging to another client", async () => {
    // Same guard `attachRecords` applies. Without it, an id from one client
    // could take another client's hours off the list.
    const ctx = await ctxFor("administrator");
    const mine = await makeClient("Mine");
    const theirs = await makeClient("Theirs");
    const projectId = await makeProject(theirs, { name: "Not mine" });
    const taskId = await makeProjectTask(projectId, await makeTask());
    const entryId = await logTime({
      projectId, projectTaskId: taskId, seconds: 3600, rateCents: 20_000, spentOn: "2026-07-02",
    });

    const result = await markBilledExternally(ctx, { clientId: mine, timeEntryIds: [entryId], billed: true });
    expect(result.timeEntries, "claimed nothing from the other client").toBe(0);
  });

  it("flags hours that have no billable rate behind them", async () => {
    /*
      An invoice reading $0.00 with real hours on it was the first anybody
      heard that no project had a rate (t-Fg-4v7). Every active project was
      billed by project rate and not one had a rate set, so entries snapshotted
      zero, `resolveRates` returned `rateMissing: true` every time, and nothing
      in the application read it.

      The flag is inferred from the line rather than read off the entry,
      because the entry stores the resolved number and not the fact that
      resolution failed. This asserts the inference is right in both
      directions, which is the part that could rot.
    */
    const ctx = await ctxFor("administrator");
    const clientId = await makeClient("No Rates Co");
    const projectId = await makeProject(clientId, { name: "Unpriced" });
    const taskId = await makeProjectTask(projectId, await makeTask());

    await logTime({ projectId, projectTaskId: taskId, seconds: 7200, rateCents: 0, spentOn: "2026-07-02" });

    const [line] = await previewLines(ctx, { clientId });

    expect(line!.quantity, "the hours are there").toBe(2);
    expect(line!.amountCents, "and they value at nothing").toBe(0);
    expect(line!.rateMissing, "which is the thing that has to be said out loud").toBe(true);
  });

  it("does not call a priced line rate-missing", async () => {
    // The other direction. A line with a rate must never carry the warning, or
    // the banner cries wolf on every invoice and stops being read.
    const ctx = await ctxFor("administrator");
    const clientId = await makeClient("Priced Co");
    const projectId = await makeProject(clientId, { name: "Priced" });
    const taskId = await makeProjectTask(projectId, await makeTask());

    await logTime({ projectId, projectTaskId: taskId, seconds: 3600, rateCents: 15_000, spentOn: "2026-07-02" });

    const [line] = await previewLines(ctx, { clientId });
    expect(line!.amountCents).toBe(15_000);
    expect(line!.rateMissing).toBe(false);
  });

  it("shows a client with unbilled time, and the period it covers", async () => {
    const ctx = await ctxFor("administrator");
    const clientId = await makeClient("Example Client 43");
    const projectId = await makeProject(clientId, { name: "Website" });
    const taskId = await makeProjectTask(projectId, await makeTask());

    await logTime({ projectId, projectTaskId: taskId, seconds: 7200, rateCents: 15_000, spentOn: "2026-07-02" });
    await logTime({ projectId, projectTaskId: taskId, seconds: 3600, rateCents: 15_000, spentOn: "2026-07-20" });

    const [row] = await listUninvoiced(ctx);

    expect(row!.clientName).toBe("Example Client 43");
    expect(row!.hours).toBe(3);
    expect(row!.totalCents).toBe(45_000);
    expect(row!.from).toBe("2026-07-02");
    expect(row!.to).toBe("2026-07-20");
  });

  /**
   * The assertion the ticket was written around.
   *
   * Rates chosen so that no line divides evenly into an hour, and three rates on
   * one project so the per-line rounding actually accumulates. Rounding once
   * over the client rather than once per line would land a few cents out here,
   * which is exactly the failure worth catching.
   */
  it("agrees with the invoice preview, to the cent", async () => {
    const ctx = await ctxFor("administrator");
    const clientId = await makeClient("Awkward Arithmetic");
    const projectA = await makeProject(clientId, { name: "Project A" });
    const projectB = await makeProject(clientId, { name: "Project B" });
    const task = await makeTask();
    const taskA = await makeProjectTask(projectA, task);
    const taskB = await makeProjectTask(projectB, task);

    const awkward = [
      { projectId: projectA, projectTaskId: taskA, seconds: 1_337, rateCents: 12_345 },
      { projectId: projectA, projectTaskId: taskA, seconds: 4_001, rateCents: 12_345 },
      { projectId: projectA, projectTaskId: taskA, seconds: 2_222, rateCents: 9_999 },
      { projectId: projectA, projectTaskId: taskA, seconds: 777, rateCents: 7_777 },
      { projectId: projectB, projectTaskId: taskB, seconds: 5_555, rateCents: 11_111 },
      { projectId: projectB, projectTaskId: taskB, seconds: 61, rateCents: 33_333 },
    ];
    for (const [i, e] of awkward.entries()) {
      await logTime({ ...e, spentOn: `2026-07-${String(i + 1).padStart(2, "0")}` });
    }

    const [summary] = await listUninvoiced(ctx);
    const lines = await previewLines(ctx, { clientId });
    const previewTotal = lines.reduce((sum, l) => sum + l.amountCents, 0);

    expect(
      summary!.totalCents,
      "the screen and the preview must never quote different figures"
    ).toBe(previewTotal);
  });

  /** And the next link: the preview equals the invoice it raises. */
  it("agrees with the invoice that is actually raised", async () => {
    const ctx = await ctxFor("administrator");
    const clientId = await makeClient("Example Client 43");
    const projectId = await makeProject(clientId, { name: "Website" });
    const taskId = await makeProjectTask(projectId, await makeTask());

    await logTime({ projectId, projectTaskId: taskId, seconds: 3_333, rateCents: 14_567, spentOn: "2026-07-02" });
    await logTime({ projectId, projectTaskId: taskId, seconds: 9_999, rateCents: 8_888, spentOn: "2026-07-03" });

    const [summary] = await listUninvoiced(ctx);
    const lines = await previewLines(ctx, { clientId });

    const invoice = await createInvoice(ctx, {
      clientId,
      issueDate: "2026-08-01",
      dueDate: "2026-08-31",
      lines: lines.map((l) => ({
        projectId: l.projectId,
        description: `${l.label} - ${l.sublabel}`,
        quantity: l.quantity,
        unitPriceCents: l.unitPriceCents,
        amountCents: l.amountCents,
      })),
    });

    expect(invoice.subtotalCents).toBe(summary!.totalCents);
  });

  it("counts billable expenses alongside time", async () => {
    const ctx = await ctxFor("administrator");
    const clientId = await makeClient("Example Client 43");
    const projectId = await makeProject(clientId, { name: "Website" });
    const taskId = await makeProjectTask(projectId, await makeTask());
    const [category] = await db
      .insert(s.expenseCategories)
      .values({ id: newId(), name: "Software" })
      .returning({ id: s.expenseCategories.id });

    await logTime({ projectId, projectTaskId: taskId, seconds: 3600, rateCents: 10_000, spentOn: "2026-07-10" });
    await db.insert(s.expenses).values({
      id: newId(),
      userId: people.administrator!,
      projectId,
      categoryId: category!.id,
      spentOn: "2026-06-01",
      totalCents: 4_200,
      isBillable: true,
    });

    const [row] = await listUninvoiced(ctx);

    expect(row!.timeCents).toBe(10_000);
    expect(row!.expenseCents).toBe(4_200);
    expect(row!.expenseCount).toBe(1);
    expect(row!.totalCents).toBe(14_200);
    expect(row!.from, "the period covers the expense too").toBe("2026-06-01");
  });

  it("ignores time that is not billable, already invoiced, or billed in Harvest", async () => {
    const ctx = await ctxFor("administrator");
    const clientId = await makeClient("Example Client 43");
    const projectId = await makeProject(clientId, { name: "Website" });
    const taskId = await makeProjectTask(projectId, await makeTask());

    await logTime({ projectId, projectTaskId: taskId, seconds: 3600, rateCents: 10_000, spentOn: "2026-07-01", billable: false });
    await logTime({ projectId, projectTaskId: taskId, seconds: 3600, rateCents: 10_000, spentOn: "2026-07-02", billedExternally: true });
    const invoiced = await logTime({ projectId, projectTaskId: taskId, seconds: 3600, rateCents: 10_000, spentOn: "2026-07-03" });

    const invoice = await createInvoice(ctx, {
      clientId,
      issueDate: "2026-08-01",
      dueDate: "2026-08-31",
      lines: [{ description: "Work", quantity: 1, unitPriceCents: 10_000 }],
    });
    await db
      .update(s.timeEntries)
      .set({ invoiceId: invoice.id })
      .where(eq(s.timeEntries.id, invoiced));

    expect(
      await listUninvoiced(ctx),
      "every remaining entry is excluded for a different reason"
    ).toEqual([]);
  });

  it("ignores a running timer, which has no settled duration yet", async () => {
    const ctx = await ctxFor("administrator");
    const clientId = await makeClient("Example Client 43");
    const projectId = await makeProject(clientId, { name: "Website" });
    const taskId = await makeProjectTask(projectId, await makeTask());

    const id = await logTime({ projectId, projectTaskId: taskId, seconds: 1800, rateCents: 10_000, spentOn: "2026-07-01" });
    await db
      .update(s.timeEntries)
      .set({ timerStartedAt: new Date("2026-07-01T09:00:00Z") })
      .where(eq(s.timeEntries.id, id));

    expect(await listUninvoiced(ctx)).toEqual([]);
  });

  it("lists several clients, largest first", async () => {
    const ctx = await ctxFor("administrator");
    const task = await makeTask();
    for (const [name, seconds] of [["Small", 3600], ["Large", 36_000], ["Middle", 7200]] as const) {
      const clientId = await makeClient(name);
      const projectId = await makeProject(clientId, { name: `${name} site` });
      const taskId = await makeProjectTask(projectId, task);
      await logTime({ projectId, projectTaskId: taskId, seconds, rateCents: 10_000, spentOn: "2026-07-01" });
    }

    expect((await listUninvoiced(ctx)).map((r) => r.clientName)).toEqual([
      "Large",
      "Middle",
      "Small",
    ]);
  });

  it("is refused for a Member", async () => {
    const ctx = await ctxFor("member");
    await expect(listUninvoiced(ctx)).rejects.toMatchObject({ code: "forbidden" });
  });
});
