/**
 * Invoices.
 *
 * The rules that matter, all from BACKEND_PRD section 4.8:
 *
 *   - the number sequence is drawn inside the creating transaction under a row
 *     lock, so two concurrent creates cannot collide on it.
 *   - totals compute in a fixed order and every intermediate is stored, because
 *     "why is this two cents different" has to be answerable from the row.
 *   - creating a draft *claims* its time entries and expenses. That is what
 *     stops the same hour being billed twice, and it is why deleting a draft
 *     has to release them again.
 *   - sending locks the rate snapshots on everything attached. After that the
 *     client has been told a number, and the number cannot move underneath it.
 */

import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { assertCan, lockNamed, withTransaction, type Ctx } from "@/server/ctx";
import * as s from "@/server/db/schema";
import { newId, randomToken } from "@/server/db/ids";
import { invoiceScope } from "@/server/auth/scope";
import { AppError, notFound, validationFailed } from "@/server/errors";
import { serializeInvoice, type InvoiceDto } from "@/server/serialize";
import { computeInvoiceTotals, lineAmount, secondsToCents } from "@/domain/money";
import {
  canDelete, canTransition, clientCodeFrom, displayState, renderInvoiceNumber,
  stateAfterPayment, type InvoiceState,
} from "@/domain/invoices";
import { dayIn, type IsoDate } from "@/domain/calendar";
import { getSettings } from "./settings";

/* -------------------------------------------------------------------- read */

export interface InvoiceDetail extends InvoiceDto {
  lineItems: {
    id: string;
    position: number;
    projectId: string | null;
    description: string;
    quantity: number;
    unitPriceCents: number;
    amountCents: number;
    isTaxed: boolean;
  }[];
  payments: {
    id: string;
    amountCents: number;
    paidAt: string;
    method: string | null;
    reference: string | null;
    voidedAt: string | null;
  }[];
  events: { id: string; kind: string; label: string; actorId: string | null; at: string; amountCents: number | null }[];
}

async function todayFor(ctx: Ctx): Promise<IsoDate> {
  const settings = await getSettings(ctx);
  return dayIn(settings.timezone, ctx.now());
}

export async function listInvoices(
  ctx: Ctx,
  opts: { state?: string; clientId?: string } = {}
): Promise<InvoiceDto[]> {
  assertCan(ctx, "invoice:view");

  const conditions = [isNull(s.invoices.deletedAt), invoiceScope(ctx)];
  if (opts.clientId) conditions.push(eq(s.invoices.clientId, opts.clientId));
  if (opts.state === "outstanding") conditions.push(eq(s.invoices.state, "open"));
  else if (opts.state === "draft") conditions.push(eq(s.invoices.state, "draft"));
  else if (opts.state === "paid") conditions.push(inArray(s.invoices.state, ["paid", "written_off", "closed"]));

  const rows = await ctx.db
    .select()
    .from(s.invoices)
    .where(and(...conditions))
    .orderBy(desc(s.invoices.issueDate), desc(s.invoices.number))
    .limit(1000);

  if (rows.length === 0) return [];

  const links = await ctx.db
    .select({ invoiceId: s.invoiceProjects.invoiceId, projectId: s.invoiceProjects.projectId })
    .from(s.invoiceProjects)
    .where(inArray(s.invoiceProjects.invoiceId, rows.map((r) => r.id)));

  const byInvoice = new Map<string, string[]>();
  for (const l of links) {
    const list = byInvoice.get(l.invoiceId);
    if (list) list.push(l.projectId);
    else byInvoice.set(l.invoiceId, [l.projectId]);
  }

  const today = await todayFor(ctx);

  return rows.map((r) =>
    serializeInvoice(r, {
      displayState: displayState({
        state: r.state as InvoiceState,
        dueDate: r.dueDate,
        totalCents: r.totalCents,
        paidCents: r.paidCents,
        today,
      }),
      projectIds: byInvoice.get(r.id) ?? [],
    })
  );
}

