/**
 * Invoices, as invariants rather than as behaviours.
 *
 * An adversarial review of this slice found five money defects, and what they
 * had in common was that every one of them broke a rule stated in prose at the
 * top of a file and asserted nowhere executable. The rules were right. Nothing
 * checked them.
 *
 * So these tests are mostly not "does send work". They are:
 *
 *   1. The preview equals the invoice it produces. A person approves a number
 *      on screen and the client is billed a number from the database, and those
 *      have to be the same number.
 *   2. Stored totals equal the sum of the stored lines. Every intermediate on
 *      the invoice row is a cache of the line items, and a cache that can drift
 *      from its source will.
 *   3. A retainer's balance equals the sum of its transactions. The ledger is
 *      the truth; the balance column is a convenience.
 *
 * Each of those held on the seeded data by luck (round durations, one project
 * per invoice, no concurrency) and failed on the general case.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDb, db, resetDb, s } from "./helpers";
import { eq } from "drizzle-orm";
import { newId } from "@/server/db/ids";
import { syncBaseProfiles } from "@/server/auth/profiles";
import { createCtx, type Actor, type Ctx } from "@/server/ctx";
import { BASE_PROFILES, type Capability } from "@/server/auth/capabilities";
import { invalidateSettings } from "@/server/services/settings";
import {
  addRetainerTransaction, createInvoice, deleteInvoice, getInvoice, markSent,
  previewLines, recordPayment, updateInvoice, writeOff,
} from "@/server/services/invoices";

let profiles: Record<string, string>;
let admin: string;
let clientId: string;
let otherClientId: string;
let projectA: string;
let projectB: string;
let otherProject: string;
let ptA: string;
let ptB: string;
let ptOther: string;

const TODAY = "2026-08-14";

function ctxFor(userId: string, key: keyof typeof BASE_PROFILES): Ctx {
  const actor: Actor = {
    userId,
    profileId: profiles[key]!,
    baseKey: key,
    capabilities: new Set(BASE_PROFILES[key].capabilities as readonly Capability[]),
    kind: "user",
    timezone: "America/New_York",
    isOwner: key === "administrator",
  };
  return createCtx({ actor, now: () => new Date(`${TODAY}T15:00:00Z`) });
}

async function addEntry(projectTaskId: string, projectId: string, seconds: number, rate: number) {
  const id = newId();
  await db.insert(s.timeEntries).values({
    id,
    userId: admin,
    projectId,
    projectTaskId,
    spentOn: TODAY,
    durationSeconds: seconds,
    isBillable: true,
    billableRateCents: rate,
    costRateCents: 0,
  });
  return id;
}

beforeEach(async () => {
  await resetDb();
  invalidateSettings();
  profiles = (await syncBaseProfiles(db)).ids;

  await db.insert(s.settings).values({ id: 1, companyName: "JH Media Group", timezone: "America/New_York" });

  admin = newId();
  await db.insert(s.users).values({
    id: admin, email: "admin@jhmediagroup.com", firstName: "Admin", lastName: "A",
    profileId: profiles.administrator!, weeklyCapacitySeconds: 144000,
  });

  clientId = newId();
  otherClientId = newId();
  await db.insert(s.clients).values([
    { id: clientId, name: "Acme" },
    { id: otherClientId, name: "Other Co" },
  ]);

  projectA = newId();
  projectB = newId();
  otherProject = newId();
  await db.insert(s.projects).values([
    { id: projectA, clientId, name: "Project A", billingType: "time_and_materials", billBy: "people" },
    { id: projectB, clientId, name: "Project B", billingType: "time_and_materials", billBy: "people" },
    { id: otherProject, clientId: otherClientId, name: "Theirs", billingType: "time_and_materials", billBy: "people" },
  ]);

  const task = newId();
  await db.insert(s.tasks).values({ id: task, name: "Design" });

  ptA = newId();
  ptB = newId();
  ptOther = newId();
  await db.insert(s.projectTasks).values([
    { id: ptA, projectId: projectA, taskId: task, isBillable: true },
    { id: ptB, projectId: projectB, taskId: task, isBillable: true },
    { id: ptOther, projectId: otherProject, taskId: task, isBillable: true },
  ]);

  await db.insert(s.projectMembers).values([
    { id: newId(), projectId: projectA, userId: admin, isManager: true },
    { id: newId(), projectId: projectB, userId: admin, isManager: true },
    { id: newId(), projectId: otherProject, userId: admin, isManager: true },
  ]);
});

afterAll(async () => {
  await closeDb();
});

/* ================================================== invariant 1: preview = invoice */

