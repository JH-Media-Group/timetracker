/**
 * Retainers: money a client has handed over before the work.
 *
 * The ledger was already built and tested. `tests/invoices.test.ts` asserts a
 * retainer's balance equals the sum of its transactions, invoices draw against
 * one when they are sent, and write-off, deletion and edit all give back what
 * they should. What did not exist was any way to make one: every retainer in
 * the system was there because the seed wrote it.
 *
 * ONE PATH FOR EVERY MOVEMENT
 *
 * `moveBalance` below is the only function in the codebase that changes a
 * `retainers.balance_cents`. Opening a retainer, adding funds, correcting a
 * figure, drawing at send time and reversing a draw all go through it.
 *
 * That is deliberate, and it is the thing this file is really about. The
 * balance is a cache of the ledger, and the two are kept in step by reading
 * under `FOR UPDATE`, writing the row and the balance together, and never doing
 * either separately. A second way to change a balance is how they stop
 * agreeing, and when they do, the invariant test starts failing for a reason
 * nobody can trace back to the commit that caused it.
 *
 * NEVER NEGATIVE
 *
 * A balance below zero means a client has been billed against money they never
 * paid. There has already been one defect where an invoice edit left a retainer
 * over-drawn, so the floor is enforced here, in the one place every movement
 * passes through, rather than at each call site.
 */

import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { assertCan, withTransaction, type Ctx } from "@/server/ctx";
import * as s from "@/server/db/schema";
import { newId } from "@/server/db/ids";
import { notFound, validationFailed } from "@/server/errors";

/**
 * What a ledger row means, and which way it moves the balance.
 *
 * The database holds `amount_cents > 0`, so a row records a magnitude and the
 * kind supplies the sign. `DEBIT_KINDS` is the list every sum has to agree on,
 * and it is exported so the seed, the invariants script and the tests read it
 * from one place instead of each spelling out the same CASE expression.
 *
 *   add     money the client paid in
 *   draw    an invoice consuming some of it
 *   adjust  a correction upward, including a draw given back
 *   reduce  a correction downward, including a refund
 *
 * `reduce` is new. Before it, a correction could only ever add, because the one
 * caller that existed was reversing a draw. Letting `adjust` carry a negative
 * amount would have been the smaller diff and it fails the CHECK constraint,
 * which is the database being right: a column of magnitudes should stay
 * magnitudes.
 */
export type MovementKind = "add" | "draw" | "adjust" | "reduce";

/** The kinds that take money off the balance. Every sum over the ledger uses this. */
export const DEBIT_KINDS = ["draw", "reduce"] as const;

export const ledgerDelta = (kind: string, amountCents: number): number =>
  (DEBIT_KINDS as readonly string[]).includes(kind) ? -amountCents : amountCents;

export interface Movement {
  retainerId: string;
  kind: MovementKind;
  /** Signed: positive adds to the balance, negative takes from it. */
  deltaCents: number;
  note?: string | null;
  invoiceId?: string | null;
}

/**
 * Change a retainer's balance, and write the ledger row that explains it.
 *
 * Must be called inside a transaction: the row lock it takes is what stops two
 * concurrent movements from both reading the same balance, both writing a
 * ledger row, and only one of the two balances surviving.
 *
 * Returns the balance afterwards, or null when the retainer is gone.
 */
export async function moveBalance(ctx: Ctx, m: Movement): Promise<number | null> {
  const [retainer] = await ctx.db
    .select()
    .from(s.retainers)
    .where(eq(s.retainers.id, m.retainerId))
    .limit(1)
    .for("update");

  if (!retainer) return null;

  const balanceAfter = retainer.balanceCents + m.deltaCents;

  if (balanceAfter < 0) {
    throw validationFailed({
      amountCents: [
        `That would take the balance to ${(balanceAfter / 100).toFixed(2)}. ` +
          "A retainer cannot go below zero.",
      ],
    });
  }

  await ctx.db.insert(s.retainerTransactions).values({
    id: newId(),
    retainerId: retainer.id,
    kind: m.kind,
    // A magnitude, because `retainer_transactions_positive` requires one. The
    // kind is what says which way it went.
    amountCents: Math.abs(m.deltaCents),
    balanceAfterCents: balanceAfter,
    invoiceId: m.invoiceId ?? null,
    note: m.note ?? null,
    createdBy: ctx.actor.userId,
  });

  await ctx.db
    .update(s.retainers)
    .set({ balanceCents: balanceAfter })
    .where(eq(s.retainers.id, retainer.id));

  ctx.audit({
    action: `retainer.${m.kind}`,
    entityType: "retainer",
    entityId: retainer.id,
    entityLabel: "Retainer",
    after: { deltaCents: m.deltaCents, balanceAfter, invoiceId: m.invoiceId ?? null },
  });

  return balanceAfter;
}