export async function getInvoice(ctx: Ctx, id: string): Promise<InvoiceDetail> {
  assertCan(ctx, "invoice:view");

  const [row] = await ctx.db
    .select()
    .from(s.invoices)
    .where(and(eq(s.invoices.id, id), isNull(s.invoices.deletedAt), invoiceScope(ctx)))
    .limit(1);
  if (!row) throw notFound("That invoice");

  const [lines, payments, messages, links] = await Promise.all([
    ctx.db
      .select()
      .from(s.invoiceLineItems)
      .where(eq(s.invoiceLineItems.invoiceId, id))
      .orderBy(asc(s.invoiceLineItems.position)),
    ctx.db
      .select()
      .from(s.invoicePayments)
      .where(eq(s.invoicePayments.invoiceId, id))
      .orderBy(desc(s.invoicePayments.paidAt)),
    ctx.db
      .select()
      .from(s.invoiceMessages)
      .where(eq(s.invoiceMessages.invoiceId, id))
      .orderBy(desc(s.invoiceMessages.sentAt)),
    ctx.db
      .select({ projectId: s.invoiceProjects.projectId })
      .from(s.invoiceProjects)
      .where(eq(s.invoiceProjects.invoiceId, id)),
  ]);

  const today = await todayFor(ctx);

  // The activity timeline is assembled from the rows that actually record
  // something, rather than from a separate events table that could disagree
  // with them.
  const events: InvoiceDetail["events"] = [
    {
      id: `created-${row.id}`,
      kind: "created",
      label: "Invoice created.",
      actorId: row.createdBy,
      at: row.createdAt.toISOString(),
      amountCents: null,
    },
    ...(row.sentAt
      ? [{
          id: `sent-${row.id}`, kind: "sent", label: "Invoice marked as sent.",
          actorId: row.updatedBy, at: row.sentAt.toISOString(), amountCents: null,
        }]
      : []),
    ...messages.map((m) => ({
      id: m.id,
      kind: m.kind,
      label:
        m.deliveryState === "not_configured"
          ? `${labelForMessage(m.kind)} recorded, but no mail transport is configured.`
          : labelForMessage(m.kind),
      actorId: m.sentBy,
      at: m.sentAt.toISOString(),
      amountCents: null,
    })),
    ...payments
      .filter((p) => !p.voidedAt)
      .map((p) => ({
        id: p.id, kind: "payment", label: "Payment received.",
        actorId: p.recordedBy, at: p.paidAt.toISOString(), amountCents: p.amountCents,
      })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  return {
    ...serializeInvoice(row, {
      displayState: displayState({
        state: row.state as InvoiceState,
        dueDate: row.dueDate,
        totalCents: row.totalCents,
        paidCents: row.paidCents,
        today,
      }),
      projectIds: links.map((l) => l.projectId),
    }),
    lineItems: lines.map((l) => ({
      id: l.id,
      position: l.position,
      projectId: l.projectId,
      description: l.description,
      quantity: Number(l.quantity),
      unitPriceCents: l.unitPriceCents,
      amountCents: l.amountCents,
      isTaxed: l.isTaxed,
    })),
    payments: payments.map((p) => ({
      id: p.id,
      amountCents: p.amountCents,
      paidAt: p.paidAt.toISOString(),
      method: p.method,
      reference: p.reference,
      voidedAt: p.voidedAt ? p.voidedAt.toISOString() : null,
    })),
    events,
  };
}

const labelForMessage = (kind: string) =>
  kind === "reminder" ? "Reminder sent." : kind === "thank_you" ? "Thank you sent." : "Invoice emailed.";

/* -------------------------------------------------------- uninvoiced work */

export interface UninvoicedLine {
  key: string;
  projectId: string;
  kind: "time" | "expense";
  label: string;
  sublabel: string;
  quantity: number;
  unitPriceCents: number;
  amountCents: number;
  timeEntryIds: string[];
  expenseIds: string[];
}

/**
 * What could go on an invoice for a client.
 *
 * The predicate is the shared one: billable, not already on an invoice, and not
 * billed in Harvest before the migration. Without that last clause every
 * historical hour would look like an unpaid receivable on day one.
 */
export async function previewLines(
  ctx: Ctx,
  input: { clientId: string; projectIds?: string[]; from?: IsoDate; to?: IsoDate; grouping?: "project" | "task" | "person" }
): Promise<UninvoicedLine[]> {
  assertCan(ctx, "invoice:manage");
  const grouping = input.grouping ?? "project";

  const projectFilter = input.projectIds?.length
    ? inArray(s.projects.id, input.projectIds)
    : sql`true`;

  const entries = await ctx.db
    .select({
      projectId: s.timeEntries.projectId,
      projectName: s.projects.name,
      taskName: s.tasks.name,
      userId: s.timeEntries.userId,
      firstName: s.users.firstName,
      lastName: s.users.lastName,
      rate: s.timeEntries.billableRateCents,
      seconds: s.timeEntries.durationSeconds,
      entryId: s.timeEntries.id,
    })
    .from(s.timeEntries)
    .innerJoin(s.projects, eq(s.projects.id, s.timeEntries.projectId))
    .innerJoin(s.projectTasks, eq(s.projectTasks.id, s.timeEntries.projectTaskId))
    .innerJoin(s.tasks, eq(s.tasks.id, s.projectTasks.taskId))
    .innerJoin(s.users, eq(s.users.id, s.timeEntries.userId))
    .where(
      and(
        eq(s.projects.clientId, input.clientId),
        projectFilter,
        eq(s.timeEntries.isBillable, true),
        isNull(s.timeEntries.invoiceId),
        eq(s.timeEntries.billedExternally, false),
        isNull(s.timeEntries.deletedAt),
        isNull(s.timeEntries.timerStartedAt),
        input.from ? sql`${s.timeEntries.spentOn} >= ${input.from}` : sql`true`,
        input.to ? sql`${s.timeEntries.spentOn} <= ${input.to}` : sql`true`
      )
    );

  const buckets = new Map<string, UninvoicedLine>();

  for (const e of entries) {
    const detail =
      grouping === "task" ? e.taskName : grouping === "person" ? `${e.firstName} ${e.lastName}` : "";
    const key = `time:${e.projectId}:${detail}:${e.rate}`;

    const bucket = buckets.get(key) ?? {
      key,
      projectId: e.projectId,
      kind: "time" as const,
      label: e.projectName,
      sublabel: detail || "Billable time",
      quantity: 0,
      unitPriceCents: e.rate,
      amountCents: 0,
      timeEntryIds: [],
      expenseIds: [],
    };

    bucket.quantity += e.seconds / 3600;
    bucket.amountCents += secondsToCents(e.seconds, e.rate);
    bucket.timeEntryIds.push(e.entryId);
    buckets.set(key, bucket);
  }

  const expenses = await ctx.db
    .select({
      projectId: s.expenses.projectId,
      projectName: s.projects.name,
      categoryName: s.expenseCategories.name,
      categoryId: s.expenses.categoryId,
      totalCents: s.expenses.totalCents,
      expenseId: s.expenses.id,
    })
    .from(s.expenses)
    .innerJoin(s.projects, eq(s.projects.id, s.expenses.projectId))
    .innerJoin(s.expenseCategories, eq(s.expenseCategories.id, s.expenses.categoryId))
    .where(
      and(
        eq(s.projects.clientId, input.clientId),
        projectFilter,
        eq(s.expenses.isBillable, true),
        isNull(s.expenses.invoiceId),
        eq(s.expenses.billedExternally, false),
        isNull(s.expenses.deletedAt),
        input.from ? sql`${s.expenses.spentOn} >= ${input.from}` : sql`true`,
        input.to ? sql`${s.expenses.spentOn} <= ${input.to}` : sql`true`
      )
    );

  for (const x of expenses) {
    const key = `expense:${x.projectId}:${x.categoryId}`;
    const bucket = buckets.get(key) ?? {
      key,
      projectId: x.projectId,
      kind: "expense" as const,
      label: x.projectName,
      sublabel: x.categoryName,
      quantity: 0,
      unitPriceCents: 0,
      amountCents: 0,
      timeEntryIds: [],
      expenseIds: [],
    };
    bucket.quantity += 1;
    bucket.amountCents += x.totalCents;
    bucket.unitPriceCents = Math.round(bucket.amountCents / Math.max(1, bucket.quantity));
    bucket.expenseIds.push(x.expenseId);
    buckets.set(key, bucket);
  }

  return [...buckets.values()]
    .map((l) => ({ ...l, quantity: Math.round(l.quantity * 100) / 100 }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.sublabel.localeCompare(b.sublabel));
}

/* ------------------------------------------------------------------ create */

export interface InvoiceInput {
  clientId: string;
  subject?: string | null;
  notes?: string | null;
  poNumber?: string | null;
  issueDate: IsoDate;
  dueDate: IsoDate;
  taxPercent?: number | null;
  discountPercent?: number | null;
  number?: string;
  lines: {
    id?: string;
    projectId?: string | null;
    description: string;
    quantity: number;
    unitPriceCents: number;
    isTaxed?: boolean;
    itemType?: string;
  }[];
  projectIds?: string[];
  timeEntryIds?: string[];
  expenseIds?: string[];
}

/**
 * Draws the next invoice number.
 *
 * `FOR UPDATE` on the settings row, inside the creating transaction: two
 * concurrent creates would otherwise read the same sequence value and produce
 * two invoices with the same number, which the unique index would then reject
 * as a 500 rather than as anything a person could act on.
 */
async function nextNumber(ctx: Ctx, clientId: string, issueDate: IsoDate): Promise<string> {
  await lockNamed(ctx, "invoice-number");

  const rows = await ctx.db.execute<{ pattern: string; seq: number }>(sql`
    SELECT invoice_number_pattern AS pattern, invoice_next_seq AS seq
    FROM settings WHERE id = 1 FOR UPDATE
  `);
  const row = (rows as unknown as { pattern: string; seq: number }[])[0];
  if (!row) throw notFound("Account settings");

  const [client] = await ctx.db
    .select({ name: s.clients.name, prefix: s.clients.invoicePrefix })
    .from(s.clients)
    .where(eq(s.clients.id, clientId))
    .limit(1);

  const number = renderInvoiceNumber(row.pattern, {
    seq: row.seq,
    issueDate,
    clientCode: client ? clientCodeFrom(client.name) : null,
    clientPrefix: client?.prefix ?? null,
  });

  await ctx.db.execute(sql`UPDATE settings SET invoice_next_seq = invoice_next_seq + 1 WHERE id = 1`);
  return number;
}

export async function createInvoice(ctx: Ctx, input: InvoiceInput): Promise<InvoiceDetail> {
  assertCan(ctx, "invoice:manage");

  if (input.dueDate < input.issueDate) {
    throw validationFailed({ dueDate: ["The due date is before the issue date."] });
  }

  return withTransaction(ctx, async (tx) => {
    const [client] = await tx.db
      .select({ id: s.clients.id, currency: s.clients.currency })
      .from(s.clients)
      .where(eq(s.clients.id, input.clientId))
      .limit(1);
    if (!client) throw validationFailed({ clientId: ["That client does not exist."] });

    const id = newId();
    const number = input.number?.trim() || (await nextNumber(tx, input.clientId, input.issueDate));

    const lines = input.lines.map((l, i) => ({
      id: newId(),
      invoiceId: id,
      position: i,
      projectId: l.projectId ?? null,
      description: l.description,
      quantity: String(l.quantity),
      unitPriceCents: l.unitPriceCents,
      amountCents: lineAmount(l.quantity, l.unitPriceCents),
      isTaxed: l.isTaxed ?? true,
    }));

    const totals = computeInvoiceTotals(
      lines.map((l) => ({
        quantity: Number(l.quantity),
        unitPriceCents: l.unitPriceCents,
        amountCents: l.amountCents,
        isTaxed: l.isTaxed,
        isTaxed2: false,
      })),
      { taxPercent: input.taxPercent, discountPercent: input.discountPercent }
    );

    await tx.db.insert(s.invoices).values({
      id,
      clientId: input.clientId,
      number,
      subject: input.subject?.trim() || null,
      notes: input.notes?.trim() || null,
      poNumber: input.poNumber?.trim() || null,
      currency: client.currency,
      issueDate: input.issueDate,
      dueDate: input.dueDate,
      state: "draft",
      subtotalCents: totals.subtotalCents,
      discountPercent: input.discountPercent == null ? null : String(input.discountPercent),
      discountCents: totals.discountCents,
      taxPercent: input.taxPercent == null ? null : String(input.taxPercent),
      taxCents: totals.taxCents,
      totalCents: totals.totalCents,
      createdBy: tx.actor.userId,
      updatedBy: tx.actor.userId,
    });

    if (lines.length) await tx.db.insert(s.invoiceLineItems).values(lines);

    const projectIds = new Set([
      ...(input.projectIds ?? []),
      ...lines.map((l) => l.projectId).filter((p): p is string => Boolean(p)),
    ]);
    if (projectIds.size) {
      await tx.db
        .insert(s.invoiceProjects)
        .values([...projectIds].map((projectId) => ({ invoiceId: id, projectId })))
        .onConflictDoNothing();
    }

    // Claim the underlying work. This is what stops the same hour being billed
    // twice, and it is why deleting a draft has to release it again.
    await attachRecords(tx, id, input.timeEntryIds ?? [], input.expenseIds ?? []);

    tx.audit({
      action: "invoice.create",
      entityType: "invoice",
      entityId: id,
      entityLabel: number,
      after: { number, totalCents: totals.totalCents, clientId: input.clientId },
    });
    tx.emit({ topic: "invoice.created", payload: { invoiceId: id, clientId: input.clientId } });

    return getInvoice(tx, id);
  });
}

async function attachRecords(ctx: Ctx, invoiceId: string, timeEntryIds: string[], expenseIds: string[]) {
  if (timeEntryIds.length) {
    // Only claim what is genuinely unclaimed: a concurrent invoice may have
    // taken some of these between the preview and the create.
    const claimed = await ctx.db
      .update(s.timeEntries)
      .set({ invoiceId })
      .where(and(inArray(s.timeEntries.id, timeEntryIds), isNull(s.timeEntries.invoiceId)))
      .returning({ id: s.timeEntries.id });

    if (claimed.length !== timeEntryIds.length) {
      throw new AppError(
        "attached_entries_changed",
        "Some of that time was invoiced while this draft was being prepared. Regenerate the lines.",
        { meta: { requested: timeEntryIds.length, claimed: claimed.length } }
      );
    }
  }

  if (expenseIds.length) {
    const claimed = await ctx.db
      .update(s.expenses)
      .set({ invoiceId })
      .where(and(inArray(s.expenses.id, expenseIds), isNull(s.expenses.invoiceId)))
      .returning({ id: s.expenses.id });

    if (claimed.length !== expenseIds.length) {
      throw new AppError(
        "attached_entries_changed",
        "Some of those expenses were invoiced while this draft was being prepared. Regenerate the lines.",
        { meta: { requested: expenseIds.length, claimed: claimed.length } }
      );
    }
  }
}

/* ------------------------------------------------------------------ update */

export async function updateInvoice(
  ctx: Ctx,
  id: string,
  input: Partial<Omit<InvoiceInput, "clientId">>
): Promise<InvoiceDetail> {
  assertCan(ctx, "invoice:manage");

  return withTransaction(ctx, async (tx) => {
    const [before] = await tx.db
      .select()
      .from(s.invoices)
      .where(and(eq(s.invoices.id, id), isNull(s.invoices.deletedAt), invoiceScope(tx)))
      .limit(1);
    if (!before) throw notFound("That invoice");

    if (!canTransition(before.state as InvoiceState, "edit")) {
      throw new AppError("invoice_state_invalid", `A ${before.state} invoice cannot be edited.`);
    }

    const patch: Record<string, unknown> = { updatedAt: tx.now(), updatedBy: tx.actor.userId };
    if (input.subject !== undefined) patch.subject = input.subject?.trim() || null;
    if (input.notes !== undefined) patch.notes = input.notes?.trim() || null;
    if (input.poNumber !== undefined) patch.poNumber = input.poNumber?.trim() || null;
    if (input.issueDate !== undefined) patch.issueDate = input.issueDate;
    if (input.dueDate !== undefined) patch.dueDate = input.dueDate;
    if (input.number !== undefined) patch.number = input.number.trim();

    const issueDate = (input.issueDate ?? before.issueDate) as IsoDate;
    const dueDate = (input.dueDate ?? before.dueDate) as IsoDate;
    if (dueDate < issueDate) throw validationFailed({ dueDate: ["The due date is before the issue date."] });

    // Replacing the lines means recomputing every stored intermediate.
    if (input.lines) {
      await tx.db.delete(s.invoiceLineItems).where(eq(s.invoiceLineItems.invoiceId, id));

      const lines = input.lines.map((l, i) => ({
        id: newId(),
        invoiceId: id,
        position: i,
        projectId: l.projectId ?? null,
        description: l.description,
        quantity: String(l.quantity),
        unitPriceCents: l.unitPriceCents,
        amountCents: lineAmount(l.quantity, l.unitPriceCents),
        isTaxed: l.isTaxed ?? true,
      }));
      if (lines.length) await tx.db.insert(s.invoiceLineItems).values(lines);

      const taxPercent = input.taxPercent ?? numberOrNull(before.taxPercent);
      const discountPercent = input.discountPercent ?? numberOrNull(before.discountPercent);

      const totals = computeInvoiceTotals(
        lines.map((l) => ({
          quantity: Number(l.quantity),
          unitPriceCents: l.unitPriceCents,
          amountCents: l.amountCents,
          isTaxed: l.isTaxed,
          isTaxed2: false,
        })),
        { taxPercent, discountPercent }
      );

      patch.subtotalCents = totals.subtotalCents;
      patch.discountCents = totals.discountCents;
      patch.taxCents = totals.taxCents;
      patch.totalCents = totals.totalCents;
      patch.taxPercent = taxPercent == null ? null : String(taxPercent);
      patch.discountPercent = discountPercent == null ? null : String(discountPercent);
    }

    // Editing a sent invoice rotates the pay token: the old link showed
    // different numbers, and it should stop working.
    if (before.state !== "draft") {
      patch.payToken = randomToken(24);
      tx.audit({
        action: "invoice.edit_after_send",
        entityType: "invoice",
        entityId: id,
        entityLabel: before.number,
        before,
      });
    }

    await tx.db.update(s.invoices).set(patch as never).where(eq(s.invoices.id, id));

    const after = await getInvoice(tx, id);
    tx.audit({ action: "invoice.update", entityType: "invoice", entityId: id, entityLabel: before.number, before, after });

    return after;
  });
}

const numberOrNull = (v: string | null) => (v == null ? null : Number(v));

/* ------------------------------------------------------------ state machine */

export async function markSent(ctx: Ctx, id: string): Promise<InvoiceDetail> {
  assertCan(ctx, "invoice:send");

  return withTransaction(ctx, async (tx) => {
    const [before] = await tx.db
      .select()
      .from(s.invoices)
      .where(and(eq(s.invoices.id, id), isNull(s.invoices.deletedAt), invoiceScope(tx)))
      .limit(1);
    if (!before) throw notFound("That invoice");

    if (!canTransition(before.state as InvoiceState, "mark_sent")) {
      throw new AppError("invoice_state_invalid", `A ${before.state} invoice has already been sent.`);
    }

    const sentAt = tx.now();

    await tx.db
      .update(s.invoices)
      .set({
        state: "open",
        sentAt,
        payToken: before.payToken ?? randomToken(24),
        updatedAt: sentAt,
        updatedBy: tx.actor.userId,
      })
      .where(eq(s.invoices.id, id));

    // Lock the rate snapshots on everything attached. The client has now been
    // told a number, and a later re-rate must not move it.
    await tx.db
      .update(s.timeEntries)
      .set({ ratesLockedAt: sentAt })
      .where(eq(s.timeEntries.invoiceId, id));
    await tx.db
      .update(s.expenses)
      .set({ ratesLockedAt: sentAt })
      .where(eq(s.expenses.invoiceId, id));

    await drawRetainer(tx, id, before.clientId);

    tx.audit({ action: "invoice.send", entityType: "invoice", entityId: id, entityLabel: before.number, before });
    tx.emit({ topic: "invoice.sent", payload: { invoiceId: id, clientId: before.clientId } });

    return getInvoice(tx, id);
  });
}

/**
 * Records the email that would have gone out.
 *
 * With no SMTP transport configured the row is written with
 * `delivery_state = 'not_configured'` rather than being skipped, so the
 * timeline is honest about what happened instead of implying a delivery that
 * never occurred.
 */
export async function recordMessage(
  ctx: Ctx,
  id: string,
  kind: "invoice" | "reminder" | "thank_you",
  recipients: { to: string[]; cc?: string[]; bcc?: string[] },
  subject?: string,
  bodyText?: string
) {
  assertCan(ctx, "invoice:send");
  const { env } = await import("@/server/env");

  await ctx.db.insert(s.invoiceMessages).values({
    id: newId(),
    invoiceId: id,
    kind,
    subject: subject ?? null,
    body: bodyText ?? null,
    recipients,
    sentBy: ctx.actor.userId,
    deliveryState: env.smtp ? "queued" : "not_configured",
  });

  ctx.audit({ action: `invoice.${kind}`, entityType: "invoice", entityId: id, after: { recipients } });
  return { delivered: Boolean(env.smtp) };
}

export async function writeOff(ctx: Ctx, id: string): Promise<InvoiceDetail> {
  assertCan(ctx, "invoice:manage");

  return withTransaction(ctx, async (tx) => {
    const [before] = await tx.db
      .select()
      .from(s.invoices)
      .where(and(eq(s.invoices.id, id), isNull(s.invoices.deletedAt), invoiceScope(tx)))
      .limit(1);
    if (!before) throw notFound("That invoice");

    if (!canTransition(before.state as InvoiceState, "write_off")) {
      throw new AppError("invoice_state_invalid", `A ${before.state} invoice cannot be written off.`);
    }

    await tx.db
      .update(s.invoices)
      .set({ state: "written_off", closedAt: tx.now(), updatedAt: tx.now(), updatedBy: tx.actor.userId })
      .where(eq(s.invoices.id, id));

    // Entries stay attached and locked, so the work is not billed again by
    // accident. Any retainer draw is given back.
    await reverseRetainerDraw(tx, id, before.clientId, before.retainerDrawCents, "written off");

    tx.audit({ action: "invoice.write_off", entityType: "invoice", entityId: id, entityLabel: before.number, before });
    return getInvoice(tx, id);
  });
}

export async function closeInvoice(ctx: Ctx, id: string): Promise<InvoiceDetail> {
  assertCan(ctx, "invoice:manage");

  return withTransaction(ctx, async (tx) => {
    const [before] = await tx.db
      .select()
      .from(s.invoices)
      .where(and(eq(s.invoices.id, id), isNull(s.invoices.deletedAt), invoiceScope(tx)))
      .limit(1);
    if (!before) throw notFound("That invoice");

    if (!canTransition(before.state as InvoiceState, "close")) {
      throw new AppError("invoice_state_invalid", `A ${before.state} invoice cannot be closed.`);
    }

    await tx.db
      .update(s.invoices)
      .set({ state: "closed", closedAt: tx.now(), updatedAt: tx.now(), updatedBy: tx.actor.userId })
      .where(eq(s.invoices.id, id));

    tx.audit({ action: "invoice.close", entityType: "invoice", entityId: id, entityLabel: before.number, before });
    return getInvoice(tx, id);
  });
}

export async function deleteInvoice(ctx: Ctx, id: string): Promise<void> {
  assertCan(ctx, "invoice:delete");

  await withTransaction(ctx, async (tx) => {
    const [before] = await tx.db
      .select()
      .from(s.invoices)
      .where(and(eq(s.invoices.id, id), isNull(s.invoices.deletedAt), invoiceScope(tx)))
      .limit(1);
    if (!before) throw notFound("That invoice");

    const isAdministrator = tx.actor.baseKey === "administrator" || tx.actor.kind === "system";
    if (!canDelete(before.state as InvoiceState, isAdministrator)) {
      throw new AppError(
        "invoice_state_invalid",
        "Only a draft can be deleted. Write the invoice off instead, so the work is not billed again."
      );
    }

    // Release the work, so it becomes uninvoiced rather than vanishing.
    await tx.db
      .update(s.timeEntries)
      .set({ invoiceId: null, ratesLockedAt: null })
      .where(eq(s.timeEntries.invoiceId, id));
    await tx.db
      .update(s.expenses)
      .set({ invoiceId: null, ratesLockedAt: null })
      .where(eq(s.expenses.invoiceId, id));

    await reverseRetainerDraw(tx, id, before.clientId, before.retainerDrawCents, "invoice deleted");

    await tx.db
      .update(s.invoices)
      .set({ deletedAt: tx.now(), updatedBy: tx.actor.userId })
      .where(eq(s.invoices.id, id));

    // The whole invoice goes into `before`, because after this the row is gone
    // from every view and the audit log is the only record of what it said.
    tx.audit({
      action: "invoice.delete",
      entityType: "invoice",
      entityId: id,
      entityLabel: before.number,
      before,
    });
  });
}

/* ---------------------------------------------------------------- payments */

export async function recordPayment(
  ctx: Ctx,
  id: string,
  input: { amountCents: number; paidAt: string; method?: string | null; reference?: string | null; notes?: string | null }
): Promise<InvoiceDetail> {
  assertCan(ctx, "invoice:manage");
  if (input.amountCents <= 0) throw validationFailed({ amountCents: ["A payment has to be more than nothing."] });

  return withTransaction(ctx, async (tx) => {
    const [before] = await tx.db
      .select()
      .from(s.invoices)
      .where(and(eq(s.invoices.id, id), isNull(s.invoices.deletedAt), invoiceScope(tx)))
      .limit(1);
    if (!before) throw notFound("That invoice");

    if (!canTransition(before.state as InvoiceState, "record_payment")) {
      throw new AppError(
        "invoice_state_invalid",
        before.state === "draft"
          ? "Send the invoice before recording a payment against it."
          : `A ${before.state} invoice cannot take a payment.`
      );
    }

    await tx.db.insert(s.invoicePayments).values({
      id: newId(),
      invoiceId: id,
      amountCents: input.amountCents,
      paidAt: new Date(input.paidAt),
      method: input.method ?? null,
      reference: input.reference ?? null,
      notes: input.notes ?? null,
      recordedBy: tx.actor.userId,
    });

    // Recomputed from the rows rather than incremented, so a voided payment and
    // a new one cannot drift the stored total away from the ledger.
    const paidCents = await sumPayments(tx, id);
    const state = stateAfterPayment(before.totalCents, paidCents, before.state as InvoiceState);

    await tx.db
      .update(s.invoices)
      .set({
        paidCents,
        state,
        paidAt: state === "paid" ? new Date(input.paidAt) : null,
        updatedAt: tx.now(),
        updatedBy: tx.actor.userId,
      })
      .where(eq(s.invoices.id, id));

    tx.audit({
      action: "invoice.payment",
      entityType: "invoice",
      entityId: id,
      entityLabel: before.number,
      after: { amountCents: input.amountCents, paidCents, state },
    });
    tx.emit({ topic: "invoice.paid", payload: { invoiceId: id, paidCents, state } });

    return getInvoice(tx, id);
  });
}

export async function voidPayment(ctx: Ctx, invoiceId: string, paymentId: string): Promise<InvoiceDetail> {
  assertCan(ctx, "invoice:manage");

  return withTransaction(ctx, async (tx) => {
    const [invoice] = await tx.db
      .select()
      .from(s.invoices)
      .where(and(eq(s.invoices.id, invoiceId), isNull(s.invoices.deletedAt), invoiceScope(tx)))
      .limit(1);
    if (!invoice) throw notFound("That invoice");

    const [payment] = await tx.db
      .select()
      .from(s.invoicePayments)
      .where(and(eq(s.invoicePayments.id, paymentId), eq(s.invoicePayments.invoiceId, invoiceId)))
      .limit(1);
    if (!payment) throw notFound("That payment");
    if (payment.voidedAt) throw new AppError("conflict", "That payment has already been voided.");

    await tx.db
      .update(s.invoicePayments)
      .set({ voidedAt: tx.now(), voidedBy: tx.actor.userId })
      .where(eq(s.invoicePayments.id, paymentId));

    const paidCents = await sumPayments(tx, invoiceId);
    // Voiding can move an invoice back from paid to open, which is the whole
    // point of storing payments as rows rather than as a running total.
    const state = invoice.state === "paid" && paidCents < invoice.totalCents ? "open" : invoice.state;

    await tx.db
      .update(s.invoices)
      .set({
        paidCents,
        state,
        paidAt: state === "paid" ? invoice.paidAt : null,
        updatedAt: tx.now(),
        updatedBy: tx.actor.userId,
      })
      .where(eq(s.invoices.id, invoiceId));

    tx.audit({
      action: "invoice.payment.void",
      entityType: "invoice",
      entityId: invoiceId,
      entityLabel: invoice.number,
      before: payment,
      after: { paidCents, state },
    });

    return getInvoice(tx, invoiceId);
  });
}

async function sumPayments(ctx: Ctx, invoiceId: string): Promise<number> {
  const rows = await ctx.db.execute<{ total: string }>(sql`
    SELECT COALESCE(SUM(amount_cents), 0)::text AS total
    FROM invoice_payments
    WHERE invoice_id = ${invoiceId} AND voided_at IS NULL
  `);
  return Number((rows as unknown as { total: string }[])[0]?.total ?? 0);
}

/* --------------------------------------------------------------- retainers */

/**
 * Draws against a retainer at send time, never on a draft.
 *
 * A draft is a proposal; drawing on one would reduce a balance for an invoice
 * that might never be sent.
 */
async function drawRetainer(ctx: Ctx, invoiceId: string, clientId: string) {
  const [retainer] = await ctx.db
    .select()
    .from(s.retainers)
    .where(and(eq(s.retainers.clientId, clientId), isNull(s.retainers.projectId), isNull(s.retainers.archivedAt)))
    .limit(1);

  if (!retainer || retainer.balanceCents <= 0) return;

  const [invoice] = await ctx.db
    .select({ totalCents: s.invoices.totalCents })
    .from(s.invoices)
    .where(eq(s.invoices.id, invoiceId))
    .limit(1);
  if (!invoice) return;

  const draw = Math.min(retainer.balanceCents, invoice.totalCents);
  if (draw <= 0) return;

  const balanceAfter = retainer.balanceCents - draw;

  await ctx.db.insert(s.retainerTransactions).values({
    id: newId(),
    retainerId: retainer.id,
    kind: "draw",
    amountCents: draw,
    balanceAfterCents: balanceAfter,
    invoiceId,
    note: "Applied to invoice",
    createdBy: ctx.actor.userId,
  });

  await ctx.db.update(s.retainers).set({ balanceCents: balanceAfter }).where(eq(s.retainers.id, retainer.id));
  await ctx.db.update(s.invoices).set({ retainerDrawCents: draw }).where(eq(s.invoices.id, invoiceId));

  ctx.audit({
    action: "retainer.draw",
    entityType: "retainer",
    entityId: retainer.id,
    after: { invoiceId, amountCents: draw, balanceAfter },
  });
}

/**
 * Gives a draw back, as a compensating transaction rather than by deleting the
 * original. Both movements stay on the ledger, which is what makes a retainer
 * balance auditable.
 */
async function reverseRetainerDraw(
  ctx: Ctx,
  invoiceId: string,
  clientId: string,
  drawCents: number,
  reason: string
) {
  if (drawCents <= 0) return;

  const [retainer] = await ctx.db
    .select()
    .from(s.retainers)
    .where(and(eq(s.retainers.clientId, clientId), isNull(s.retainers.projectId)))
    .limit(1);
  if (!retainer) return;

  const balanceAfter = retainer.balanceCents + drawCents;

  await ctx.db.insert(s.retainerTransactions).values({
    id: newId(),
    retainerId: retainer.id,
    kind: "adjust",
    amountCents: drawCents,
    balanceAfterCents: balanceAfter,
    invoiceId,
    note: `Draw reversed: ${reason}`,
    createdBy: ctx.actor.userId,
  });

  await ctx.db.update(s.retainers).set({ balanceCents: balanceAfter }).where(eq(s.retainers.id, retainer.id));
  await ctx.db.update(s.invoices).set({ retainerDrawCents: 0 }).where(eq(s.invoices.id, invoiceId));
}

/* --------------------------------------------------- recurring and retainers */

export async function listRecurring(ctx: Ctx) {
  assertCan(ctx, "invoice:view");
  const rows = await ctx.db
    .select()
    .from(s.recurringInvoices)
    .orderBy(asc(s.recurringInvoices.nextIssueOn));

  return rows.map((r) => ({
    id: r.id,
    clientId: r.clientId,
    subject: r.subject,
    frequency: r.frequency,
    interval: r.interval,
    nextIssueOn: r.nextIssueOn,
    state: r.state,
    amountCents: Number((r.template as { amountCents?: number })?.amountCents ?? 0),
    sendAutomatically: r.sendAutomatically,
  }));
}

export async function listRetainers(ctx: Ctx) {
  assertCan(ctx, "invoice:view");

  const rows = await ctx.db
    .select()
    .from(s.retainers)
    .where(isNull(s.retainers.archivedAt))
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

  return rows.map((r) => ({
    id: r.id,
    clientId: r.clientId,
    projectId: r.projectId,
    balanceCents: r.balanceCents,
    transactions: (byRetainer.get(r.id) ?? []).map((t) => ({
      id: t.id,
      kind: t.kind,
      amountCents: t.amountCents,
      balanceAfterCents: t.balanceAfterCents,
      invoiceId: t.invoiceId,
      note: t.note,
      at: t.occurredAt.toISOString(),
    })),
  }));
}

export async function addRetainerTransaction(
  ctx: Ctx,
  retainerId: string,
  input: { kind: "add" | "draw" | "adjust"; amountCents: number; note?: string | null }
) {
  assertCan(ctx, "invoice:manage");
  if (input.amountCents <= 0) throw validationFailed({ amountCents: ["An amount is required."] });

  return withTransaction(ctx, async (tx) => {
    const [retainer] = await tx.db.select().from(s.retainers).where(eq(s.retainers.id, retainerId)).limit(1);
    if (!retainer) throw notFound("That retainer");

    const delta = input.kind === "draw" ? -input.amountCents : input.amountCents;
    const balanceAfter = retainer.balanceCents + delta;

    if (balanceAfter < 0) {
      throw new AppError("retainer_insufficient", "That draw is more than the retainer holds.", {
        meta: { balanceCents: retainer.balanceCents, requested: input.amountCents },
      });
    }

    await tx.db.insert(s.retainerTransactions).values({
      id: newId(),
      retainerId,
      kind: input.kind,
      amountCents: input.amountCents,
      balanceAfterCents: balanceAfter,
      note: input.note ?? null,
      createdBy: tx.actor.userId,
    });

    await tx.db.update(s.retainers).set({ balanceCents: balanceAfter }).where(eq(s.retainers.id, retainerId));

    tx.audit({
      action: `retainer.${input.kind}`,
      entityType: "retainer",
      entityId: retainerId,
      after: { amountCents: input.amountCents, balanceAfter },
    });

    return { id: retainerId, balanceCents: balanceAfter };
  });
}
