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

import { and, asc, desc, eq, exists, inArray, isNull, sql } from "drizzle-orm";
import { assertCan, lockNamed, runAfterCommit, withTransaction, type Ctx } from "@/server/ctx";
import * as s from "@/server/db/schema";
import { newId, randomToken } from "@/server/db/ids";
import { invoiceScope } from "@/server/auth/scope";
import { AppError, notFound, validationFailed } from "@/server/errors";
import { serializeInvoice, type InvoiceDto } from "@/server/serialize";
import { computeInvoiceTotals, lineAmount } from "@/domain/money";
import {
  canDelete, canTransition, clientCodeFrom, displayState, renderInvoiceNumber,
  stateAfterPayment, type InvoiceState,
} from "@/domain/invoices";
import { dayIn, type IsoDate } from "@/domain/calendar";
import { roundGroup } from "@/domain/rounding";
import { getSettings, invalidateSettings, roundingRule } from "./settings";
import { queueMail } from "./mail";
import { renderLabel, resolveMessages } from "@/domain/invoice-config";
import { formatMoney } from "@/lib/format";
import { resolveDefaults } from "@/domain/invoice-config";
import { defaultItemTypeId } from "./item-types";
import { ledgerDelta, moveBalance } from "./retainers";

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
    itemType: string | null;
    isTime: boolean;
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

export const LIST_LIMIT = 1000;

export async function listInvoices(
  ctx: Ctx,
  opts: { state?: string; clientId?: string; limit?: number } = {}
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
    .limit(opts.limit ?? LIST_LIMIT);

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
      .select({
        id: s.invoiceLineItems.id,
        position: s.invoiceLineItems.position,
        projectId: s.invoiceLineItems.projectId,
        description: s.invoiceLineItems.description,
        quantity: s.invoiceLineItems.quantity,
        unitPriceCents: s.invoiceLineItems.unitPriceCents,
        amountCents: s.invoiceLineItems.amountCents,
        isTaxed: s.invoiceLineItems.isTaxed,
        // Left join: a line written before item types existed has none, and an
        // invoice from before this shipped still has to render.
        itemType: s.invoiceItemTypes.name,
        isService: s.invoiceItemTypes.isDefaultForServices,
      })
      .from(s.invoiceLineItems)
      .leftJoin(s.invoiceItemTypes, eq(s.invoiceItemTypes.id, s.invoiceLineItems.itemTypeId))
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
      itemType: l.itemType ?? null,
      // What "total hours" counts. An expense line's quantity is a count of
      // receipts, not a number of hours, so adding them together would put a
      // meaningless figure on the invoice.
      isTime: l.isService === true,
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
  /**
   * Hours that carry no billable rate, so this line values at nothing.
   *
   * `resolveRates` already decides this when an entry is written, and returns
   * `rateMissing` saying so, and nothing in the application has ever read it.
   * The consequence reached a client: every active project is billed by
   * project rate and not one of them has a rate set, so entries logged through
   * the UI snapshot zero, and the first anybody heard of it was an invoice
   * reading $0.00 with no explanation (t-Fg-4v7).
   *
   * Inferred here rather than read off the entry, because the entry stores the
   * resolved number and not the fact that resolution failed. Hours on a
   * billable line priced at zero is that fact: a genuinely free line is
   * non-billable or fixed-fee and never reaches this list.
   */
  rateMissing: boolean;
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

  // Cent-seconds, not cents. Dividing per entry and summing afterwards drifts
  // in one direction across thousands of rows, so the product is accumulated
  // and divided exactly once, at the end.
  const centSeconds = new Map<string, number>();
  const bucketSeconds = new Map<string, number[]>();
  const buckets = new Map<string, UninvoicedLine>();

  /**
   * The account rounding rule, applied per line and never per entry.
   *
   * BACKEND_PRD section 4.3: ten six-minute entries under fifteen-minute
   * rounding are 1.0 hours, not 2.5. Rounding each entry and summing inflates
   * every invoice, and inflates it most for whoever tracks most carefully,
   * which is the opposite of fair. `roundGroup` takes the whole group for
   * exactly this reason: calling it per entry is awkward on purpose.
   *
   * TALLY-28: before this, the setting existed, the summary reports read it,
   * and invoices did not.
   */
  const rounding = await roundingRule(ctx);

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
      // Decided in the final pass, once the group's hours are summed.
      rateMissing: false,
    };

    bucketSeconds.set(key, [...(bucketSeconds.get(key) ?? []), e.seconds]);
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
      // Decided in the final pass, once the group's hours are summed.
      rateMissing: false,
    };
    bucket.quantity += 1;
    bucket.amountCents += x.totalCents;
    bucket.expenseIds.push(x.expenseId);
    buckets.set(key, bucket);
  }

  for (const [key, bucket] of buckets) {
    if (bucket.kind === "time") {
      // Sum the group, round the total once, then value it at the group's rate.
      // Every entry in a bucket shares a rate by construction, which is what
      // makes the rounded total a legitimate thing to multiply.
      const seconds = roundGroup(bucketSeconds.get(key) ?? [], rounding);
      bucket.quantity = seconds / 3600;
      centSeconds.set(key, seconds * bucket.unitPriceCents);
      bucket.amountCents = Math.round((centSeconds.get(key) ?? 0) / 3600);
    }
    // The unit price is a display of the line, and the line's value is its
    // amount. Deriving the amount back from a rounded price is what put the
    // preview and the invoice a couple of dollars apart.
    bucket.unitPriceCents =
      bucket.kind === "expense"
        ? Math.round(bucket.amountCents / Math.max(1, bucket.quantity))
        : bucket.unitPriceCents;
  }

  return [...buckets.values()]
    .map((l) => ({
      ...l,
      quantity: Math.round(l.quantity * 100) / 100,
      rateMissing: l.kind === "time" && l.quantity > 0 && l.unitPriceCents === 0,
    }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.sublabel.localeCompare(b.sublabel));
}

