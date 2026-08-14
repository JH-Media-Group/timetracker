/**
 * Retainers: the write path (TALLY-13).
 *
 * The ledger was already built and already tested. What did not exist was any
 * way to make a retainer: every one in the system was there because the seed
 * wrote it. So most of this file is about the property that matters once people
 * can move money by hand.
 *
 * **The balance is a cache of the ledger, and one function keeps them in step.**
 * `moveBalance` is the only code that writes `retainers.balance_cents`, and
 * opening, funding, correcting, drawing at send and reversing a draw all go
 * through it. Every test here checks the pair, not the balance alone: a balance
 * that is right while its ledger disagrees is the failure that only shows up
 * later, in an invariant nobody can trace back.
 *
 * The floor is the other half. A negative balance means a client was billed
 * against money they never paid, and there has already been one defect where an
 * invoice edit left a retainer over-drawn.
 */

import { beforeEach, afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, db, makeClient, makeProject, resetDb, s, seedSettings } from "./helpers";
import { newId } from "@/server/db/ids";
import { syncBaseProfiles } from "@/server/auth/profiles";
import { createCtx, type Actor, type Ctx } from "@/server/ctx";
import { BASE_PROFILES, type BaseProfileKey, type Capability } from "@/server/auth/capabilities";
import {
  addFunds, adjustBalance, archiveRetainer, createRetainer, ledgerDelta, listRetainers,
} from "@/server/services/retainers";
import { createInvoice, markSent, writeOff } from "@/server/services/invoices";

const people: Record<string, string> = {};
let clientId: string;

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

/**
 * The invariant, checked in place rather than only by `pnpm db:invariants`.
 *
 * A balance is a cache of the transactions. Asserting them together is what
 * catches a movement that wrote one and not the other, which no assertion on
 * the balance alone can see.
 */
async function expectLedgerAgrees(retainerId: string) {
  const [retainer] = await db
    .select()
    .from(s.retainers)
    .where(eq(s.retainers.id, retainerId))
    .limit(1);

  const rows = await db
    .select()
    .from(s.retainerTransactions)
    .where(eq(s.retainerTransactions.retainerId, retainerId));

  const sum = rows.reduce((total, t) => total + ledgerDelta(t.kind, t.amountCents), 0);

  expect(retainer!.balanceCents, "the balance disagrees with its own ledger").toBe(sum);
  return retainer!.balanceCents;
}

beforeEach(async () => {
  await resetDb();
  const profiles = (await syncBaseProfiles(db)).ids;

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
  await db.insert(s.invoiceItemTypes).values([
    { id: newId(), name: "Service", isDefaultForServices: true },
    { id: newId(), name: "Product", isDefaultForExpenses: true },
  ]);
  clientId = await makeClient("Example Client 04");
});

afterAll(async () => {
  await closeDb();
});

