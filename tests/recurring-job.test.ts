/**
 * The daily run that raises recurring invoices (TALLY-26).
 *
 * The design choice this file has to justify is the absence of a queue. There
 * is no worker and no retry machinery: the run is a plain loop from cron, and
 * every property a queue would have sold us is asserted here against the
 * database instead.
 *
 *   - Running it twice on the same day bills nobody twice.
 *   - A schedule that is not due is left alone.
 *   - One broken schedule does not stop the other thirty.
 *   - A schedule that has reached its limit finishes rather than running on.
 *
 * The first of those is the one that would cost real money, and it is the one
 * an operator is most likely to test by accident.
 */

import { beforeEach, afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, db, makeClient, resetDb, s, seedSettings } from "./helpers";
import { newId } from "@/server/db/ids";
import { syncBaseProfiles } from "@/server/auth/profiles";
import { createCtx, type Actor, type Ctx } from "@/server/ctx";
import { BASE_PROFILES, type BaseProfileKey, type Capability } from "@/server/auth/capabilities";
import {
  createRecurring,
  getRecurring,
  runDueRecurring,
  setRecurringState,
  type RecurringInput,
} from "@/server/services/recurring";
import { listInvoices } from "@/server/services/invoices";

let profiles: Record<string, string>;
const people: Record<string, string> = {};
let clientId: string;

async function ctxFor(key: string, at?: Date): Promise<Ctx> {
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
  return createCtx({ actor, ...(at ? { now: () => at } : {}) });
}

const plan = (over: Partial<RecurringInput> = {}): RecurringInput => ({
  clientId,
  subject: "Support Plan - Maintenance",
  frequency: "monthly",
  interval: 1,
  startsOn: "2026-09-01",
  paymentTermDays: 15,
  lines: [{ description: "Monthly support", quantity: 1, unitPriceCents: 160_000 }],
  ...over,
});

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
  clientId = await makeClient("Example Client 43");
});

afterAll(async () => {
  await closeDb();
});