describe("the preview and the invoice it produces", () => {
  /**
   * Awkward numbers on purpose.
   *
   * 2h23m17s at $150 is 21.5325 hours' worth of nothing round, and the old code
   * rounded the hours to 21.53 before multiplying, which is how a preview and
   * an invoice ended up $2.25 apart on the seeded data.
   */
  it("bills exactly what the preview showed, on durations that do not divide", async () => {
    const ctx = ctxFor(admin, "administrator");
    for (const seconds of [8597, 3719, 1481, 46_411, 142_800]) {
      await addEntry(ptA, projectA, seconds, 15_000);
    }

    const preview = await previewLines(ctx, { clientId });
    const previewTotal = preview.reduce((a, l) => a + l.amountCents, 0);

    const invoice = await createInvoice(ctx, {
      clientId,
      issueDate: TODAY,
      dueDate: "2026-09-14",
      lines: preview.map((l) => ({
        projectId: l.projectId,
        description: l.label,
        quantity: l.quantity,
        unitPriceCents: l.unitPriceCents,
        amountCents: l.amountCents,
        isTaxed: true,
      })),
      timeEntryIds: preview.flatMap((l) => l.timeEntryIds),
      expenseIds: [],
    });

    expect(invoice.subtotalCents).toBe(previewTotal);
    expect(invoice.totalCents).toBe(previewTotal);
  });

  it("values time by summing the products and dividing once", async () => {
    const ctx = ctxFor(admin, "administrator");
    // Seven entries of 100 seconds at $123.45/h. Per-row rounding gives 2401;
    // one division at the end gives 2400.
    for (let i = 0; i < 7; i++) await addEntry(ptA, projectA, 100, 12_345);

    const preview = await previewLines(ctx, { clientId });
    expect(preview).toHaveLength(1);
    expect(preview[0]!.amountCents).toBe(2400);
  });

  it("does not lose cents when an expense group does not divide evenly", async () => {
    const ctx = ctxFor(admin, "administrator");
    const category = newId();
    await db.insert(s.expenseCategories).values({ id: category, name: "Travel" });
    for (const cents of [1000, 1001, 1002]) {
      await db.insert(s.expenses).values({
        id: newId(), userId: admin, projectId: projectA, categoryId: category,
        spentOn: TODAY, totalCents: cents, isBillable: true,
      });
    }

    const preview = await previewLines(ctx, { clientId });
    const line = preview.find((l) => l.kind === "expense")!;
    expect(line.amountCents).toBe(3003);
    // $10.01 is the unit price the document shows; three of them is $30.03 only
    // by luck, and the line's value is what matters.
    expect(line.quantity).toBe(3);

    const invoice = await createInvoice(ctx, {
      clientId, issueDate: TODAY, dueDate: "2026-09-14",
      lines: [{
        projectId: line.projectId, description: line.label, quantity: line.quantity,
        unitPriceCents: line.unitPriceCents, amountCents: line.amountCents, isTaxed: false,
      }],
      expenseIds: line.expenseIds,
    });
    expect(invoice.totalCents).toBe(3003);
  });
});

/* ============================================ invariant 2: totals = sum of lines */