/* ------------------------------------------------------------------ reads */

export interface RetainerDto {
  id: string;
  clientId: string;
  projectId: string | null;
  balanceCents: number;
  archivedAt: string | null;
  transactions: {
    id: string;
    kind: string;
    amountCents: number;
    balanceAfterCents: number;
    invoiceId: string | null;
    note: string | null;
    at: string;
  }[];
}

export async function listRetainers(ctx: Ctx, opts: { includeArchived?: boolean } = {}) {
  assertCan(ctx, "invoice:view");

  const rows = await ctx.db
    .select()
    .from(s.retainers)
    .where(opts.includeArchived ? undefined : isNull(s.retainers.archivedAt))
    .orderBy(desc(s.retainers.balanceCents));

  if (rows.length === 0) return [];

  const transactions = await ctx.db
    .select()
    .from(s.retainerTransactions)
    .where(inArray(s.retainerTransactions.retainerId, rows.map((r) => r.id)))
    .orderBy(desc(s.retainerTransactions.occurredAt));

  const byRetainer = new Map<string, typeof transactions>();
  for (const t of transactions) {
    const list = byRetainer.get(t.retainerId);
    if (list) list.push(t);
    else byRetainer.set(t.retainerId, [t]);
  }

  return rows.map(
    (r): RetainerDto => ({
      id: r.id,
      clientId: r.clientId,
      projectId: r.projectId,
      balanceCents: r.balanceCents,
      archivedAt: r.archivedAt ? r.archivedAt.toISOString() : null,
      transactions: (byRetainer.get(r.id) ?? []).map((t) => ({
        id: t.id,
        kind: t.kind,
        amountCents: t.amountCents,
        balanceAfterCents: t.balanceAfterCents,
        invoiceId: t.invoiceId,
        note: t.note,
        at: t.occurredAt.toISOString(),
      })),
    })
  );
}

/* ----------------------------------------------------------------- writes */

export interface CreateRetainerInput {
  clientId: string;
  projectId?: string | null;
  /** The money handed over at the start. Zero is legal: an empty retainer to fund later. */
  openingCents?: number;
  note?: string | null;
}

/**
 * Open a retainer for a client.
 *
 * The opening amount is a movement like any other, so a retainer that starts
 * with money has a ledger row explaining where it came from. A retainer whose
 * balance appeared without a transaction behind it is exactly the state the
 * invariant test exists to catch.
 */
export async function createRetainer(ctx: Ctx, input: CreateRetainerInput): Promise<RetainerDto> {
  assertCan(ctx, "invoice:manage");

  const opening = input.openingCents ?? 0;
  if (!Number.isInteger(opening) || opening < 0) {
    throw validationFailed({ openingCents: ["An opening amount cannot be negative."] });
  }

  const id = newId();

  await withTransaction(ctx, async (tx) => {
    const [client] = await tx.db
      .select({ id: s.clients.id, name: s.clients.name })
      .from(s.clients)
      .where(eq(s.clients.id, input.clientId))
      .limit(1);
    if (!client) throw validationFailed({ clientId: ["That client does not exist."] });

    if (input.projectId) {
      const [project] = await tx.db
        .select({ clientId: s.projects.clientId })
        .from(s.projects)
        .where(eq(s.projects.id, input.projectId))
        .limit(1);
      if (!project) throw validationFailed({ projectId: ["That project does not exist."] });
      if (project.clientId !== input.clientId) {
        throw validationFailed({ projectId: ["That project belongs to a different client."] });
      }
    }

    /**
     * One live retainer per client, or per project within a client.
     *
     * The database holds this with a unique index using NULLS NOT DISTINCT, so
     * a nullable `project_id` still collides. Checking here turns what would be
     * a 500 into a field error naming the retainer that already exists.
     */
    const [existing] = await tx.db
      .select({ id: s.retainers.id })
      .from(s.retainers)
      .where(
        and(
          eq(s.retainers.clientId, input.clientId),
          input.projectId
            ? eq(s.retainers.projectId, input.projectId)
            : isNull(s.retainers.projectId),
          isNull(s.retainers.archivedAt)
        )
      )
      .limit(1);

    if (existing) {
      throw validationFailed({
        clientId: [
          input.projectId
            ? "That project already has a retainer. Add funds to it instead."
            : `${client.name} already has a retainer. Add funds to it instead.`,
        ],
      });
    }

    await tx.db.insert(s.retainers).values({
      id,
      clientId: input.clientId,
      projectId: input.projectId ?? null,
      balanceCents: 0,
    });

    tx.audit({
      action: "retainer.create",
      entityType: "retainer",
      entityId: id,
      entityLabel: client.name,
      after: { clientId: input.clientId, projectId: input.projectId ?? null },
    });

    if (opening > 0) {
      await moveBalance(tx, {
        retainerId: id,
        kind: "add",
        deltaCents: opening,
        note: input.note ?? "Opening balance",
      });
    }
  });

  const [dto] = (await listRetainers(ctx, { includeArchived: true })).filter((r) => r.id === id);
  return dto!;
}