export interface UninvoicedClient {
  clientId: string;
  clientName: string;
  currency: string;
  /** Billable hours not yet on an invoice, rounded for display only. */
  hours: number;
  timeCents: number;
  expenseCount: number;
  expenseCents: number;
  totalCents: number;
  /** The span the unbilled work covers, which is what a billing run wants to see. */
  from: IsoDate | null;
  to: IsoDate | null;
}

/**
 * Every client with work that has been done and not billed.
 *
 * The screen somebody opens at the start of a billing run. Until this existed
 * the value was computed in three places and browsable in none: the invoice
 * creation flow pulled it per client, the client page showed its own, and the
 * invoicing report knew the total. The one question nobody could ask was "what
 * have we done that we have not billed for".
 *
 * THE ROUNDING, WHICH IS THE ENTIRE DIFFICULTY
 *
 * This total must equal what the invoice for that client would come to, or the
 * screen is worse than not having it. So the grouping here mirrors
 * `previewLines` exactly: `ROUND` is applied per project and rate, because that
 * is one invoice line, and the line amounts are then summed.
 *
 * Rounding once over the whole client instead would be defensible arithmetic
 * and the wrong answer: the invoice is a sum of rounded lines, so the rounded
 * sum can differ from it by up to half a cent per line. `tests/uninvoiced.test.ts`
 * asserts the equality against `previewLines` directly rather than trusting
 * that these two queries stay in step, because they are in different languages
 * and only a test can hold them together.
 *
 * (Postgres `ROUND` on a numeric rounds half away from zero and JavaScript
 * `Math.round` rounds half up. Rates and durations are never negative, so on
 * this data they are the same function.)
 */
