/**
 * Re-rating, the one action allowed to change a rate snapshot.
 *
 * An entry keeps the rates it was written with. That rule is the reason a raise
 * in March does not rewrite what January cost, and it is enforced everywhere
 * else by simply never recomputing. The PRD and the schema comment have both
 * named an "explicit re-rate action" as the single exception since the
 * beginning, and nothing implemented it, so hours imported from Harvest with no
 * rate were worth nothing for ever (t-zNfxik, t-9Uli4l).
 *
 * The tests that matter here are the refusals. An action that rewrites money on
 * rows that already exist has to be provably unable to touch work that has been
 * billed, because an invoice already sent is a statement about money owed and
 * the hours behind it must keep agreeing with it.
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
import { reRateProject } from "@/server/services/rates";

let profiles: Record<string, string>;
const people: Record<string, string> = {};

function ctxFor(key: BaseProfileKey): Ctx {
  const actor: Actor = {
    userId: people[key]!,
    profileId: profiles[key]!,
    baseKey: key,
    capabilities: new Set(BASE_PROFILES[key].capabilities as readonly Capability[]),
    kind: "user",
    timezone: "America/New_York",
    isOwner: key === "administrator",
  };
  return createCtx({ actor });
}

async function logTime(opts: {
  projectId: string;
  projectTaskId: string;
  seconds: number;
  rateCents: number;
  spentOn: string;
  invoiceId?: string;
  billedExternally?: boolean;
  ratesLockedAt?: Date;
}) {
  const id = newId();
  await db.insert(s.timeEntries).values({
    id,
    userId: people.administrator!,
    projectId: opts.projectId,
    projectTaskId: opts.projectTaskId,
    spentOn: opts.spentOn,
    durationSeconds: opts.seconds,
    isBillable: true,
    billableRateCents: opts.rateCents,
    costRateCents: 0,
    invoiceId: opts.invoiceId ?? null,
    billedExternally: opts.billedExternally ?? false,
    ratesLockedAt: opts.ratesLockedAt ?? null,
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
      timezone: "America/New_York",
    });
  }
  await seedSettings();
});

afterAll(closeDb);

describe("re-rating a project's unbilled hours", () => {
  it("gives a rate to hours that were written without one", async () => {
    /*
      The Example Client 07 case exactly. Every imported hour carried a snapshot of
      zero because the Harvest export had no rates in it. Setting the project
      rate afterwards correctly changed nothing, and there was no way to put
      the history right.
    */
    const ctx = ctxFor("administrator");
    const clientId = await makeClient("Example Client 07");
    const projectId = await makeProject(clientId, {
      name: "Example Client 07", billBy: "project", hourlyRateCents: 11_000,
    });
    const taskId = await makeProjectTask(projectId, await makeTask());

    const entryId = await logTime({
      projectId, projectTaskId: taskId, seconds: 3600, rateCents: 0, spentOn: "2026-07-02",
    });

    const outcome = await reRateProject(ctx, { projectId });

    expect(outcome.considered).toBe(1);
    expect(outcome.changed).toBe(1);
    expect(outcome.billableCentsBefore).toBe(0);
    expect(outcome.billableCentsAfter).toBe(11_000);

    const [row] = await db.select().from(s.timeEntries).where(eq(s.timeEntries.id, entryId));
    expect(row!.billableRateCents).toBe(11_000);
  });

  it("refuses to touch hours that are already on an invoice", async () => {
    // An invoice that has gone out is a statement about money owed. Rewriting
    // the hours behind it makes the document disagree with its own lines.
    const ctx = ctxFor("administrator");
    const clientId = await makeClient("Invoiced Co");
    const projectId = await makeProject(clientId, {
      name: "Invoiced", billBy: "project", hourlyRateCents: 20_000,
    });
    const taskId = await makeProjectTask(projectId, await makeTask());

    const invoiceId = newId();
    await db.insert(s.invoices).values({
      id: invoiceId,
      clientId,
      number: "INV-RERATE-1",
      state: "open",
      issueDate: "2026-07-01",
      dueDate: "2026-07-31",
      currency: "USD",
    });

    const entryId = await logTime({
      projectId, projectTaskId: taskId, seconds: 3600, rateCents: 0, spentOn: "2026-07-02", invoiceId,
    });

    const outcome = await reRateProject(ctx, { projectId });

    expect(outcome.considered, "not even considered").toBe(0);
    expect(outcome.skipped.invoiced, "and counted, so the operator is told").toBe(1);

    const [row] = await db.select().from(s.timeEntries).where(eq(s.timeEntries.id, entryId));
    expect(row!.billableRateCents, "untouched").toBe(0);
  });

  it("refuses to touch hours billed outside Tally, or locked ones", async () => {
    // Billed in QuickBooks is the same promise kept somewhere else, and a rate
    // lock is somebody having said this entry is settled.
    const ctx = ctxFor("administrator");
    const clientId = await makeClient("Elsewhere Co");
    const projectId = await makeProject(clientId, {
      name: "Elsewhere", billBy: "project", hourlyRateCents: 20_000,
    });
    const taskId = await makeProjectTask(projectId, await makeTask());

    const externalId = await logTime({
      projectId, projectTaskId: taskId, seconds: 3600, rateCents: 0,
      spentOn: "2026-07-02", billedExternally: true,
    });
    const lockedId = await logTime({
      projectId, projectTaskId: taskId, seconds: 3600, rateCents: 0,
      spentOn: "2026-07-03", ratesLockedAt: new Date("2026-07-04T00:00:00Z"),
    });

    const outcome = await reRateProject(ctx, { projectId });

    expect(outcome.considered).toBe(0);
    expect(outcome.skipped.billedExternally).toBe(1);
    expect(outcome.skipped.locked).toBe(1);

    for (const id of [externalId, lockedId]) {
      const [row] = await db.select().from(s.timeEntries).where(eq(s.timeEntries.id, id));
      expect(row!.billableRateCents).toBe(0);
    }
  });

  it("writes nothing on a dry run, and says what it would do", async () => {
    // The screen shows the money before anybody commits to it, so the preview
    // has to be the same computation as the action and change nothing.
    const ctx = ctxFor("administrator");
    const clientId = await makeClient("Preview Co");
    const projectId = await makeProject(clientId, {
      name: "Preview", billBy: "project", hourlyRateCents: 15_000,
    });
    const taskId = await makeProjectTask(projectId, await makeTask());
    const entryId = await logTime({
      projectId, projectTaskId: taskId, seconds: 7200, rateCents: 0, spentOn: "2026-07-02",
    });

    const preview = await reRateProject(ctx, { projectId, dryRun: true });
    expect(preview.changed).toBe(1);
    expect(preview.billableCentsAfter).toBe(30_000);

    const [row] = await db.select().from(s.timeEntries).where(eq(s.timeEntries.id, entryId));
    expect(row!.billableRateCents, "still untouched").toBe(0);

    const done = await reRateProject(ctx, { projectId });
    expect(done.changed, "the real run agrees with its own preview").toBe(1);
    expect(done.billableCentsAfter).toBe(30_000);
  });

  it("is safe to run twice, reporting the second pass as unchanged", async () => {
    // The route carries no idempotency key on the grounds that re-resolving
    // unmoved inputs produces the same answer. That is the claim, so it is
    // asserted rather than assumed.
    const ctx = ctxFor("administrator");
    const clientId = await makeClient("Twice Co");
    const projectId = await makeProject(clientId, {
      name: "Twice", billBy: "project", hourlyRateCents: 12_500,
    });
    const taskId = await makeProjectTask(projectId, await makeTask());
    await logTime({ projectId, projectTaskId: taskId, seconds: 3600, rateCents: 0, spentOn: "2026-07-02" });

    expect((await reRateProject(ctx, { projectId })).changed).toBe(1);

    const second = await reRateProject(ctx, { projectId });
    expect(second.changed, "nothing left to do").toBe(0);
    expect(second.unchanged).toBe(1);
  });

  it("records which entries it rewrote, not just how many", async () => {
    /*
      This is the one action allowed to change money on rows that already
      exist, so the audit has to answer "which entries, and to what" long after
      the fact. A count cannot.
    */
    const ctx = ctxFor("administrator");
    const clientId = await makeClient("Audited Co");
    const projectId = await makeProject(clientId, {
      name: "Audited", billBy: "project", hourlyRateCents: 9_000,
    });
    const taskId = await makeProjectTask(projectId, await makeTask());
    const entryId = await logTime({
      projectId, projectTaskId: taskId, seconds: 3600, rateCents: 0, spentOn: "2026-07-02",
    });

    await reRateProject(ctx, { projectId });

    const rows = await db.select().from(s.auditLog).where(eq(s.auditLog.action, "rates.re_rate"));
    const after = rows.at(-1)!.after as {
      entries: { id: string; billableRateCents: number }[];
      changed: number;
    };
    expect(after.changed).toBe(1);
    expect(after.entries).toEqual([
      { id: entryId, billableRateCents: 9_000, costRateCents: 0 },
    ]);
  });

  it("refuses somebody who may not manage rates", async () => {
    const ctx = ctxFor("member");
    const clientId = await makeClient("Guarded Co");
    const projectId = await makeProject(clientId, {
      name: "Guarded", billBy: "project", hourlyRateCents: 10_000,
    });
    const taskId = await makeProjectTask(projectId, await makeTask());
    await logTime({ projectId, projectTaskId: taskId, seconds: 3600, rateCents: 0, spentOn: "2026-07-02" });

    await expect(reRateProject(ctx, { projectId })).rejects.toThrow();
  });
});
