/**
 * Expenses.
 *
 * Structurally the same as time entries: the same editability locks, the same
 * uninvoiced predicate, the same 404-not-403. The differences are that money
 * comes in directly rather than through a rate, and that an expense can be
 * owed back to the person who paid it, which is a second lifecycle running
 * alongside the billing one.
 */

import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { assertCan, withTransaction, type Ctx } from "@/server/ctx";
import * as s from "@/server/db/schema";
import { newId } from "@/server/db/ids";
import { canActOnBehalfOf, expenseScope } from "@/server/auth/scope";
import { forbidden, notFound, recordLocked, validationFailed } from "@/server/errors";
import { canEdit, type EditabilityContext } from "@/domain/editability";
import { dayIn, type IsoDate } from "@/domain/calendar";
import { getSettings } from "./settings";

export interface ExpenseDto {
  id: string;
  userId: string;
  projectId: string;
  categoryId: string;
  spentOn: string;
  units: number | null;
  totalCents: number;
  notes: string | null;
  isBillable: boolean;
  isReimbursable: boolean;
  reimbursementState: string | null;
  reimbursedAt: string | null;
  receiptFilename: string | null;
  invoiceId: string | null;
  billedExternally: boolean;
  locked: boolean;
  lockReasons: string[];
}

const toDto = (
  row: s.ExpenseRow,
  lock: { locked: boolean; lockReasons: string[] } = { locked: false, lockReasons: [] }
): ExpenseDto => ({
  id: row.id,
  userId: row.userId,
  projectId: row.projectId,
  categoryId: row.categoryId,
  spentOn: row.spentOn,
  units: row.units == null ? null : Number(row.units),
  totalCents: row.totalCents,
  notes: row.notes,
  isBillable: row.isBillable,
  isReimbursable: row.isReimbursable,
  reimbursementState: row.reimbursementState,
  reimbursedAt: row.reimbursedAt ? row.reimbursedAt.toISOString() : null,
  receiptFilename: row.receiptFilename,
  invoiceId: row.invoiceId,
  billedExternally: row.billedExternally,
  locked: lock.locked,
  lockReasons: lock.lockReasons,
});

/* -------------------------------------------------------------- editability */

async function editabilityContextFor(
  ctx: Ctx,
  userIds: string[]
): Promise<(userId: string) => EditabilityContext> {
  const settings = await getSettings(ctx);
  const canOverride =
    ctx.actor.kind === "system" ||
    ctx.actor.capabilities.has("people:manage") ||
    ctx.actor.baseKey === "administrator";

  const approvals = userIds.length
    ? await ctx.db
        .select({
          userId: s.timesheetSubmissions.userId,
          periodStart: s.timesheetSubmissions.periodStart,
          periodEnd: s.timesheetSubmissions.periodEnd,
        })
        .from(s.timesheetSubmissions)
        .where(and(inArray(s.timesheetSubmissions.userId, userIds), eq(s.timesheetSubmissions.state, "approved")))
    : [];

  const byUser = new Map<string, { periodStart: string; periodEnd: string }[]>();
  for (const a of approvals) {
    const list = byUser.get(a.userId);
    if (list) list.push(a);
    else byUser.set(a.userId, [a]);
  }

  const today = dayIn(settings.timezone, ctx.now());

  return (userId: string) => ({
    today,
    approvedPeriods: byUser.get(userId) ?? [],
    lockTimesheetsAfterDays: settings.lockTimesheetsAfterDays,
    canOverride,
  });
}

/* -------------------------------------------------------------------- read */

export interface ExpenseQuery {
  from?: IsoDate;
  to?: IsoDate;
  userId?: string;
  projectId?: string;
  reimbursableOnly?: boolean;
  invoiced?: boolean;
}