export async function listUninvoiced(ctx: Ctx): Promise<UninvoicedClient[]> {
  assertCan(ctx, "invoice:view");

  /**
   * The same rounding `previewLines` applies, in SQL.
   *
   * It has to be here too or this screen quotes an unrounded figure and the
   * invoice raised from it comes to something else, which is the one bug this
   * screen cannot have. Rounding is per bucket in both places, and a bucket is
   * one project at one rate, which is one invoice line.
   *
   * `mode` is interpolated as a function name rather than a value, so it is
   * whitelisted rather than passed through: `roundingRule` can only return one
   * of three modes, and the switch makes that structural.
   */
  const rounding = await roundingRule(ctx);
  const increment = rounding.minutes > 0 ? rounding.minutes * 60 : 0;
  const roundFn =
    rounding.mode === "up" ? "CEIL" : rounding.mode === "down" ? "FLOOR" : "ROUND";

  const roundedSeconds = increment
    ? sql.raw(`${roundFn}(SUM(te.duration_seconds)::numeric / ${increment}) * ${increment}`)
    : sql.raw("SUM(te.duration_seconds)::numeric");

  const timeRows = await ctx.db.execute<{
    client_id: string;
    seconds: string;
    cents: string;
    first_day: string | null;
    last_day: string | null;
  }>(sql`
    SELECT client_id,
           SUM(seconds)::text        AS seconds,
           SUM(bucket_cents)::text   AS cents,
           MIN(first_day)::text      AS first_day,
           MAX(last_day)::text       AS last_day
    FROM (
      SELECT p.client_id,
             ${roundedSeconds}::bigint AS seconds,
             ROUND(${roundedSeconds} * te.billable_rate_cents / 3600) AS bucket_cents,
             MIN(te.spent_on) AS first_day,
             MAX(te.spent_on) AS last_day
        FROM time_entries te
        JOIN projects p ON p.id = te.project_id
       WHERE te.is_billable
         AND te.invoice_id IS NULL
         AND NOT te.billed_externally
         AND te.deleted_at IS NULL
         AND te.timer_started_at IS NULL
       -- One bucket is one invoice line: same project, same rate.
       GROUP BY p.client_id, te.project_id, te.billable_rate_cents
    ) buckets
    GROUP BY client_id
  `);

  const expenseRows = await ctx.db.execute<{
    client_id: string;
    count: string;
    cents: string;
    first_day: string | null;
    last_day: string | null;
  }>(sql`
    SELECT p.client_id,
           COUNT(*)::text            AS count,
           SUM(x.total_cents)::text  AS cents,
           MIN(x.spent_on)::text     AS first_day,
           MAX(x.spent_on)::text     AS last_day
      FROM expenses x
      JOIN projects p ON p.id = x.project_id
     WHERE x.is_billable
       AND x.invoice_id IS NULL
       AND NOT x.billed_externally
       AND x.deleted_at IS NULL
     GROUP BY p.client_id
  `);

  const clientIds = [
    ...new Set([...timeRows.map((r) => r.client_id), ...expenseRows.map((r) => r.client_id)]),
  ];
  if (!clientIds.length) return [];

  const clients = await ctx.db
    .select({ id: s.clients.id, name: s.clients.name, currency: s.clients.currency })
    .from(s.clients)
    // Archived clients are not filtered out. Work that was done and not billed
    // is still owed whether or not the client is still active, and `previewLines`
    // does not filter them either, which is the point: these two must agree.
    .where(inArray(s.clients.id, clientIds));

  const time = new Map(timeRows.map((r) => [r.client_id, r]));
  const expense = new Map(expenseRows.map((r) => [r.client_id, r]));
  const earlier = (a: string | null, b: string | null) => (a && b ? (a < b ? a : b) : (a ?? b));
  const later = (a: string | null, b: string | null) => (a && b ? (a > b ? a : b) : (a ?? b));

  return clients
    .map((c) => {
      const t = time.get(c.id);
      const x = expense.get(c.id);
      const timeCents = Number(t?.cents ?? 0);
      const expenseCents = Number(x?.cents ?? 0);
      return {
        clientId: c.id,
        clientName: c.name,
        currency: c.currency,
        hours: Math.round((Number(t?.seconds ?? 0) / 3600) * 100) / 100,
        timeCents,
        expenseCount: Number(x?.count ?? 0),
        expenseCents,
        totalCents: timeCents + expenseCents,
        from: (earlier(t?.first_day ?? null, x?.first_day ?? null) as IsoDate | null) ?? null,
        to: (later(t?.last_day ?? null, x?.last_day ?? null) as IsoDate | null) ?? null,
      };
    })
    .filter((r) => r.totalCents !== 0 || r.hours !== 0 || r.expenseCount !== 0)
    .sort((a, b) => b.totalCents - a.totalCents || a.clientName.localeCompare(b.clientName));
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
    /**
     * The line's value, when the caller knows it exactly.
     *
     * A time line is worth `sum(seconds x rate) / 3600`, which is not
     * `hours x rate` once the hours have been rounded for display. When this is
     * present it is authoritative and `quantity x unitPrice` is only a label.
     */
    amountCents?: number;
    isTaxed?: boolean;
    /**
     * What the line is, which decides its item type when none is given.
     *
     * `previewLines` already knows: it produces time buckets and expense
     * buckets separately. Passing the kind rather than an id keeps callers out
     * of the business of looking up which type currently holds a default role.
     */
    kind?: "time" | "expense";
    itemTypeId?: string;
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

  /*
    This is the third writer of the settings row, and the only one that used to
    say nothing about it.

    Both halves matter. `settingsWritten` stops *this* transaction reading a
    cached row whose `invoice_next_seq` it has just moved, and the invalidation
    stops every later reader doing the same. Without them, a numbering PATCH
    landing within the cache TTL reads a stale sequence as its `before`, and
    `assertSequenceIsFree` then compares the requested number against a value
    already drawn and lets it through. The counter goes back onto a number that
    exists, and the next invoice for that client collides on the unique index,
    which is the 500 this function's own docstring exists to prevent.

    `tests/settings-writers.test.ts` now fails on any settings write that omits
    either, because a rule about three call sites is a rule that grows a fourth.
  */
  ctx._buffers.settingsWritten = true;
  runAfterCommit(ctx, invalidateSettings);

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

    const [serviceTypeId, expenseTypeId] = await Promise.all([
      defaultItemTypeId(tx, "service"),
      defaultItemTypeId(tx, "expense"),
    ]);

    const lines = input.lines.map((l, i) => ({
      id: newId(),
      invoiceId: id,
      position: i,
      // TALLY-30: every line carries a type. Before this they were all null,
      // pointing at a table with no rows in it.
      itemTypeId: l.itemTypeId ?? (l.kind === "expense" ? expenseTypeId : serviceTypeId),
      projectId: l.projectId ?? null,
      description: l.description,
      quantity: String(l.quantity),
      unitPriceCents: l.unitPriceCents,
      amountCents: l.amountCents ?? lineAmount(l.quantity, l.unitPriceCents),
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

    /**
     * The configured defaults, applied only where the caller said nothing.
     *
     * A default is a fallback, not an override: passing an empty subject
     * deliberately has to stay empty, so the test is `undefined`, not falsy.
     * And this reaches new invoices only. Changing the default subject must
     * never rewrite one on a draft somebody already edited, which is why it is
     * here in create rather than anywhere near update.
     *
     * TALLY-33: this section ships with its consumer. `invoiceDefaults` was
     * stored and read by nothing before this.
     */
    const defaults = resolveDefaults((await getSettings(tx)).invoiceDefaults);

    await tx.db.insert(s.invoices).values({
      id,
      clientId: input.clientId,
      number,
      subject: (input.subject === undefined ? defaults.subject : input.subject)?.trim() || null,
      notes: (input.notes === undefined ? defaults.notes : input.notes)?.trim() || null,
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
    await attachRecords(tx, id, input.clientId, input.timeEntryIds ?? [], input.expenseIds ?? []);

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

/**
 * Claims time and expenses for an invoice.
 *
 * Two guarantees, and both matter. The records must be *claimable*: unclaimed,
 * billable, not billed elsewhere, not deleted, and belonging to this invoice's
 * client. Without the client check any id at all could be attached, which
 * quietly locks another client's work out of their own invoice. And the claim
 * must be *atomic*: the conditional UPDATE takes row locks, and comparing the
 * returned count to the requested one turns a partial claim into a rollback
 * rather than a half-billed invoice.
 */
async function attachRecords(
  ctx: Ctx,
  invoiceId: string,
  clientId: string,
  timeEntryIds: string[],
  expenseIds: string[]
) {
  if (timeEntryIds.length) {
    const claimable = ctx.db
      .select({ id: s.projects.id })
      .from(s.projects)
      .where(and(eq(s.projects.id, s.timeEntries.projectId), eq(s.projects.clientId, clientId)));

    const claimed = await ctx.db
      .update(s.timeEntries)
      .set({ invoiceId })
      .where(
        and(
          inArray(s.timeEntries.id, timeEntryIds),
          isNull(s.timeEntries.invoiceId),
          eq(s.timeEntries.isBillable, true),
          eq(s.timeEntries.billedExternally, false),
          isNull(s.timeEntries.deletedAt),
          isNull(s.timeEntries.timerStartedAt),
          exists(claimable)
        )
      )
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
    const claimable = ctx.db
      .select({ id: s.projects.id })
      .from(s.projects)
      .where(and(eq(s.projects.id, s.expenses.projectId), eq(s.projects.clientId, clientId)));

    const claimed = await ctx.db
      .update(s.expenses)
      .set({ invoiceId })
      .where(
        and(
          inArray(s.expenses.id, expenseIds),
          isNull(s.expenses.invoiceId),
          eq(s.expenses.isBillable, true),
          eq(s.expenses.billedExternally, false),
          isNull(s.expenses.deletedAt),
          exists(claimable)
        )
      )
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

/**
 * Gives back everything an invoice was holding, so it can be billed again.
 *
 * The rate lock goes with it. A record released from a sent invoice that keeps
 * `rates_locked_at` can never be re-rated, and nothing would ever clear it,
 * because the thing that set it no longer refers to the record.
 */
async function releaseRecords(ctx: Ctx, invoiceId: string) {
  await ctx.db
    .update(s.timeEntries)
    .set({ invoiceId: null, ratesLockedAt: null })
    .where(eq(s.timeEntries.invoiceId, invoiceId));
  await ctx.db
    .update(s.expenses)
    .set({ invoiceId: null, ratesLockedAt: null })
    .where(eq(s.expenses.invoiceId, invoiceId));
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

    if (input.lines) {
      // Detach what this draft was holding before the new lines claim their own
      // records. Without it, deleting a line leaves its hours claimed against
      // an invoice that no longer bills them: permanently uninvoiceable, and
      // invisible to the next preview.
      //
      // Replacing the lines without naming the records is a request to bill
      // different work than the invoice is holding, which is how the same hour
      // ends up on two invoices. If the caller does not say what the new lines
      // cover, keep what was already attached.
      const keepTimeEntryIds =
        input.timeEntryIds ??
        (await tx.db
          .select({ id: s.timeEntries.id })
          .from(s.timeEntries)
          .where(eq(s.timeEntries.invoiceId, id))).map((r) => r.id);
      const keepExpenseIds =
        input.expenseIds ??
        (await tx.db
          .select({ id: s.expenses.id })
          .from(s.expenses)
          .where(eq(s.expenses.invoiceId, id))).map((r) => r.id);

      await releaseRecords(tx, id);
      await tx.db.delete(s.invoiceLineItems).where(eq(s.invoiceLineItems.invoiceId, id));

      const lines = input.lines.map((l, i) => ({
        id: newId(),
        invoiceId: id,
        position: i,
        projectId: l.projectId ?? null,
        description: l.description,
        quantity: String(l.quantity),
        unitPriceCents: l.unitPriceCents,
        amountCents: l.amountCents ?? lineAmount(l.quantity, l.unitPriceCents),
        isTaxed: l.isTaxed ?? true,
      }));
      if (lines.length) await tx.db.insert(s.invoiceLineItems).values(lines);

      await attachRecords(tx, id, before.clientId, keepTimeEntryIds, keepExpenseIds);

      // Records that were on a sent invoice and are no longer on any invoice
      // must lose their rate lock too, or they stay unrateable forever.
      if (before.state !== "draft") {
        await tx.db
          .update(s.timeEntries)
          .set({ ratesLockedAt: tx.now() })
          .where(eq(s.timeEntries.invoiceId, id));
        await tx.db
          .update(s.expenses)
          .set({ ratesLockedAt: tx.now() })
          .where(eq(s.expenses.invoiceId, id));
      }
    }

    // Totals are recomputed from whatever the lines now are, whether or not
    // this request replaced them. Guarding this on `input.lines` meant a
    // tax-only or discount-only edit returned 200 and changed nothing.
    if (input.lines || input.taxPercent !== undefined || input.discountPercent !== undefined) {
      const taxPercent = input.taxPercent === undefined ? numberOrNull(before.taxPercent) : input.taxPercent;
      const discountPercent =
        input.discountPercent === undefined ? numberOrNull(before.discountPercent) : input.discountPercent;

      const stored = await tx.db
        .select({
          quantity: s.invoiceLineItems.quantity,
          unitPriceCents: s.invoiceLineItems.unitPriceCents,
          amountCents: s.invoiceLineItems.amountCents,
          isTaxed: s.invoiceLineItems.isTaxed,
        })
        .from(s.invoiceLineItems)
        .where(eq(s.invoiceLineItems.invoiceId, id));

      const totals = computeInvoiceTotals(
        stored.map((l) => ({
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

      // A retainer draw was sized against the old total. Editing the invoice
      // below it would leave the client debited for more than they are being
      // billed, so the excess goes back on the ledger as its own movement.
      let drawCents = before.retainerDrawCents;
      if (drawCents > totals.totalCents) {
        const excess = drawCents - totals.totalCents;
        await reverseRetainerDraw(tx, id, before.clientId, excess, "invoice reduced");
        drawCents = totals.totalCents;
        patch.retainerDrawCents = drawCents;
      }

      // A paid invoice edited upward is no longer paid. Leaving the state alone
      // would drop it out of receivables while it is still owed.
      const settled = before.paidCents + drawCents;
      const state = stateAfterPayment(totals.totalCents, settled, before.state as InvoiceState);
      if (state !== before.state) {
        patch.state = state;
        patch.paidAt = state === "paid" ? (before.paidAt ?? tx.now()) : null;
      }
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

/**
 * What has actually settled the invoice.
 *
 * A retainer draw is money the client already handed over, so an invoice fully
 * covered by one is paid. Counting only `invoice_payments` left such an invoice
 * open forever: it aged into "Late" and sat in the receivables total at face
 * value while its own detail page showed a zero balance.
 */
async function settledCents(ctx: Ctx, invoiceId: string, paidCents?: number): Promise<number> {
  const paid = paidCents ?? (await sumPayments(ctx, invoiceId));
  const [row] = await ctx.db
    .select({ drawCents: s.invoices.retainerDrawCents })
    .from(s.invoices)
    .where(eq(s.invoices.id, invoiceId))
    .limit(1);
  return paid + (row?.drawCents ?? 0);
}

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

    // Hold the row for the rest of the transaction. Two concurrent sends can
    // otherwise both read `draft`, both pass the guard above, and both draw
    // against the retainer.
    await tx.db.execute(sql`SELECT 1 FROM invoices WHERE id = ${id} FOR UPDATE`);
    const [locked] = await tx.db
      .select({ state: s.invoices.state })
      .from(s.invoices)
      .where(eq(s.invoices.id, id))
      .limit(1);
    if (!locked || !canTransition(locked.state as InvoiceState, "mark_sent")) {
      throw new AppError("invoice_state_invalid", "That invoice has already been sent.");
    }

    // Revalidate before locking anything. A draft can sit for a week, and in
    // that week an attached entry can be deleted, un-billed, or moved onto
    // another client's project. Sending is the moment the numbers become a
    // promise to somebody, so it is the last chance to notice.
    const [stale] = await tx.db
      .select({ count: sql<string>`COUNT(*)::text` })
      .from(s.timeEntries)
      .innerJoin(s.projects, eq(s.projects.id, s.timeEntries.projectId))
      .where(
        and(
          eq(s.timeEntries.invoiceId, id),
          sql`(
            ${s.timeEntries.deletedAt} IS NOT NULL
            OR NOT ${s.timeEntries.isBillable}
            OR ${s.projects.clientId} <> ${before.clientId}
          )`
        )
      );
    if (Number(stale?.count ?? 0) > 0) {
      throw new AppError(
        "attached_entries_changed",
        "Some of the time on this invoice changed since the lines were generated. Regenerate them before sending.",
        { meta: { staleEntries: Number(stale?.count ?? 0) } }
      );
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

  const rendered = await renderInvoiceMessage(ctx, id, kind, subject, bodyText);

  /*
    Queue rather than send.

    This runs inside the request's transaction. Sending here would put an email
    on the wire that a rollback cannot recall, so the client would hold an
    invoice we have no record of issuing. `queueMail` writes a row in the same
    transaction: either both survive or neither does. `pnpm jobs:mail` does the
    sending, outside any transaction of ours.
  */
  const queued = await queueMail(ctx, {
    kind,
    // Comma-joined, which nodemailer accepts, so two people in the To field
    // arrive on one email rather than getting a copy each.
    to: recipients.to.join(", "),
    cc: recipients.cc,
    subject: rendered.subject,
    text: rendered.body,
    relatedType: "invoice",
    relatedId: id,
  });

  /*
    Each bcc gets its own message.

    There is no bcc column, and adding recipients to `cc` would disclose them,
    which is the one thing bcc exists to prevent. A separate copy per address is
    the honest version: the recipient sees only themselves.
  */
  for (const address of recipients.bcc ?? []) {
    await queueMail(ctx, {
      kind,
      to: address,
      subject: rendered.subject,
      text: rendered.body,
      relatedType: "invoice",
      relatedId: id,
    });
  }

  await ctx.db.insert(s.invoiceMessages).values({
    id: newId(),
    invoiceId: id,
    kind,
    subject: rendered.subject,
    // What was sent, stored. Not a template reference: an invoice email is
    // close enough to a legal document that a later template edit must not
    // rewrite what a client was told.
    body: rendered.body,
    recipients,
    sentBy: ctx.actor.userId,
    deliveryState: queued.queued ? "queued" : "not_configured",
  });

  ctx.audit({ action: `invoice.${kind}`, entityType: "invoice", entityId: id, after: { recipients } });
  return { delivered: queued.queued };
}

/**
 * The subject and body an invoice message goes out with.
 *
 * A caller may supply both, which is what the send dialog does once somebody
 * has edited the text. When it does not, the account's template is resolved and
 * its tokens filled from the invoice. Defaults live in `invoice-config.ts` and
 * are merged over whatever the account has stored, so an account that never
 * edited a template has nothing to keep in step.
 */
async function renderInvoiceMessage(
  ctx: Ctx,
  id: string,
  kind: "invoice" | "reminder" | "thank_you",
  subject?: string,
  bodyText?: string
): Promise<{ subject: string; body: string }> {
  if (subject && bodyText) return { subject, body: bodyText };

  const settings = await getSettings(ctx);
  const messages = resolveMessages(settings.invoiceMessages);

  const [row] = await ctx.db
    .select({
      number: s.invoices.number,
      issueDate: s.invoices.issueDate,
      dueDate: s.invoices.dueDate,
      totalCents: s.invoices.totalCents,
      currency: s.invoices.currency,
      client: s.clients.name,
    })
    .from(s.invoices)
    .innerJoin(s.clients, eq(s.clients.id, s.invoices.clientId))
    .where(eq(s.invoices.id, id))
    .limit(1);

  if (!row) throw notFound("That invoice");

  const tokens = {
    number: row.number ?? "",
    client: row.client,
    company: settings.companyName,
    // The same formatter every screen uses. A local one drifted on currencies
    // with other than two decimal places: a yen total read 1,235 in the email
    // and 1,234.56 on the invoice, and a client seeing two different numbers is
    // the whole failure.
    amount: formatMoney(Number(row.totalCents), row.currency),
    dueDate: row.dueDate ?? "",
    issueDate: row.issueDate ?? "",
  };

  const pick =
    kind === "invoice"
      ? { s: messages.sendSubject, b: messages.sendBody }
      : kind === "reminder"
        ? { s: messages.reminderSubject, b: messages.reminderBody }
        : { s: messages.thanksSubject, b: messages.thanksBody };

  /*
    Check the TEMPLATE, before substitution, not the rendered output.

    Scanning the output was wrong in a way a reviewer found immediately: the
    client's own name goes into the text, so an invoice for a company called
    "{{ACME}}" was refused, and the error blamed a template that was fine. The
    template is the only thing that can promise a token, so it is the only thing
    worth checking, and checking it first means no amount of odd punctuation in
    a client name, a note or an amount can trip it.

    Caller-supplied text is not checked. That is somebody typing in the send
    dialog, and their braces are their business; the template is the shared
    thing that has to keep its promises.
  */
  const promised = [pick.s, pick.b].flatMap((t) => [...t.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]!));
  const unfillable = [...new Set(promised)].filter((name) => !(name in tokens));

  if (unfillable.length) {
    throw new AppError(
      "validation_failed",
      `This message template uses ${unfillable.map((n) => `{{${n}}}`).join(", ")}, which nothing fills in. ` +
        `Edit it in Invoices, Configure, Messages.`
    );
  }

  return {
    subject: subject ?? renderLabel(pick.s, tokens),
    body: bodyText ?? renderLabel(pick.b, tokens),
  };
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

    // Hold the invoice row for the rest of the transaction. Recomputing
    // paid_cents from the ledger is only safe if nobody else is recomputing it
    // at the same time: two concurrent payments each sum a set that excludes
    // the other, and the second write wins.
    await tx.db.execute(sql`SELECT 1 FROM invoices WHERE id = ${id} FOR UPDATE`);

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
    const state = stateAfterPayment(
      before.totalCents,
      paidCents + before.retainerDrawCents,
      before.state as InvoiceState
    );

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
  // FOR UPDATE, because what follows is read, compute, write on a money column.
  // Two concurrent movements without the lock lose one of them: both write a
  // ledger row, only one balance survives, and the two disagree forever.
  const [retainer] = await ctx.db
    .select()
    .from(s.retainers)
    .where(and(eq(s.retainers.clientId, clientId), isNull(s.retainers.projectId), isNull(s.retainers.archivedAt)))
    .limit(1)
    .for("update");

  if (!retainer || retainer.balanceCents <= 0) return;

  const [invoice] = await ctx.db
    .select({ totalCents: s.invoices.totalCents })
    .from(s.invoices)
    .where(eq(s.invoices.id, invoiceId))
    .limit(1);
  if (!invoice) return;


  const draw = Math.min(retainer.balanceCents, invoice.totalCents);
  if (draw <= 0) return;

  // Through `moveBalance`, like every other change to a retainer balance. It
  // takes the lock again, which is free inside this transaction and means the
  // rule about never going below zero is enforced in one place rather than
  // trusted at each call site.
  const balanceAfter = await moveBalance(ctx, {
    retainerId: retainer.id,
    kind: "draw",
    deltaCents: -draw,
    invoiceId,
    note: "Applied to invoice",
  });
  if (balanceAfter === null) return;

  await ctx.db.update(s.invoices).set({ retainerDrawCents: draw }).where(eq(s.invoices.id, invoiceId));

  // A draw is money settling the invoice, so an invoice it fully covers is paid
  // the moment it is sent rather than sitting open against a balance of zero.
  const paidCents = await sumPayments(ctx, invoiceId);
  const state = stateAfterPayment(invoice.totalCents, paidCents + draw, "open");
  if (state === "paid") {
    await ctx.db
      .update(s.invoices)
      .set({ state, paidAt: ctx.now() })
      .where(eq(s.invoices.id, invoiceId));
  }

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

  // The credit goes back to the retainer that was actually drawn, which the
  // draw recorded on its own ledger row. Looking the client up again returns
  // whichever retainer matches today, and if the original was archived and
  // replaced in between, that is the wrong one.
  const [source] = await ctx.db
    .select({ retainerId: s.retainerTransactions.retainerId })
    .from(s.retainerTransactions)
    .where(and(eq(s.retainerTransactions.invoiceId, invoiceId), eq(s.retainerTransactions.kind, "draw")))
    .orderBy(desc(s.retainerTransactions.occurredAt))
    .limit(1);

  const [retainer] = await ctx.db
    .select()
    .from(s.retainers)
    .where(
      source
        ? eq(s.retainers.id, source.retainerId)
        : and(eq(s.retainers.clientId, clientId), isNull(s.retainers.projectId))
    )
    .limit(1)
    .for("update");
  if (!retainer) return;

  await moveBalance(ctx, {
    retainerId: retainer.id,
    kind: "adjust",
    deltaCents: drawCents,
    invoiceId,
    note: `Draw reversed: ${reason}`,
  });

  // Subtract what was returned rather than zeroing, because an edit can return
  // part of a draw while the rest of it still applies.
  await ctx.db
    .update(s.invoices)
    .set({ retainerDrawCents: sql`GREATEST(0, ${s.invoices.retainerDrawCents} - ${drawCents})` })
    .where(eq(s.invoices.id, invoiceId));
}

/* --------------------------------------------------- recurring and retainers */

/**
 * Recurring schedules moved to `./recurring.ts` when they gained a write
 * path, so the read and the writes share one serializer and one idea of
 * what a schedule is. `listRecurring` used to live here.
 */



export async function addRetainerTransaction(
  ctx: Ctx,
  retainerId: string,
  input: { kind: "add" | "draw" | "adjust"; amountCents: number; note?: string | null }
) {
  assertCan(ctx, "invoice:manage");
  if (input.amountCents <= 0) throw validationFailed({ amountCents: ["An amount is required."] });

  return withTransaction(ctx, async (tx) => {
    const [retainer] = await tx.db
      .select()
      .from(s.retainers)
      .where(eq(s.retainers.id, retainerId))
      .limit(1)
      .for("update");
    if (!retainer) throw notFound("That retainer");

    const delta = ledgerDelta(input.kind, input.amountCents);
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