describe("stored totals against the stored lines", () => {
  const sumOfLines = async (invoiceId: string) => {
    const lines = await db
      .select({ amountCents: s.invoiceLineItems.amountCents, isTaxed: s.invoiceLineItems.isTaxed })
      .from(s.invoiceLineItems)
      .where(eq(s.invoiceLineItems.invoiceId, invoiceId));
    return {
      subtotal: lines.reduce((a, l) => a + l.amountCents, 0),
      taxable: lines.filter((l) => l.isTaxed).reduce((a, l) => a + l.amountCents, 0),
    };
  };

  it("holds after a create", async () => {
    const ctx = ctxFor(admin, "administrator");
    const invoice = await createInvoice(ctx, {
      clientId, issueDate: TODAY, dueDate: "2026-09-14", taxPercent: 8.25,
      lines: [
        { projectId: projectA, description: "Design", quantity: 3.5, unitPriceCents: 15_000, isTaxed: true },
        { projectId: projectA, description: "Taxi", quantity: 1, unitPriceCents: 4_237, isTaxed: false },
      ],
    });

    const { subtotal, taxable } = await sumOfLines(invoice.id);
    expect(invoice.subtotalCents).toBe(subtotal);
    expect(invoice.taxCents).toBe(Math.round(taxable * 0.0825));
    expect(invoice.totalCents).toBe(subtotal + invoice.taxCents - invoice.discountCents);
  });

  it("holds after a tax-only edit, which used to change nothing at all", async () => {
    const ctx = ctxFor(admin, "administrator");
    const invoice = await createInvoice(ctx, {
      clientId, issueDate: TODAY, dueDate: "2026-09-14",
      lines: [{ projectId: projectA, description: "Design", quantity: 10, unitPriceCents: 15_000, isTaxed: true }],
    });
    expect(invoice.taxCents).toBe(0);

    const updated = await updateInvoice(ctx, invoice.id, { taxPercent: 10 });

    // 10 x $150 is $1,500, so 10% is $150 and the total is $1,650.
    expect(updated.taxPercent).toBe(10);
    expect(updated.subtotalCents).toBe(150_000);
    expect(updated.taxCents).toBe(15_000);
    expect(updated.totalCents).toBe(165_000);
    const { subtotal } = await sumOfLines(invoice.id);
    expect(updated.subtotalCents).toBe(subtotal);
  });

  it("holds after a discount-only edit", async () => {
    const ctx = ctxFor(admin, "administrator");
    const invoice = await createInvoice(ctx, {
      clientId, issueDate: TODAY, dueDate: "2026-09-14",
      lines: [{ projectId: projectA, description: "Design", quantity: 10, unitPriceCents: 10_000, isTaxed: true }],
    });

    // 10 x $100 is $1,000, so 15% off is $150 and the total is $850.
    const updated = await updateInvoice(ctx, invoice.id, { discountPercent: 15 });
    expect(updated.subtotalCents).toBe(100_000);
    expect(updated.discountCents).toBe(15_000);
    expect(updated.totalCents).toBe(85_000);
  });

  it("takes a paid invoice back to open when its lines are raised", async () => {
    const ctx = ctxFor(admin, "administrator");
    const invoice = await createInvoice(ctx, {
      clientId, issueDate: TODAY, dueDate: "2026-09-14",
      lines: [{ projectId: projectA, description: "Design", quantity: 1, unitPriceCents: 100_000, isTaxed: false }],
    });
    await markSent(ctx, invoice.id);
    const paid = await recordPayment(ctx, invoice.id, {
      amountCents: 100_000, paidAt: `${TODAY}T12:00:00.000Z`,
    });
    expect(paid.state).toBe("paid");

    const raised = await updateInvoice(ctx, invoice.id, {
      lines: [{ projectId: projectA, description: "Design", quantity: 2, unitPriceCents: 100_000, isTaxed: false }],
    });

    // Still owed $1,000. An invoice that stays "paid" here drops out of
    // receivables while the money is still outstanding.
    expect(raised.totalCents).toBe(200_000);
    expect(raised.state).toBe("open");
    expect(raised.balanceCents).toBe(100_000);
  });
});

/* ====================================== invariant 3: balance = sum of transactions */

const ledgerBalance = async (retainerId: string) => {
  const rows = await db
    .select({ kind: s.retainerTransactions.kind, amountCents: s.retainerTransactions.amountCents })
    .from(s.retainerTransactions)
    .where(eq(s.retainerTransactions.retainerId, retainerId));
  return rows.reduce((a, r) => a + (r.kind === "draw" ? -r.amountCents : r.amountCents), 0);
};

const seedRetainer = async (balanceCents: number) => {
  const id = newId();
  await db.insert(s.retainers).values({ id, clientId, balanceCents: 0 });
  await addRetainerTransaction(ctxFor(admin, "administrator"), id, {
    kind: "add", amountCents: balanceCents,
  });
  return id;
};