export async function listExpenses(ctx: Ctx, q: ExpenseQuery = {}): Promise<ExpenseDto[]> {
  const conditions = [isNull(s.expenses.deletedAt), expenseScope(ctx, { requestedUserId: q.userId })];
  if (q.from) conditions.push(gte(s.expenses.spentOn, q.from));
  if (q.to) conditions.push(lte(s.expenses.spentOn, q.to));
  if (q.userId) conditions.push(eq(s.expenses.userId, q.userId));
  if (q.projectId) conditions.push(eq(s.expenses.projectId, q.projectId));
  if (q.reimbursableOnly) conditions.push(eq(s.expenses.isReimbursable, true));
  if (q.invoiced === true) conditions.push(sql`${s.expenses.invoiceId} IS NOT NULL`);
  if (q.invoiced === false) conditions.push(isNull(s.expenses.invoiceId));

  const rows = await ctx.db
    .select({ expense: s.expenses, invoiceState: s.invoices.state })
    .from(s.expenses)
    .leftJoin(s.invoices, eq(s.invoices.id, s.expenses.invoiceId))
    .where(and(...conditions))
    .orderBy(desc(s.expenses.spentOn), asc(s.expenses.createdAt))
    .limit(5000);

  if (rows.length === 0) return [];

  const lockContext = await editabilityContextFor(ctx, [...new Set(rows.map((r) => r.expense.userId))]);

  return rows.map((r) => {
    const lock = canEdit(
      {
        spentOn: r.expense.spentOn,
        userId: r.expense.userId,
        invoiceId: r.expense.invoiceId,
        invoiceState: r.invoiceState,
        billedExternally: r.expense.billedExternally,
      },
      lockContext(r.expense.userId)
    );
    return toDto(r.expense, { locked: !lock.editable, lockReasons: lock.reasons });
  });
}

export async function getExpense(ctx: Ctx, id: string): Promise<ExpenseDto> {
  const [row] = await ctx.db
    .select({ expense: s.expenses, invoiceState: s.invoices.state })
    .from(s.expenses)
    .leftJoin(s.invoices, eq(s.invoices.id, s.expenses.invoiceId))
    .where(and(eq(s.expenses.id, id), isNull(s.expenses.deletedAt), expenseScope(ctx)))
    .limit(1);

  if (!row) throw notFound("That expense");

  const lockContext = await editabilityContextFor(ctx, [row.expense.userId]);
  const lock = canEdit(
    {
      spentOn: row.expense.spentOn,
      userId: row.expense.userId,
      invoiceId: row.expense.invoiceId,
      invoiceState: row.invoiceState,
      billedExternally: row.expense.billedExternally,
    },
    lockContext(row.expense.userId)
  );

  return toDto(row.expense, { locked: !lock.editable, lockReasons: lock.reasons });
}

/* ------------------------------------------------------------------- write */

export interface ExpenseInput {
  userId?: string;
  projectId: string;
  categoryId: string;
  spentOn: IsoDate;
  units?: number | null;
  totalCents: number;
  notes?: string | null;
  isBillable?: boolean;
  isReimbursable?: boolean;
  receiptFilename?: string | null;
}

export async function createExpense(ctx: Ctx, input: ExpenseInput): Promise<ExpenseDto> {
  const targetUserId = input.userId ?? ctx.actor.userId;
  const own = targetUserId === ctx.actor.userId;

  if (own) assertCan(ctx, "expense:create_own");
  else if (!ctx.actor.capabilities.has("expense:manage") && !(await canActOnBehalfOf(ctx, targetUserId))) {
    throw forbidden("You cannot record expenses for that person.");
  }

  return withTransaction(ctx, async (tx) => {
    const [project] = await tx.db
      .select({ archivedAt: s.projects.archivedAt, name: s.projects.name })
      .from(s.projects)
      .where(eq(s.projects.id, input.projectId))
      .limit(1);
    if (!project) throw validationFailed({ projectId: ["That project does not exist."] });
    if (project.archivedAt) throw validationFailed({ projectId: ["That project is archived."] });

    const [category] = await tx.db
      .select({ unitPriceCents: s.expenseCategories.unitPriceCents, name: s.expenseCategories.name })
      .from(s.expenseCategories)
      .where(eq(s.expenseCategories.id, input.categoryId))
      .limit(1);
    if (!category) throw validationFailed({ categoryId: ["That category does not exist."] });

    // A unit-priced category computes its own total. Accepting the client's
    // number would let a mileage claim be any amount at all.
    const totalCents =
      category.unitPriceCents != null && input.units != null
        ? Math.round(input.units * category.unitPriceCents)
        : input.totalCents;

    if (totalCents < 0) throw validationFailed({ totalCents: ["An expense cannot be negative."] });

    const isReimbursable = input.isReimbursable ?? false;
    const id = newId();

    await tx.db.insert(s.expenses).values({
      id,
      userId: targetUserId,
      projectId: input.projectId,
      categoryId: input.categoryId,
      spentOn: input.spentOn,
      units: input.units == null ? null : String(input.units),
      totalCents,
      notes: input.notes?.trim() || null,
      isBillable: input.isBillable ?? true,
      isReimbursable,
      // A non-reimbursable expense has no reimbursement state to be in; the
      // database enforces that too.
      reimbursementState: isReimbursable ? "pending" : null,
      receiptFilename: input.receiptFilename ?? null,
      createdBy: ctx.actor.userId,
      updatedBy: ctx.actor.userId,
    });

    tx.audit({
      action: "expense.create",
      entityType: "expense",
      entityId: id,
      entityLabel: `${category.name} on ${project.name}`,
      after: { totalCents, spentOn: input.spentOn, projectId: input.projectId },
    });

    return getExpense(tx, id);
  });
}

