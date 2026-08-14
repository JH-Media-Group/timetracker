/**
 * Invoice item types.
 *
 * What kind of thing a line is: a Service, a Product, a Direct Cost. They show
 * on the invoice under the Item Type column, and QuickBooks eventually maps
 * them to income accounts, which is what `qboIncomeAccountId` is waiting for.
 *
 * Two of them hold a **default role**: one is what an expense line becomes, one
 * is what a time or fee line becomes. Exactly one row holds each, always. An
 * account with no services default has invoice lines that cannot say what they
 * are, so the rule is enforced here, again in `pnpm db:invariants` against the
 * data, and the seed rows are created by a migration rather than the seed
 * script so production has them too.
 *
 * Archive, never delete, once a type is in use. A deleted type behind a line on
 * a sent invoice would stop that invoice rendering, and a sent invoice is a
 * document somebody else is holding a copy of.
 */

import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { assertCan, withTransaction, type Ctx } from "@/server/ctx";
import * as s from "@/server/db/schema";
import { newId } from "@/server/db/ids";
import { notFound, validationFailed } from "@/server/errors";

export interface ItemTypeDto {
  id: string;
  name: string;
  isDefaultForExpenses: boolean;
  isDefaultForServices: boolean;
  archivedAt: string | null;
  /** How many invoice lines point at it, which decides whether it can be removed. */
  usageCount: number;
}

export async function listItemTypes(ctx: Ctx): Promise<ItemTypeDto[]> {
  const rows = await ctx.db
    .select({
      id: s.invoiceItemTypes.id,
      name: s.invoiceItemTypes.name,
      isDefaultForExpenses: s.invoiceItemTypes.isDefaultForExpenses,
      isDefaultForServices: s.invoiceItemTypes.isDefaultForServices,
      archivedAt: s.invoiceItemTypes.archivedAt,
      usageCount: sql<number>`(
        SELECT COUNT(*)::int FROM ${s.invoiceLineItems}
         WHERE ${s.invoiceLineItems.itemTypeId} = ${s.invoiceItemTypes.id}
      )`,
    })
    .from(s.invoiceItemTypes)
    .orderBy(asc(s.invoiceItemTypes.name));

  return rows.map((r) => ({
    ...r,
    archivedAt: r.archivedAt ? r.archivedAt.toISOString() : null,
  }));
}

/** The type a line of this kind should carry, or null if the account has none. */
export async function defaultItemTypeId(
  ctx: Ctx,
  kind: "expense" | "service"
): Promise<string | null> {
  const column =
    kind === "expense"
      ? s.invoiceItemTypes.isDefaultForExpenses
      : s.invoiceItemTypes.isDefaultForServices;

  const [row] = await ctx.db
    .select({ id: s.invoiceItemTypes.id })
    .from(s.invoiceItemTypes)
    .where(and(eq(column, true), isNull(s.invoiceItemTypes.archivedAt)))
    .limit(1);

  return row?.id ?? null;
}

export async function createItemType(
  ctx: Ctx,
  input: { name: string; isDefaultForExpenses?: boolean; isDefaultForServices?: boolean }
): Promise<ItemTypeDto> {
  assertCan(ctx, "settings:manage");
  const name = input.name.trim();
  if (!name) throw validationFailed({ name: ["A name is needed."] });

  const id = newId();
  await withTransaction(ctx, async (tx) => {
    await assertNameIsFree(tx, name, null);
    if (input.isDefaultForExpenses) await clearDefault(tx, "expense");
    if (input.isDefaultForServices) await clearDefault(tx, "service");

    await tx.db.insert(s.invoiceItemTypes).values({
      id,
      name,
      isDefaultForExpenses: input.isDefaultForExpenses ?? false,
      isDefaultForServices: input.isDefaultForServices ?? false,
    });

    tx.audit({
      action: "invoice_item_type.create",
      entityType: "invoice_item_type",
      entityId: id,
      entityLabel: name,
      after: { name },
    });
  });

  return (await listItemTypes(ctx)).find((t) => t.id === id)!;
}