describe("a retainer balance against its ledger", () => {

  it("holds through a draw at send time", async () => {
    const ctx = ctxFor(admin, "administrator");
    const retainer = await seedRetainer(500_000);

    const invoice = await createInvoice(ctx, {
      clientId, issueDate: TODAY, dueDate: "2026-09-14",
      lines: [{ projectId: projectA, description: "Design", quantity: 1, unitPriceCents: 200_000, isTaxed: false }],
    });
    await markSent(ctx, invoice.id);

    const [row] = await db.select().from(s.retainers).where(eq(s.retainers.id, retainer));
    expect(row!.balanceCents).toBe(300_000);
    expect(await ledgerBalance(retainer)).toBe(300_000);
  });

  it("settles an invoice the retainer fully covers, rather than leaving it open forever", async () => {
    const ctx = ctxFor(admin, "administrator");
    await seedRetainer(500_000);

    const invoice = await createInvoice(ctx, {
      clientId, issueDate: TODAY, dueDate: "2026-09-14",
      lines: [{ projectId: projectA, description: "Design", quantity: 1, unitPriceCents: 200_000, isTaxed: false }],
    });
    const sent = await markSent(ctx, invoice.id);

    expect(sent.retainerDrawCents).toBe(200_000);
    expect(sent.balanceCents).toBe(0);
    // The client already paid this money. An invoice it covers is not a debt.
    expect(sent.state).toBe("paid");
  });

  it("holds through a write-off, and credits the retainer that was drawn", async () => {
    const ctx = ctxFor(admin, "administrator");
    // Deliberately smaller than the invoice: a retainer that covers the whole
    // thing settles it, and a settled invoice is not one you write off.
    const drawn = await seedRetainer(60_000);

    const invoice = await createInvoice(ctx, {
      clientId, issueDate: TODAY, dueDate: "2026-09-14",
      lines: [{ projectId: projectA, description: "Design", quantity: 1, unitPriceCents: 100_000, isTaxed: false }],
    });
    const sent = await markSent(ctx, invoice.id);
    expect(sent.state).toBe("open");

    // The client-level retainer is archived and replaced between send and
    // write-off. The credit belongs to the one that was actually drawn.
    await db.update(s.retainers).set({ archivedAt: new Date() }).where(eq(s.retainers.id, drawn));
    const replacement = newId();
    await db.insert(s.retainers).values({ id: replacement, clientId, balanceCents: 0 });

    await writeOff(ctx, invoice.id);

    const [original] = await db.select().from(s.retainers).where(eq(s.retainers.id, drawn));
    const [newer] = await db.select().from(s.retainers).where(eq(s.retainers.id, replacement));
    expect(original!.balanceCents).toBe(60_000);
    expect(newer!.balanceCents).toBe(0);
    expect(await ledgerBalance(drawn)).toBe(60_000);
  });

  it("returns the excess when an invoice is edited below its draw", async () => {
    const ctx = ctxFor(admin, "administrator");
    const retainer = await seedRetainer(500_000);

    const invoice = await createInvoice(ctx, {
      clientId, issueDate: TODAY, dueDate: "2026-09-14",
      lines: [{ projectId: projectA, description: "Design", quantity: 1, unitPriceCents: 300_000, isTaxed: false }],
    });
    await markSent(ctx, invoice.id);

    const [afterSend] = await db.select().from(s.retainers).where(eq(s.retainers.id, retainer));
    expect(afterSend!.balanceCents).toBe(200_000);

    // The client and we agree the job was smaller. The draw was sized against
    // the old total, so the difference has to go back.
    const reduced = await updateInvoice(ctx, invoice.id, {
      lines: [{ projectId: projectA, description: "Design", quantity: 1, unitPriceCents: 100_000, isTaxed: false }],
    });

    const [afterEdit] = await db.select().from(s.retainers).where(eq(s.retainers.id, retainer));
    expect(reduced.totalCents).toBe(100_000);
    expect(reduced.retainerDrawCents).toBe(100_000);
    expect(afterEdit!.balanceCents).toBe(400_000);
    expect(await ledgerBalance(retainer)).toBe(400_000);
    // And the client is not owed money on an invoice they have overpaid.
    expect(reduced.balanceCents).toBe(0);
  });

  it("refuses a draw larger than the balance", async () => {
    const ctx = ctxFor(admin, "administrator");
    const retainer = await seedRetainer(10_000);
    await expect(
      addRetainerTransaction(ctx, retainer, { kind: "draw", amountCents: 10_001 })
    ).rejects.toMatchObject({ code: "retainer_insufficient" });
    expect(await ledgerBalance(retainer)).toBe(10_000);
  });
});

/* =========================================================== claiming work */