describe("opening a retainer", () => {
  it("creates one with an opening balance and a ledger row explaining it", async () => {
    const ctx = await ctxFor("administrator");
    const retainer = await createRetainer(ctx, { clientId, openingCents: 1_000_000 });

    expect(retainer.balanceCents).toBe(1_000_000);
    expect(retainer.transactions).toHaveLength(1);
    expect(retainer.transactions[0]!.kind).toBe("add");
    await expectLedgerAgrees(retainer.id);
  });

  it("creates an empty one, to be funded later", async () => {
    const ctx = await ctxFor("administrator");
    const retainer = await createRetainer(ctx, { clientId });

    expect(retainer.balanceCents).toBe(0);
    expect(retainer.transactions, "no money moved, so no ledger row").toHaveLength(0);
  });

  it("refuses a negative opening amount", async () => {
    const ctx = await ctxFor("administrator");
    await expect(
      createRetainer(ctx, { clientId, openingCents: -100 })
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("refuses a client that does not exist", async () => {
    const ctx = await ctxFor("administrator");
    await expect(createRetainer(ctx, { clientId: newId() })).rejects.toMatchObject({
      code: "validation_failed",
    });
  });

  /** The database holds this too; the service turns a 500 into a field error. */
  it("refuses a second retainer for the same client", async () => {
    const ctx = await ctxFor("administrator");
    await createRetainer(ctx, { clientId, openingCents: 100_000 });

    await expect(createRetainer(ctx, { clientId })).rejects.toMatchObject({
      code: "validation_failed",
    });
  });

  it("allows a project retainer alongside the client one", async () => {
    const ctx = await ctxFor("administrator");
    const projectId = await makeProject(clientId, { name: "Website" });

    await createRetainer(ctx, { clientId, openingCents: 100_000 });
    const scoped = await createRetainer(ctx, { clientId, projectId, openingCents: 50_000 });

    expect(scoped.projectId).toBe(projectId);
    expect(await listRetainers(ctx)).toHaveLength(2);
  });

  it("refuses a project belonging to another client", async () => {
    const ctx = await ctxFor("administrator");
    const otherClient = await makeClient("Somebody Else");
    const projectId = await makeProject(otherClient, { name: "Theirs" });

    await expect(
      createRetainer(ctx, { clientId, projectId })
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("is refused for a Member", async () => {
    const ctx = await ctxFor("member");
    await expect(createRetainer(ctx, { clientId })).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("adding funds", () => {
  it("raises the balance and records where it came from", async () => {
    const ctx = await ctxFor("administrator");
    const retainer = await createRetainer(ctx, { clientId, openingCents: 100_000 });

    const after = await addFunds(ctx, retainer.id, {
      amountCents: 250_000,
      note: "Q3 top-up",
    });

    expect(after.balanceCents).toBe(350_000);
    expect(after.transactions[0]!.note).toBe("Q3 top-up");
    expect(await expectLedgerAgrees(retainer.id)).toBe(350_000);
  });

  it("records the balance each movement left behind", async () => {
    const ctx = await ctxFor("administrator");
    const retainer = await createRetainer(ctx, { clientId, openingCents: 100_000 });
    await addFunds(ctx, retainer.id, { amountCents: 50_000 });
    const after = await addFunds(ctx, retainer.id, { amountCents: 25_000 });

    // Newest first, so the ledger reads as a running total downward.
    expect(after.transactions.map((t) => t.balanceAfterCents)).toEqual([175_000, 150_000, 100_000]);
  });

  it("refuses zero and negative amounts", async () => {
    const ctx = await ctxFor("administrator");
    const retainer = await createRetainer(ctx, { clientId });

    await expect(addFunds(ctx, retainer.id, { amountCents: 0 })).rejects.toMatchObject({
      code: "validation_failed",
    });
    await expect(addFunds(ctx, retainer.id, { amountCents: -500 })).rejects.toMatchObject({
      code: "validation_failed",
    });
  });

  it("404s on a retainer that does not exist", async () => {
    const ctx = await ctxFor("administrator");
    await expect(
      addFunds(ctx, newId(), { amountCents: 1000 })
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("correcting a balance", () => {
  it("moves it in either direction", async () => {
    const ctx = await ctxFor("administrator");
    const retainer = await createRetainer(ctx, { clientId, openingCents: 100_000 });

    await adjustBalance(ctx, retainer.id, { deltaCents: -30_000, note: "Duplicate payment" });
    expect(await expectLedgerAgrees(retainer.id)).toBe(70_000);

    await adjustBalance(ctx, retainer.id, { deltaCents: 5_000, note: "Bank fee returned" });
    expect(await expectLedgerAgrees(retainer.id)).toBe(75_000);
  });

  /** An unexplained correction is the ledger row nobody can account for later. */
  it("refuses a correction with no reason", async () => {
    const ctx = await ctxFor("administrator");
    const retainer = await createRetainer(ctx, { clientId, openingCents: 100_000 });

    await expect(
      adjustBalance(ctx, retainer.id, { deltaCents: -1000, note: "  " })
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("refuses a correction of nothing", async () => {
    const ctx = await ctxFor("administrator");
    const retainer = await createRetainer(ctx, { clientId, openingCents: 100_000 });

    await expect(
      adjustBalance(ctx, retainer.id, { deltaCents: 0, note: "why" })
    ).rejects.toMatchObject({ code: "validation_failed" });
  });
});

describe("the floor", () => {
  /**
   * A negative balance means a client has been billed against money they never
   * paid. Enforced in `moveBalance`, so it holds for every route into it rather
   * than being remembered at each call site.
   */
  it("refuses a correction that would go below zero", async () => {
    const ctx = await ctxFor("administrator");
    const retainer = await createRetainer(ctx, { clientId, openingCents: 100_000 });

    await expect(
      adjustBalance(ctx, retainer.id, { deltaCents: -100_001, note: "too much" })
    ).rejects.toMatchObject({ code: "validation_failed" });

    expect(await expectLedgerAgrees(retainer.id), "and nothing moved").toBe(100_000);
  });

  it("allows a correction to exactly zero", async () => {
    const ctx = await ctxFor("administrator");
    const retainer = await createRetainer(ctx, { clientId, openingCents: 100_000 });

    await adjustBalance(ctx, retainer.id, { deltaCents: -100_000, note: "Refunded" });
    expect(await expectLedgerAgrees(retainer.id)).toBe(0);
  });
});

describe("with invoices, which is what a retainer is for", () => {
  const invoiceFor = (ctx: Ctx, totalCents: number) =>
    createInvoice(ctx, {
      clientId,
      issueDate: "2026-08-01",
      dueDate: "2026-08-31",
      lines: [{ description: "Work", quantity: 1, unitPriceCents: totalCents }],
    });

  it("draws at send time, through the same path funds go in", async () => {
    const ctx = await ctxFor("administrator");
    const retainer = await createRetainer(ctx, { clientId, openingCents: 1_000_000 });

    const invoice = await invoiceFor(ctx, 580_000);
    await markSent(ctx, invoice.id);

    expect(await expectLedgerAgrees(retainer.id)).toBe(420_000);

    const after = (await listRetainers(ctx)).find((r) => r.id === retainer.id)!;
    expect(after.transactions[0]!.kind).toBe("draw");
    expect(after.transactions[0]!.invoiceId).toBe(invoice.id);
  });

  /**
   * A partial draw, deliberately.
   *
   * A retainer that covers an invoice in full settles it, and a paid invoice
   * cannot be written off, which is correct and is what the first version of
   * this test got wrong. The case worth covering is the one that can actually
   * happen: a draw that leaves a balance outstanding, and then the invoice is
   * abandoned.
   */
  it("gives a draw back when the invoice is written off", async () => {
    const ctx = await ctxFor("administrator");
    const retainer = await createRetainer(ctx, { clientId, openingCents: 300_000 });

    const invoice = await invoiceFor(ctx, 580_000);
    await markSent(ctx, invoice.id);
    expect(await expectLedgerAgrees(retainer.id), "drawn down to nothing").toBe(0);

    await writeOff(ctx, invoice.id);

    expect(
      await expectLedgerAgrees(retainer.id),
      "the money comes back, as a compensating row rather than by deleting the draw"
    ).toBe(300_000);
  });

  it("never draws more than the balance holds", async () => {
    const ctx = await ctxFor("administrator");
    const retainer = await createRetainer(ctx, { clientId, openingCents: 50_000 });

    const invoice = await invoiceFor(ctx, 500_000);
    await markSent(ctx, invoice.id);

    expect(await expectLedgerAgrees(retainer.id)).toBe(0);
  });
});

describe("archiving", () => {
  it("archives an empty retainer and keeps its history", async () => {
    const ctx = await ctxFor("administrator");
    const retainer = await createRetainer(ctx, { clientId, openingCents: 100_000 });
    await adjustBalance(ctx, retainer.id, { deltaCents: -100_000, note: "Refunded" });

    const archived = await archiveRetainer(ctx, retainer.id);
    expect(archived.archivedAt).toBeTruthy();
    expect(archived.transactions, "the ledger survives").toHaveLength(2);
    expect(await listRetainers(ctx), "and it drops out of the live list").toHaveLength(0);
  });

  /** Archiving money would make it vanish from every total with nothing to explain it. */
  it("refuses to archive a retainer that still holds funds", async () => {
    const ctx = await ctxFor("administrator");
    const retainer = await createRetainer(ctx, { clientId, openingCents: 100_000 });

    await expect(archiveRetainer(ctx, retainer.id)).rejects.toMatchObject({
      code: "validation_failed",
    });
  });

  it("frees the client to have a new retainer", async () => {
    const ctx = await ctxFor("administrator");
    const first = await createRetainer(ctx, { clientId });
    await archiveRetainer(ctx, first.id);

    const second = await createRetainer(ctx, { clientId, openingCents: 200_000 });
    expect(second.id).not.toBe(first.id);
  });
});