describe("runDueRecurring", () => {
  it("issues a schedule that is due and advances it", async () => {
    const ctx = await ctxFor("administrator", new Date("2026-08-14T15:00:00Z"));
    const schedule = await createRecurring(ctx, plan());

    const outcome = await runDueRecurring(ctx, "2026-09-01");

    expect(outcome.issued).toHaveLength(1);
    expect(outcome.failed).toHaveLength(0);
    expect(outcome.issued[0]!.scheduleId).toBe(schedule.id);

    const after = await getRecurring(ctx, schedule.id);
    expect(after.nextIssueOn).toBe("2026-10-01");
    expect(after.lastIssuedOn).toBe("2026-09-01");
  });

  /**
   * The property the whole cron-not-a-queue decision rests on.
   *
   * The second run reads a schedule whose `nextIssueOn` the first run already
   * moved past today, so it finds nothing due. This is what makes a missed day
   * fixable by running it again, and an overlapping run harmless.
   */
  it("bills nobody twice when the run happens twice", async () => {
    const ctx = await ctxFor("administrator", new Date("2026-08-14T15:00:00Z"));
    await createRecurring(ctx, plan());

    const first = await runDueRecurring(ctx, "2026-09-01");
    const second = await runDueRecurring(ctx, "2026-09-01");

    expect(first.issued, "the first run raises it").toHaveLength(1);
    expect(second.issued, "the second run finds nothing due").toHaveLength(0);

    const invoices = await listInvoices(ctx, {});
    expect(invoices, "one invoice exists, not two").toHaveLength(1);
  });

  it("leaves a schedule that is not due yet alone", async () => {
    const ctx = await ctxFor("administrator", new Date("2026-08-14T15:00:00Z"));
    await createRecurring(ctx, plan());

    const outcome = await runDueRecurring(ctx, "2026-08-31");

    expect(outcome.issued).toHaveLength(0);
    expect(await listInvoices(ctx, {})).toHaveLength(0);
  });

  it("skips a paused schedule even when its date has passed", async () => {
    const ctx = await ctxFor("administrator", new Date("2026-08-14T15:00:00Z"));
    const schedule = await createRecurring(ctx, plan());
    await setRecurringState(ctx, schedule.id, "paused");

    const outcome = await runDueRecurring(ctx, "2026-12-01");

    expect(outcome.issued).toHaveLength(0);
    expect(await listInvoices(ctx, {})).toHaveLength(0);
  });

  it("issues several due schedules in one run", async () => {
    const ctx = await ctxFor("administrator", new Date("2026-08-14T15:00:00Z"));
    await createRecurring(ctx, plan({ subject: "One" }));
    await createRecurring(ctx, plan({ subject: "Two", startsOn: "2026-09-15" }));
    await createRecurring(ctx, plan({ subject: "Three", startsOn: "2026-10-01" }));

    const outcome = await runDueRecurring(ctx, "2026-09-20");

    expect(outcome.issued, "the two due, not the October one").toHaveLength(2);
    expect(await listInvoices(ctx, {})).toHaveLength(2);
  });

  /**
   * A schedule whose client was archived after it was written is the realistic
   * version of this: one row is broken, and the run has to bill the rest and
   * name the broken one rather than dying on it.
   */
  it("collects a failure and keeps going", async () => {
    const ctx = await ctxFor("administrator", new Date("2026-08-14T15:00:00Z"));
    const good = await createRecurring(ctx, plan({ subject: "Good" }));
    const bad = await createRecurring(ctx, plan({ subject: "Bad" }));

    // A payment term the editor would refuse, written straight into the row, so
    // the invoice it builds has a due date before its issue date and
    // `createInvoice` throws. This is what a bad import or a hand-edited row
    // looks like: the service's own validation never saw it.
    await db
      .update(s.recurringInvoices)
      .set({
        template: {
          lines: [{ description: "Monthly support", quantity: 1, unitPriceCents: 160_000 }],
          amountCents: 160_000,
          paymentTermDays: -30,
        },
      })
      .where(eq(s.recurringInvoices.id, bad.id));

    const outcome = await runDueRecurring(ctx, "2026-09-01");

    expect(outcome.issued.map((i) => i.scheduleId)).toEqual([good.id]);
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0]!.scheduleId, "and it says which one").toBe(bad.id);

    const stillThere = await getRecurring(ctx, bad.id);
    expect(stillThere.nextIssueOn, "the broken one did not advance").toBe("2026-09-01");
  });

  it("finishes a schedule that runs out of occurrences", async () => {
    const ctx = await ctxFor("administrator", new Date("2026-08-14T15:00:00Z"));
    const schedule = await createRecurring(ctx, plan({ occurrencesRemaining: 1 }));

    await runDueRecurring(ctx, "2026-09-01");

    const after = await getRecurring(ctx, schedule.id);
    expect(after.state).toBe("completed");

    // And a later run does not resurrect it.
    const later = await runDueRecurring(ctx, "2026-10-01");
    expect(later.issued).toHaveLength(0);
  });

  it("finishes a schedule that passes its end date", async () => {
    const ctx = await ctxFor("administrator", new Date("2026-08-14T15:00:00Z"));
    const schedule = await createRecurring(ctx, plan({ endsOn: "2026-09-30" }));

    await runDueRecurring(ctx, "2026-09-01");

    const after = await getRecurring(ctx, schedule.id);
    expect(after.state, "October would be past the end date").toBe("completed");
  });

  /**
   * A schedule left behind for months, which is what happens if the cron entry
   * is forgotten after a deploy. It bills once and rejoins the cadence, rather
   * than raising every period it missed.
   */
  it("does not backfill a schedule the run has neglected", async () => {
    const ctx = await ctxFor("administrator", new Date("2026-08-14T15:00:00Z"));
    const schedule = await createRecurring(ctx, plan());

    const outcome = await runDueRecurring(ctx, "2027-02-10");

    expect(outcome.issued, "one invoice, not six").toHaveLength(1);
    expect(await listInvoices(ctx, {})).toHaveLength(1);

    const after = await getRecurring(ctx, schedule.id);
    expect(after.nextIssueOn, "and it rejoins the cadence").toBe("2027-03-01");
  });

  it("is refused for a Member", async () => {
    const ctx = await ctxFor("member");
    await expect(runDueRecurring(ctx, "2026-09-01")).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("reports an empty run rather than failing on nothing to do", async () => {
    const ctx = await ctxFor("administrator", new Date("2026-08-14T15:00:00Z"));
    const outcome = await runDueRecurring(ctx, "2026-09-01");

    expect(outcome).toMatchObject({ on: "2026-09-01", issued: [], skipped: [], failed: [] });
  });
});