describe("claiming time and expenses", () => {
  it("refuses to attach another client's work", async () => {
    const ctx = ctxFor(admin, "administrator");
    const theirs = await addEntry(ptOther, otherProject, 3600, 10_000);

    await expect(
      createInvoice(ctx, {
        clientId, issueDate: TODAY, dueDate: "2026-09-14",
        lines: [{ projectId: projectA, description: "Design", quantity: 1, unitPriceCents: 10_000, isTaxed: false }],
        timeEntryIds: [theirs],
      })
    ).rejects.toMatchObject({ code: "attached_entries_changed" });

    // And the entry is still theirs to bill.
    const [entry] = await db.select().from(s.timeEntries).where(eq(s.timeEntries.id, theirs));
    expect(entry!.invoiceId).toBeNull();
  });

  it("refuses to attach time that is not billable", async () => {
    const ctx = ctxFor(admin, "administrator");
    const id = await addEntry(ptA, projectA, 3600, 10_000);
    await db.update(s.timeEntries).set({ isBillable: false }).where(eq(s.timeEntries.id, id));

    await expect(
      createInvoice(ctx, {
        clientId, issueDate: TODAY, dueDate: "2026-09-14",
        lines: [{ projectId: projectA, description: "Design", quantity: 1, unitPriceCents: 10_000, isTaxed: false }],
        timeEntryIds: [id],
      })
    ).rejects.toMatchObject({ code: "attached_entries_changed" });
  });

  it("releases what it was holding when the lines are replaced", async () => {
    const ctx = ctxFor(admin, "administrator");
    const first = await addEntry(ptA, projectA, 3600, 10_000);
    const second = await addEntry(ptB, projectB, 3600, 10_000);

    const invoice = await createInvoice(ctx, {
      clientId, issueDate: TODAY, dueDate: "2026-09-14",
      lines: [
        { projectId: projectA, description: "A", quantity: 1, unitPriceCents: 10_000, isTaxed: false },
        { projectId: projectB, description: "B", quantity: 1, unitPriceCents: 10_000, isTaxed: false },
      ],
      timeEntryIds: [first, second],
    });

    // Drop project B's line. Its hour has to become billable again, or it is
    // stranded: claimed by an invoice that no longer bills it.
    await updateInvoice(ctx, invoice.id, {
      lines: [{ projectId: projectA, description: "A", quantity: 1, unitPriceCents: 10_000, isTaxed: false }],
      timeEntryIds: [first],
    });

    const [a] = await db.select().from(s.timeEntries).where(eq(s.timeEntries.id, first));
    const [b] = await db.select().from(s.timeEntries).where(eq(s.timeEntries.id, second));
    expect(a!.invoiceId).toBe(invoice.id);
    expect(b!.invoiceId).toBeNull();
  });

  it("keeps its attachments when the lines are replaced without naming records", async () => {
    const ctx = ctxFor(admin, "administrator");
    const entry = await addEntry(ptA, projectA, 3600, 10_000);

    const invoice = await createInvoice(ctx, {
      clientId, issueDate: TODAY, dueDate: "2026-09-14",
      lines: [{ projectId: projectA, description: "A", quantity: 1, unitPriceCents: 10_000, isTaxed: false }],
      timeEntryIds: [entry],
    });

    // A caller that changes a description but says nothing about the work is
    // not asking for the work to be released. Releasing it would put the same
    // hour back in the pool while this invoice still bills it.
    await updateInvoice(ctx, invoice.id, {
      lines: [{ projectId: projectA, description: "A, revised", quantity: 1, unitPriceCents: 10_000, isTaxed: false }],
    });

    const [row] = await db.select().from(s.timeEntries).where(eq(s.timeEntries.id, entry));
    expect(row!.invoiceId).toBe(invoice.id);
  });

  it("clears the rate lock on anything it releases", async () => {
    const ctx = ctxFor(admin, "administrator");
    const entry = await addEntry(ptA, projectA, 3600, 10_000);

    const invoice = await createInvoice(ctx, {
      clientId, issueDate: TODAY, dueDate: "2026-09-14",
      lines: [{ projectId: projectA, description: "A", quantity: 1, unitPriceCents: 10_000, isTaxed: false }],
      timeEntryIds: [entry],
    });
    await markSent(ctx, invoice.id);

    const [locked] = await db.select().from(s.timeEntries).where(eq(s.timeEntries.id, entry));
    expect(locked!.ratesLockedAt).not.toBeNull();

    // Taken off the invoice entirely. A rate lock with nothing holding it can
    // never be cleared by anything, and the entry becomes unrateable forever.
    await updateInvoice(ctx, invoice.id, {
      lines: [{ projectId: projectA, description: "A", quantity: 1, unitPriceCents: 10_000, isTaxed: false }],
      timeEntryIds: [],
    });

    const [released] = await db.select().from(s.timeEntries).where(eq(s.timeEntries.id, entry));
    expect(released!.invoiceId).toBeNull();
    expect(released!.ratesLockedAt).toBeNull();
  });

  it("gives everything back when a draft is deleted", async () => {
    const ctx = ctxFor(admin, "administrator");
    const id = await addEntry(ptA, projectA, 3600, 10_000);
    const invoice = await createInvoice(ctx, {
      clientId, issueDate: TODAY, dueDate: "2026-09-14",
      lines: [{ projectId: projectA, description: "A", quantity: 1, unitPriceCents: 10_000, isTaxed: false }],
      timeEntryIds: [id],
    });

    await deleteInvoice(ctx, invoice.id);
    const [entry] = await db.select().from(s.timeEntries).where(eq(s.timeEntries.id, id));
    expect(entry!.invoiceId).toBeNull();
  });

  it("keeps the number sequence unbroken when a create rolls back", async () => {
    const ctx = ctxFor(admin, "administrator");
    const good = await createInvoice(ctx, {
      clientId, issueDate: TODAY, dueDate: "2026-09-14",
      lines: [{ projectId: projectA, description: "A", quantity: 1, unitPriceCents: 10_000, isTaxed: false }],
    });

    const theirs = await addEntry(ptOther, otherProject, 3600, 10_000);
    await expect(
      createInvoice(ctx, {
        clientId, issueDate: TODAY, dueDate: "2026-09-14",
        lines: [{ projectId: projectA, description: "B", quantity: 1, unitPriceCents: 10_000, isTaxed: false }],
        timeEntryIds: [theirs],
      })
    ).rejects.toThrow();

    const next = await createInvoice(ctx, {
      clientId, issueDate: TODAY, dueDate: "2026-09-14",
      lines: [{ projectId: projectA, description: "C", quantity: 1, unitPriceCents: 10_000, isTaxed: false }],
    });

    const seq = (n: string) => Number(n.replace(/\D/g, ""));
    expect(seq(next.number)).toBe(seq(good.number) + 1);
  });
});