/** Add funds a client has paid in. */
export async function addFunds(
  ctx: Ctx,
  retainerId: string,
  input: { amountCents: number; note?: string | null }
): Promise<RetainerDto> {
  assertCan(ctx, "invoice:manage");

  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw validationFailed({ amountCents: ["Enter an amount greater than zero."] });
  }

  await withTransaction(ctx, async (tx) => {
    const balance = await moveBalance(tx, {
      retainerId,
      kind: "add",
      deltaCents: input.amountCents,
      note: input.note ?? "Funds added",
    });
    if (balance === null) throw notFound("That retainer");
  });

  return one(ctx, retainerId);
}

/**
 * Correct a balance, in either direction.
 *
 * Separate from adding funds because the two mean different things on a ledger
 * somebody may have to explain: an `add` is money received, an `adjust` is a
 * correction. Both move the balance the same way and through the same lock.
 */
export async function adjustBalance(
  ctx: Ctx,
  retainerId: string,
  input: { deltaCents: number; note?: string | null }
): Promise<RetainerDto> {
  assertCan(ctx, "invoice:manage");

  if (!Number.isInteger(input.deltaCents) || input.deltaCents === 0) {
    throw validationFailed({ deltaCents: ["Enter an amount to add or take away."] });
  }
  if (!input.note?.trim()) {
    // An unexplained correction is the one ledger row nobody can account for
    // later, which is the whole reason a ledger is kept.
    throw validationFailed({ note: ["Say why the balance is being corrected."] });
  }

  await withTransaction(ctx, async (tx) => {
    const balance = await moveBalance(tx, {
      retainerId,
      // Direction decides the kind, so the ledger reads correctly without
      // anybody having to remember which way `adjust` points.
      kind: input.deltaCents > 0 ? "adjust" : "reduce",
      deltaCents: input.deltaCents,
      note: input.note!.trim(),
    });
    if (balance === null) throw notFound("That retainer");
  });

  return one(ctx, retainerId);
}

/**
 * Archive a retainer, never delete it.
 *
 * Its transactions are how past invoices explain where their money came from,
 * and deleting the retainer would take them with it. A balance still on it has
 * to be dealt with first: archiving money would make it vanish from every total
 * without a ledger row saying where it went.
 */
export async function archiveRetainer(ctx: Ctx, retainerId: string): Promise<RetainerDto> {
  assertCan(ctx, "invoice:manage");

  await withTransaction(ctx, async (tx) => {
    const [retainer] = await tx.db
      .select()
      .from(s.retainers)
      .where(eq(s.retainers.id, retainerId))
      .limit(1)
      .for("update");

    if (!retainer) throw notFound("That retainer");

    if (retainer.balanceCents !== 0) {
      throw validationFailed({
        _: [
          "This retainer still holds funds. Draw it down or correct it to zero first, " +
            "so the ledger says where the money went.",
        ],
      });
    }

    await tx.db
      .update(s.retainers)
      .set({ archivedAt: tx.now() })
      .where(eq(s.retainers.id, retainerId));

    tx.audit({
      action: "retainer.archive",
      entityType: "retainer",
      entityId: retainerId,
      entityLabel: "Retainer",
      before: retainer,
    });
  });

  return one(ctx, retainerId);
}

async function one(ctx: Ctx, id: string): Promise<RetainerDto> {
  const found = (await listRetainers(ctx, { includeArchived: true })).find((r) => r.id === id);
  if (!found) throw notFound("That retainer");
  return found;
}