async function loadEditable(ctx: Ctx, id: string) {
  const [row] = await ctx.db
    .select({ expense: s.expenses, invoiceState: s.invoices.state })
    .from(s.expenses)
    .leftJoin(s.invoices, eq(s.invoices.id, s.expenses.invoiceId))
    .where(and(eq(s.expenses.id, id), isNull(s.expenses.deletedAt), expenseScope(ctx)))
    .limit(1);

  if (!row) throw notFound("That expense");

  const own = row.expense.userId === ctx.actor.userId;
  if (own) assertCan(ctx, "expense:edit_own");
  else if (!ctx.actor.capabilities.has("expense:manage") && !ctx.actor.capabilities.has("expense:edit_others")) {
    throw forbidden("You cannot change that expense.");
  }

  const lockContext = await editabilityContextFor(ctx, [row.expense.userId]);
  const lock = canEdit(
    {
      spentOn: row.expense.spentOn,
      userId: row.expense.userId,
      invoiceId: row.expense.invoiceId,
      invoiceState: row.invoiceState,
      billedExternally: row.expense.billedExternally,
    },
    lockContext(row.expense.userId)
  );

  if (!lock.editable) throw recordLocked(lock.reasons);
  return { expense: row.expense, requiresOverride: lock.requiresOverride };
}

export async function updateExpense(
  ctx: Ctx,
  id: string,
  input: Partial<Omit<ExpenseInput, "userId">>
): Promise<ExpenseDto> {
  return withTransaction(ctx, async (tx) => {
    const { expense: before, requiresOverride } = await loadEditable(tx, id);

    const patch: Record<string, unknown> = { updatedAt: tx.now(), updatedBy: tx.actor.userId };
    if (input.projectId !== undefined) patch.projectId = input.projectId;
    if (input.categoryId !== undefined) patch.categoryId = input.categoryId;
    if (input.spentOn !== undefined) patch.spentOn = input.spentOn;
    if (input.notes !== undefined) patch.notes = input.notes?.trim() || null;
    if (input.isBillable !== undefined) patch.isBillable = input.isBillable;
    if (input.receiptFilename !== undefined) patch.receiptFilename = input.receiptFilename;

    if (input.isReimbursable !== undefined) {
      patch.isReimbursable = input.isReimbursable;
      patch.reimbursementState = input.isReimbursable ? (before.reimbursementState ?? "pending") : null;
      if (!input.isReimbursable) patch.reimbursedAt = null;
    }

    if (input.units !== undefined || input.totalCents !== undefined) {
      const categoryId = input.categoryId ?? before.categoryId;
      const [category] = await tx.db
        .select({ unitPriceCents: s.expenseCategories.unitPriceCents })
        .from(s.expenseCategories)
        .where(eq(s.expenseCategories.id, categoryId))
        .limit(1);

      const units = input.units ?? (before.units == null ? null : Number(before.units));
      patch.units = units == null ? null : String(units);
      patch.totalCents =
        category?.unitPriceCents != null && units != null
          ? Math.round(units * category.unitPriceCents)
          : (input.totalCents ?? before.totalCents);
    }

    const [after] = await tx.db.update(s.expenses).set(patch as never).where(eq(s.expenses.id, id)).returning();

    tx.audit({
      action: "expense.update",
      entityType: "expense",
      entityId: id,
      before,
      after,
      override: requiresOverride,
    });

    return getExpense(tx, id);
  });
}