/* ================================================================ lifecycle */

describe("the state machine", () => {
  it("will not send the same invoice twice", async () => {
    const ctx = ctxFor(admin, "administrator");
    const invoice = await createInvoice(ctx, {
      clientId, issueDate: TODAY, dueDate: "2026-09-14",
      lines: [{ projectId: projectA, description: "A", quantity: 1, unitPriceCents: 10_000, isTaxed: false }],
    });
    await markSent(ctx, invoice.id);
    await expect(markSent(ctx, invoice.id)).rejects.toMatchObject({ code: "invoice_state_invalid" });
  });

  it("will not take a payment on a draft", async () => {
    const ctx = ctxFor(admin, "administrator");
    const invoice = await createInvoice(ctx, {
      clientId, issueDate: TODAY, dueDate: "2026-09-14",
      lines: [{ projectId: projectA, description: "A", quantity: 1, unitPriceCents: 10_000, isTaxed: false }],
    });
    await expect(
      recordPayment(ctx, invoice.id, { amountCents: 10_000, paidAt: `${TODAY}T12:00:00.000Z` })
    ).rejects.toMatchObject({ code: "invoice_state_invalid" });
  });

  it("recomputes what is paid from the payment rows, not by adding to a running total", async () => {
    const ctx = ctxFor(admin, "administrator");
    const invoice = await createInvoice(ctx, {
      clientId, issueDate: TODAY, dueDate: "2026-09-14",
      lines: [{ projectId: projectA, description: "A", quantity: 1, unitPriceCents: 100_000, isTaxed: false }],
    });
    await markSent(ctx, invoice.id);
    await recordPayment(ctx, invoice.id, { amountCents: 40_000, paidAt: `${TODAY}T12:00:00.000Z` });
    const after = await recordPayment(ctx, invoice.id, { amountCents: 60_000, paidAt: `${TODAY}T13:00:00.000Z` });

    expect(after.paidCents).toBe(100_000);
    expect(after.state).toBe("paid");

    const stored = await getInvoice(ctx, invoice.id);
    const ledger = stored.payments.filter((p) => !p.voidedAt).reduce((a, p) => a + p.amountCents, 0);
    expect(stored.paidCents).toBe(ledger);
  });
});