export async function updateItemType(
  ctx: Ctx,
  id: string,
  input: { name?: string; isDefaultForExpenses?: boolean; isDefaultForServices?: boolean }
): Promise<ItemTypeDto> {
  assertCan(ctx, "settings:manage");

  await withTransaction(ctx, async (tx) => {
    const before = await load(tx, id);
    const patch: Record<string, unknown> = {};

    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) throw validationFailed({ name: ["A name is needed."] });
      await assertNameIsFree(tx, name, id);
      patch.name = name;
    }

    /**
     * A default role can be moved to another type, never simply switched off.
     *
     * Unchecking it on the only type that holds it would leave the account with
     * no answer to "what is an expense line", which is the state the invariant
     * exists to prevent. Setting it on a different type moves it, which is how
     * a person actually changes their mind.
     */
    if (input.isDefaultForExpenses === true) {
      await clearDefault(tx, "expense");
      patch.isDefaultForExpenses = true;
    } else if (input.isDefaultForExpenses === false && before.isDefaultForExpenses) {
      throw validationFailed({
        isDefaultForExpenses: [
          "Something has to be the default for expenses. Set another type as the default instead.",
        ],
      });
    }

    if (input.isDefaultForServices === true) {
      await clearDefault(tx, "service");
      patch.isDefaultForServices = true;
    } else if (input.isDefaultForServices === false && before.isDefaultForServices) {
      throw validationFailed({
        isDefaultForServices: [
          "Something has to be the default for billable hours. Set another type as the default instead.",
        ],
      });
    }

    if (Object.keys(patch).length) {
      await tx.db.update(s.invoiceItemTypes).set(patch).where(eq(s.invoiceItemTypes.id, id));
    }

    tx.audit({
      action: "invoice_item_type.update",
      entityType: "invoice_item_type",
      entityId: id,
      entityLabel: (patch.name as string) ?? before.name,
      before,
      after: patch,
    });
  });

  return (await listItemTypes(ctx)).find((t) => t.id === id)!;
}

/**
 * Archive, or delete when nothing has ever used it.
 *
 * Harvest greys out Delete on the two defaults. We refuse the same two, and
 * additionally refuse to delete a type any line points at, because that line is
 * on an invoice somebody was sent.
 */
export async function removeItemType(ctx: Ctx, id: string): Promise<{ archived: boolean }> {
  assertCan(ctx, "settings:manage");

  return withTransaction(ctx, async (tx) => {
    const before = await load(tx, id);

    if (before.isDefaultForExpenses || before.isDefaultForServices) {
      throw validationFailed({
        _: ["A default type cannot be removed. Make another type the default first."],
      });
    }

    const [{ count } = { count: 0 }] = await tx.db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(s.invoiceLineItems)
      .where(eq(s.invoiceLineItems.itemTypeId, id));

    const archived = count > 0;

    if (archived) {
      await tx.db
        .update(s.invoiceItemTypes)
        .set({ archivedAt: tx.now() })
        .where(eq(s.invoiceItemTypes.id, id));
    } else {
      await tx.db.delete(s.invoiceItemTypes).where(eq(s.invoiceItemTypes.id, id));
    }

    tx.audit({
      action: archived ? "invoice_item_type.archive" : "invoice_item_type.delete",
      entityType: "invoice_item_type",
      entityId: id,
      entityLabel: before.name,
      before,
    });

    return { archived };
  });
}

/* ------------------------------------------------------------------ helpers */

async function load(ctx: Ctx, id: string) {
  const [row] = await ctx.db
    .select()
    .from(s.invoiceItemTypes)
    .where(eq(s.invoiceItemTypes.id, id))
    .limit(1);
  if (!row) throw notFound("That item type");
  return row;
}

/** Names are unique in the database; this turns a 500 into a field error. */
async function assertNameIsFree(ctx: Ctx, name: string, exceptId: string | null) {
  const [clash] = await ctx.db
    .select({ id: s.invoiceItemTypes.id })
    .from(s.invoiceItemTypes)
    .where(
      exceptId
        ? and(eq(s.invoiceItemTypes.name, name), ne(s.invoiceItemTypes.id, exceptId))
        : eq(s.invoiceItemTypes.name, name)
    )
    .limit(1);

  if (clash) throw validationFailed({ name: ["There is already a type with that name."] });
}

async function clearDefault(ctx: Ctx, kind: "expense" | "service") {
  const column =
    kind === "expense"
      ? { isDefaultForExpenses: false }
      : { isDefaultForServices: false };

  await ctx.db.update(s.invoiceItemTypes).set(column);
}