export async function deleteExpense(ctx: Ctx, id: string): Promise<void> {
  await withTransaction(ctx, async (tx) => {
    const { expense, requiresOverride } = await loadEditable(tx, id);
    await tx.db
      .update(s.expenses)
      .set({ deletedAt: tx.now(), updatedBy: tx.actor.userId })
      .where(eq(s.expenses.id, id));
    tx.audit({
      action: "expense.delete",
      entityType: "expense",
      entityId: id,
      before: expense,
      override: requiresOverride,
    });
  });
}

/* ------------------------------------------------------------ reimbursement */

/**
 * Moves reimbursements along their own lifecycle.
 *
 * Separate from the billing lifecycle on purpose: whether a client is charged
 * for a taxi and whether the person who paid for it has been repaid are
 * unrelated questions, and conflating them is how somebody ends up out of
 * pocket on an invoiced expense.
 */
export async function setReimbursementState(
  ctx: Ctx,
  ids: string[],
  state: "pending" | "approved" | "paid",
  paidAt?: string
): Promise<number> {
  assertCan(ctx, "expense:manage");
  if (ids.length === 0) return 0;

  return withTransaction(ctx, async (tx) => {
    const rows = await tx.db
      .select({ id: s.expenses.id, isReimbursable: s.expenses.isReimbursable })
      .from(s.expenses)
      .where(and(inArray(s.expenses.id, ids), isNull(s.expenses.deletedAt), expenseScope(tx)));

    const eligible = rows.filter((r) => r.isReimbursable).map((r) => r.id);
    if (eligible.length === 0) return 0;

    await tx.db
      .update(s.expenses)
      .set({
        reimbursementState: state,
        reimbursedAt: state === "paid" ? (paidAt ? new Date(paidAt) : tx.now()) : null,
        updatedAt: tx.now(),
        updatedBy: tx.actor.userId,
      })
      .where(inArray(s.expenses.id, eligible));

    tx.audit({
      action: `expense.reimbursement.${state}`,
      entityType: "expense",
      after: { ids: eligible, state },
    });

    return eligible.length;
  });
}

/* ---------------------------------------------------------------- categories */

export async function createExpenseCategory(
  ctx: Ctx,
  input: { name: string; unitName?: string | null; unitPriceCents?: number | null }
) {
  assertCan(ctx, "settings:manage");
  const name = input.name.trim();
  if (!name) throw validationFailed({ name: ["A category needs a name."] });

  // A unit price without a unit name reads as "$0.45 per what?" on every form.
  if (input.unitPriceCents != null && !input.unitName?.trim()) {
    throw validationFailed({ unitName: ["A unit price needs a unit, for example mile."] });
  }

  const id = newId();
  await ctx.db.insert(s.expenseCategories).values({
    id,
    name,
    unitName: input.unitName?.trim() || null,
    unitPriceCents: input.unitPriceCents ?? null,
  });

  ctx.audit({ action: "expense_category.create", entityType: "expense_category", entityId: id, entityLabel: name });
  return { id, name, unitName: input.unitName ?? null, unitPriceCents: input.unitPriceCents ?? null };
}

export async function updateExpenseCategory(
  ctx: Ctx,
  id: string,
  input: { name?: string; unitName?: string | null; unitPriceCents?: number | null; archived?: boolean }
) {
  assertCan(ctx, "settings:manage");

  const [before] = await ctx.db.select().from(s.expenseCategories).where(eq(s.expenseCategories.id, id)).limit(1);
  if (!before) throw notFound("That category");

  const patch: Record<string, unknown> = { updatedAt: ctx.now() };
  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.unitName !== undefined) patch.unitName = input.unitName?.trim() || null;
  if (input.unitPriceCents !== undefined) patch.unitPriceCents = input.unitPriceCents;
  if (input.archived !== undefined) patch.archivedAt = input.archived ? ctx.now() : null;

  const [after] = await ctx.db
    .update(s.expenseCategories)
    .set(patch as never)
    .where(eq(s.expenseCategories.id, id))
    .returning();

  ctx.audit({
    action: "expense_category.update",
    entityType: "expense_category",
    entityId: id,
    before,
    after,
  });

  return {
    id: after!.id,
    name: after!.name,
    unitName: after!.unitName,
    unitPriceCents: after!.unitPriceCents,
    archivedAt: after!.archivedAt ? after!.archivedAt.toISOString() : null,
  };
}
