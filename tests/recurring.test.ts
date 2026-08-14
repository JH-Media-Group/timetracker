/**
 * Recurring invoice schedules, through the services.
 *
 * These are TALLY-25's acceptance criteria. The area matters more than its size
 * suggests: the recurring schedules carry most of JHMG's billing, and until
 * this shipped Tally could list them and nothing else.
 *
 * The invariants worth naming, because they are the ones that cost money if
 * they break:
 *
 *   - Issuing advances the schedule by exactly one period, in the same
 *     transaction that writes the invoice.
 *   - A schedule is a template. Its lines are read at issue time, so a rate
 *     change reaches the next invoice rather than being frozen at setup.
 *   - Editing a schedule never touches an invoice it already raised.
 *   - Resuming picks the cadence back up rather than backfilling.
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
  deleteRecurring,
  getRecurring,
  issueRecurringNow,
  listRecurring,
  setRecurringState,
  updateRecurring,
  type RecurringInput,
} from "@/server/services/recurring";
import { getInvoice } from "@/server/services/invoices";

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

/** A monthly support plan, which is what most of the real schedules are. */
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

describe("creating a schedule", () => {
  it("stores the cadence and the first issue date", async () => {
    const ctx = await ctxFor("administrator", new Date("2026-08-14T15:00:00Z"));
    const created = await createRecurring(ctx, plan());

    expect(created.frequency).toBe("monthly");
    expect(created.interval).toBe(1);
    expect(created.nextIssueOn).toBe("2026-09-01");
    expect(created.state).toBe("active");
    expect(created.amountCents, "the list column shows a figure per schedule").toBe(160_000);
  });

  it("does not backdate a schedule that starts in the past", async () => {
    const ctx = await ctxFor("administrator", new Date("2026-08-14T15:00:00Z"));
    const created = await createRecurring(ctx, plan({ startsOn: "2026-01-01" }));

    // The next one due, not eight months of arrears.
    expect(created.nextIssueOn).toBe("2026-09-01");
  });

  it("refuses a schedule with no lines to bill", async () => {
    const ctx = await ctxFor("administrator");
    await expect(createRecurring(ctx, plan({ lines: [] }))).rejects.toMatchObject({
      code: "validation_failed",
    });
  });

  it("refuses an end date before the start", async () => {
    const ctx = await ctxFor("administrator");
    await expect(
      createRecurring(ctx, plan({ endsOn: "2026-08-01" }))
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("refuses a client that does not exist", async () => {
    const ctx = await ctxFor("administrator");
    await expect(createRecurring(ctx, plan({ clientId: newId() }))).rejects.toMatchObject({
      code: "validation_failed",
    });
  });

  it("is refused for a Member", async () => {
    const ctx = await ctxFor("member");
    await expect(createRecurring(ctx, plan())).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("issuing", () => {
  it("raises an invoice from the template and advances one period", async () => {
    const ctx = await ctxFor("administrator", new Date("2026-09-01T15:00:00Z"));
    const schedule = await createRecurring(ctx, plan());

    const { invoiceId } = await issueRecurringNow(ctx, schedule.id);
    const invoice = await getInvoice(ctx, invoiceId);

    expect(invoice.lineItems).toHaveLength(1);
    expect(invoice.totalCents).toBe(160_000);
    expect(invoice.issueDate).toBe("2026-09-01");
    expect(invoice.dueDate, "issue plus the payment term").toBe("2026-09-16");

    const after = await getRecurring(ctx, schedule.id);
    expect(after.lastIssuedOn).toBe("2026-09-01");
    expect(after.nextIssueOn, "exactly one period on").toBe("2026-10-01");
  });

  it("links the invoice back to the schedule that raised it", async () => {
    const ctx = await ctxFor("administrator", new Date("2026-09-01T15:00:00Z"));
    const schedule = await createRecurring(ctx, plan());
    const { invoiceId } = await issueRecurringNow(ctx, schedule.id);

    const [row] = await db.select().from(s.invoices).where(eq(s.invoices.id, invoiceId));
    expect(row!.recurringInvoiceId).toBe(schedule.id);
  });

  /**
   * The template is read at issue time, which is what stops a schedule set up a
   * year ago billing last year's price after a rate change.
   */
  it("bills the current template, not the one it was created with", async () => {
    const ctx = await ctxFor("administrator", new Date("2026-09-01T15:00:00Z"));
    const schedule = await createRecurring(ctx, plan());

    await updateRecurring(ctx, schedule.id, plan({
      lines: [{ description: "Monthly support", quantity: 1, unitPriceCents: 180_000 }],
    }));

    const { invoiceId } = await issueRecurringNow(ctx, schedule.id);
    const invoice = await getInvoice(ctx, invoiceId);
    expect(invoice.totalCents).toBe(180_000);
  });

  it("counts down and completes on the last occurrence", async () => {
    const ctx = await ctxFor("administrator", new Date("2026-09-01T15:00:00Z"));
    const schedule = await createRecurring(ctx, plan({ occurrencesRemaining: 2 }));

    await issueRecurringNow(ctx, schedule.id);
    const midway = await getRecurring(ctx, schedule.id);
    expect(midway.occurrencesRemaining).toBe(1);
    expect(midway.state).toBe("active");

    await issueRecurringNow(ctx, schedule.id);
    const done = await getRecurring(ctx, schedule.id);
    expect(done.occurrencesRemaining).toBe(0);
    expect(done.state, "the count ran out").toBe("completed");
    expect(done.nextIssueOn).toBeNull();
  });

  it("completes when the next date would pass the end date", async () => {
    const ctx = await ctxFor("administrator", new Date("2026-09-01T15:00:00Z"));
    const schedule = await createRecurring(ctx, plan({ endsOn: "2026-09-30" }));

    await issueRecurringNow(ctx, schedule.id);
    const after = await getRecurring(ctx, schedule.id);
    expect(after.state, "October would be past the end").toBe("completed");
    expect(after.nextIssueOn).toBeNull();
  });

  it("refuses to issue a finished schedule", async () => {
    const ctx = await ctxFor("administrator", new Date("2026-09-01T15:00:00Z"));
    const schedule = await createRecurring(ctx, plan({ occurrencesRemaining: 1 }));
    await issueRecurringNow(ctx, schedule.id);

    await expect(issueRecurringNow(ctx, schedule.id)).rejects.toMatchObject({
      code: "validation_failed",
    });
  });

  it("holds the anchor day across a short month", async () => {
    const ctx = await ctxFor("administrator", new Date("2026-01-31T15:00:00Z"));
    const schedule = await createRecurring(ctx, plan({ startsOn: "2026-01-31" }));

    await issueRecurringNow(ctx, schedule.id);
    expect((await getRecurring(ctx, schedule.id)).nextIssueOn).toBe("2026-02-28");

    await issueRecurringNow(ctx, schedule.id);
    expect(
      (await getRecurring(ctx, schedule.id)).nextIssueOn,
      "March has a 31st, so it comes back rather than sticking at the 28th"
    ).toBe("2026-03-31");
  });

  it("is refused for a Member", async () => {
    const admin = await ctxFor("administrator", new Date("2026-09-01T15:00:00Z"));
    const schedule = await createRecurring(admin, plan());

    const member = await ctxFor("member");
    await expect(issueRecurringNow(member, schedule.id)).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("pause and resume", () => {
  it("pauses and stops being due", async () => {
    const ctx = await ctxFor("administrator", new Date("2026-08-14T15:00:00Z"));
    const schedule = await createRecurring(ctx, plan());

    const paused = await setRecurringState(ctx, schedule.id, "paused");
    expect(paused.state).toBe("paused");
    expect(paused.nextIssueOn, "the place is kept, not cleared").toBe("2026-09-01");
  });

  /**
   * The property that stops a resume being a bill shock: a schedule paused in
   * September and resumed in January raises one invoice, not four.
   */
  it("resumes onto the next date due rather than backfilling", async () => {
    const created = await ctxFor("administrator", new Date("2026-08-14T15:00:00Z"));
    const schedule = await createRecurring(created, plan());
    await setRecurringState(created, schedule.id, "paused");

    const later = await ctxFor("administrator", new Date("2027-01-10T15:00:00Z"));
    const resumed = await setRecurringState(later, schedule.id, "active");

    expect(resumed.state).toBe("active");
    expect(resumed.nextIssueOn, "the next one due, not September's").toBe("2027-02-01");
  });

  it("leaves a future date alone when resuming early", async () => {
    const ctx = await ctxFor("administrator", new Date("2026-08-14T15:00:00Z"));
    const schedule = await createRecurring(ctx, plan());
    await setRecurringState(ctx, schedule.id, "paused");

    const resumed = await setRecurringState(ctx, schedule.id, "active");
    expect(resumed.nextIssueOn).toBe("2026-09-01");
  });

  it("refuses to restart a completed schedule", async () => {
    const ctx = await ctxFor("administrator", new Date("2026-09-01T15:00:00Z"));
    const schedule = await createRecurring(ctx, plan({ occurrencesRemaining: 1 }));
    await issueRecurringNow(ctx, schedule.id);

    await expect(setRecurringState(ctx, schedule.id, "active")).rejects.toMatchObject({
      code: "validation_failed",
    });
  });
});

describe("editing", () => {
  it("does not touch an invoice the schedule already raised", async () => {
    const ctx = await ctxFor("administrator", new Date("2026-09-01T15:00:00Z"));
    const schedule = await createRecurring(ctx, plan());
    const { invoiceId } = await issueRecurringNow(ctx, schedule.id);
    const before = await getInvoice(ctx, invoiceId);

    await updateRecurring(ctx, schedule.id, plan({
      subject: "Renamed plan",
      lines: [{ description: "Monthly support", quantity: 1, unitPriceCents: 999_000 }],
    }));

    const after = await getInvoice(ctx, invoiceId);
    expect(after.totalCents).toBe(before.totalCents);
    expect(after.subject).toBe(before.subject);
  });

  it("keeps the issue date when only the amount changes", async () => {
    const ctx = await ctxFor("administrator", new Date("2026-08-14T15:00:00Z"));
    const schedule = await createRecurring(ctx, plan());

    const edited = await updateRecurring(ctx, schedule.id, plan({
      lines: [{ description: "Monthly support", quantity: 1, unitPriceCents: 170_000 }],
    }));

    expect(edited.nextIssueOn, "the day it lands on did not move").toBe("2026-09-01");
    expect(edited.amountCents).toBe(170_000);
  });

  it("moves the schedule when the start date moves", async () => {
    const ctx = await ctxFor("administrator", new Date("2026-08-14T15:00:00Z"));
    const schedule = await createRecurring(ctx, plan());

    const edited = await updateRecurring(ctx, schedule.id, plan({ startsOn: "2026-09-15" }));
    expect(edited.nextIssueOn).toBe("2026-09-15");
  });
});

describe("deleting", () => {
  it("removes the schedule and leaves its invoices standing", async () => {
    const ctx = await ctxFor("administrator", new Date("2026-09-01T15:00:00Z"));
    const schedule = await createRecurring(ctx, plan());
    const { invoiceId } = await issueRecurringNow(ctx, schedule.id);

    await deleteRecurring(ctx, schedule.id);

    expect(await listRecurring(ctx)).toHaveLength(0);
    const [invoice] = await db.select().from(s.invoices).where(eq(s.invoices.id, invoiceId));
    expect(invoice, "the client still has this document").toBeDefined();
    expect(invoice!.recurringInvoiceId, "and it no longer points at a schedule").toBeNull();
  });

  it("is refused for a Member", async () => {
    const admin = await ctxFor("administrator");
    const schedule = await createRecurring(admin, plan());
    const member = await ctxFor("member");
    await expect(deleteRecurring(member, schedule.id)).rejects.toMatchObject({ code: "forbidden" });
  });
});
