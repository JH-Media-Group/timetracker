/**
 * Recurring invoices.
 *
 * The schedules that carry most of JHMG's billing: monthly support and hosting
 * plans, quarterly hosting, and a handful of multi-year domain renewals. Until
 * this file existed the table was designed, listed by one read endpoint, and
 * write-only in the sense that nothing could write it.
 *
 * A schedule is a **template**, not an invoice. The lines live in `template`
 * and the invoice is built from them at issue time, so the numbering sequence,
 * and the client's tax and discount, are read on the day it is raised rather
 * than frozen when it was set up. Freezing them is how a schedule quietly bills
 * last year's prices after a rate change.
 *
 * Issuing goes through `createInvoice` rather than writing invoice rows here.
 * That keeps one path for numbering under a row lock, totals in the fixed
 * order, and the audit and outbox rows, all of which `tests/invoices.test.ts`
 * already holds invariants over.
 *
 * The calendar arithmetic is in `src/domain/recurrence.ts` and tested there.
 */

import { and, asc, eq } from "drizzle-orm";
import { assertCan, withTransaction, type Ctx } from "@/server/ctx";
import * as s from "@/server/db/schema";
import { newId } from "@/server/db/ids";
import { notFound, validationFailed } from "@/server/errors";
import { addDays, dayIn, type IsoDate } from "@/domain/calendar";
import {
  anchorDayOf,
  anchorWeekdayOf,
  hasFinished,
  nextOccurrence,
  nextOccurrenceAfter,
  type Frequency,
} from "@/domain/recurrence";
import { createInvoice, type InvoiceInput } from "./invoices";

const FREQUENCIES: Frequency[] = ["weekly", "monthly", "quarterly", "yearly"];
const isFrequency = (v: string): v is Frequency => (FREQUENCIES as string[]).includes(v);

export type RecurringState = "active" | "paused" | "completed";

export interface RecurringInput {
  clientId: string;
  subject?: string | null;
  notes?: string | null;
  frequency: Frequency;
  interval: number;
  startsOn: IsoDate;
  endsOn?: IsoDate | null;
  occurrencesRemaining?: number | null;
  sendAutomatically?: boolean;
  /** Days after the issue date the raised invoice is due. */
  paymentTermDays?: number;
  taxPercent?: number | null;
  discountPercent?: number | null;
  lines: InvoiceInput["lines"];
}

/** The shape stored in `template`, and the shape an issued invoice is built from. */
interface Template {
  notes: string | null;
  paymentTermDays: number;
  taxPercent: number | null;
  discountPercent: number | null;
  lines: InvoiceInput["lines"];
  /** Denormalised for the list column, which shows an amount per schedule. */
  amountCents: number;
}

const templateAmount = (lines: InvoiceInput["lines"]) =>
  lines.reduce((total, l) => total + (l.amountCents ?? Math.round(l.quantity * l.unitPriceCents)), 0);

function readTemplate(raw: unknown): Template {
  const t = (raw ?? {}) as Partial<Template>;
  return {
    notes: t.notes ?? null,
    paymentTermDays: t.paymentTermDays ?? 30,
    taxPercent: t.taxPercent ?? null,
    discountPercent: t.discountPercent ?? null,
    lines: t.lines ?? [],
    amountCents: t.amountCents ?? 0,
  };
}

export interface RecurringDto {
  id: string;
  clientId: string;
  subject: string | null;
  frequency: Frequency;
  interval: number;
  startsOn: IsoDate;
  endsOn: IsoDate | null;
  occurrencesRemaining: number | null;
  nextIssueOn: IsoDate | null;
  lastIssuedOn: IsoDate | null;
  state: RecurringState;
  sendAutomatically: boolean;
  amountCents: number;
  notes: string | null;
  paymentTermDays: number;
  taxPercent: number | null;
  discountPercent: number | null;
  lines: InvoiceInput["lines"];
}

function serialize(row: typeof s.recurringInvoices.$inferSelect): RecurringDto {
  const template = readTemplate(row.template);
  return {
    id: row.id,
    clientId: row.clientId,
    subject: row.subject,
    frequency: row.frequency as Frequency,
    interval: row.interval,
    startsOn: row.startsOn as IsoDate,
    endsOn: (row.endsOn as IsoDate | null) ?? null,
    occurrencesRemaining: row.occurrencesRemaining,
    nextIssueOn: (row.nextIssueOn as IsoDate | null) ?? null,
    lastIssuedOn: (row.lastIssuedOn as IsoDate | null) ?? null,
    state: row.state as RecurringState,
    sendAutomatically: row.sendAutomatically,
    amountCents: template.amountCents,
    notes: template.notes,
    paymentTermDays: template.paymentTermDays,
    taxPercent: template.taxPercent,
    discountPercent: template.discountPercent,
    lines: template.lines,
  };
}

/* ------------------------------------------------------------------ reads */

export async function listRecurring(ctx: Ctx): Promise<RecurringDto[]> {
  assertCan(ctx, "invoice:view");
  const rows = await ctx.db
    .select()
    .from(s.recurringInvoices)
    .orderBy(asc(s.recurringInvoices.nextIssueOn));
  return rows.map(serialize);
}

export async function getRecurring(ctx: Ctx, id: string): Promise<RecurringDto> {
  assertCan(ctx, "invoice:view");
  const [row] = await ctx.db
    .select()
    .from(s.recurringInvoices)
    .where(eq(s.recurringInvoices.id, id))
    .limit(1);
  if (!row) throw notFound("That schedule");
  return serialize(row);
}

/* ----------------------------------------------------------------- writes */

function validate(input: RecurringInput): void {
  const errors: Record<string, string[]> = {};

  if (!isFrequency(input.frequency)) errors.frequency = ["Pick how often this repeats."];
  if (!Number.isInteger(input.interval) || input.interval < 1 || input.interval > 60) {
    errors.interval = ["Repeat every 1 to 60 periods."];
  }
  if (!input.lines.length) errors.lines = ["A schedule needs at least one line to bill."];
  if (input.endsOn && input.endsOn < input.startsOn) {
    errors.endsOn = ["The end date is before the start date."];
  }
  if (input.occurrencesRemaining != null && input.occurrencesRemaining < 1) {
    errors.occurrencesRemaining = ["Leave this empty for no limit, or set at least one."];
  }
  if (input.paymentTermDays != null && (input.paymentTermDays < 0 || input.paymentTermDays > 365)) {
    errors.paymentTermDays = ["Payment terms run from 0 to 365 days."];
  }

  if (Object.keys(errors).length) throw validationFailed(errors);
}

const toTemplate = (input: RecurringInput): Template => ({
  notes: input.notes ?? null,
  paymentTermDays: input.paymentTermDays ?? 30,
  taxPercent: input.taxPercent ?? null,
  discountPercent: input.discountPercent ?? null,
  lines: input.lines,
  amountCents: templateAmount(input.lines),
});

export async function createRecurring(ctx: Ctx, input: RecurringInput): Promise<RecurringDto> {
  assertCan(ctx, "invoice:manage");
  validate(input);

  return withTransaction(ctx, async (tx) => {
    const [client] = await tx.db
      .select({ id: s.clients.id })
      .from(s.clients)
      .where(eq(s.clients.id, input.clientId))
      .limit(1);
    if (!client) throw validationFailed({ clientId: ["That client does not exist."] });

    const today = dayIn(tx.actor.timezone, tx.now());
    // A schedule starting in the past is due now, not backdated across every
    // period it missed. Starting one today should bill today.
    const first =
      input.startsOn >= today
        ? input.startsOn
        : nextOccurrenceAfter(
            input.startsOn,
            input.frequency,
            input.interval,
            anchorDayOf(input.startsOn),
            addDays(today, -1)
          );

    const id = newId();
    await tx.db.insert(s.recurringInvoices).values({
      id,
      clientId: input.clientId,
      subject: input.subject ?? null,
      template: toTemplate(input),
      frequency: input.frequency,
      interval: input.interval,
      dayOfMonth: input.frequency === "weekly" ? null : anchorDayOf(input.startsOn),
      dayOfWeek: input.frequency === "weekly" ? anchorWeekdayOf(input.startsOn) : null,
      startsOn: input.startsOn,
      endsOn: input.endsOn ?? null,
      occurrencesRemaining: input.occurrencesRemaining ?? null,
      nextIssueOn: first,
      sendAutomatically: input.sendAutomatically ?? false,
      state: "active",
    });

    const after = await getRecurring(tx, id);
    tx.audit({
      action: "recurring_invoice.create",
      entityType: "recurring_invoice",
      entityId: id,
      entityLabel: input.subject ?? "Recurring invoice",
      after,
    });
    return after;
  });
}

export async function updateRecurring(
  ctx: Ctx,
  id: string,
  input: RecurringInput
): Promise<RecurringDto> {
  assertCan(ctx, "invoice:manage");
  validate(input);

  return withTransaction(ctx, async (tx) => {
    const before = await getRecurring(tx, id);

    // The anchor moves only when the start date does, so editing the amount on
    // a schedule that has been running for a year does not shift the day it
    // lands on.
    const startMoved = input.startsOn !== before.startsOn;
    const anchor = anchorDayOf(input.startsOn);
    const today = dayIn(tx.actor.timezone, tx.now());

    const nextIssueOn = startMoved
      ? input.startsOn >= today
        ? input.startsOn
        : nextOccurrenceAfter(input.startsOn, input.frequency, input.interval, anchor, addDays(today, -1))
      : before.nextIssueOn;

    await tx.db
      .update(s.recurringInvoices)
      .set({
        clientId: input.clientId,
        subject: input.subject ?? null,
        template: toTemplate(input),
        frequency: input.frequency,
        interval: input.interval,
        dayOfMonth: input.frequency === "weekly" ? null : anchor,
        dayOfWeek: input.frequency === "weekly" ? anchorWeekdayOf(input.startsOn) : null,
        startsOn: input.startsOn,
        endsOn: input.endsOn ?? null,
        occurrencesRemaining: input.occurrencesRemaining ?? null,
        nextIssueOn,
        sendAutomatically: input.sendAutomatically ?? false,
        updatedAt: tx.now(),
      })
      .where(eq(s.recurringInvoices.id, id));

    const after = await getRecurring(tx, id);
    tx.audit({
      action: "recurring_invoice.update",
      entityType: "recurring_invoice",
      entityId: id,
      entityLabel: after.subject ?? "Recurring invoice",
      before,
      after,
    });
    return after;
  });
}

/**
 * Pause or resume.
 *
 * **Resuming picks the cadence back up; it does not backfill.** A schedule
 * paused in January and resumed in June raises its next invoice in June, not
 * five at once. Raising months of back invoices because somebody forgot to
 * un-pause is a worse failure than being a month late, and it is the one a
 * client notices.
 */
export async function setRecurringState(
  ctx: Ctx,
  id: string,
  state: Exclude<RecurringState, "completed">
): Promise<RecurringDto> {
  assertCan(ctx, "invoice:manage");

  return withTransaction(ctx, async (tx) => {
    const before = await getRecurring(tx, id);
    if (before.state === "completed") {
      throw validationFailed({ _: ["This schedule has finished and cannot be restarted."] });
    }

    const today = dayIn(tx.actor.timezone, tx.now());
    const anchor = anchorDayOf(before.startsOn);

    const nextIssueOn =
      state === "active" && before.nextIssueOn && before.nextIssueOn < today
        ? nextOccurrenceAfter(before.nextIssueOn, before.frequency, before.interval, anchor, addDays(today, -1))
        : before.nextIssueOn;

    await tx.db
      .update(s.recurringInvoices)
      .set({ state, nextIssueOn, updatedAt: tx.now() })
      .where(eq(s.recurringInvoices.id, id));

    const after = await getRecurring(tx, id);
    tx.audit({
      action: state === "paused" ? "recurring_invoice.pause" : "recurring_invoice.resume",
      entityType: "recurring_invoice",
      entityId: id,
      entityLabel: after.subject ?? "Recurring invoice",
      before,
      after,
    });
    return after;
  });
}

export async function deleteRecurring(ctx: Ctx, id: string): Promise<void> {
  assertCan(ctx, "invoice:manage");

  await withTransaction(ctx, async (tx) => {
    const before = await getRecurring(tx, id);

    // Deleting the schedule does not touch the invoices it raised. They are
    // real documents a client has, and `invoices.recurringInvoiceId` is
    // `on delete set null` for exactly this reason.
    await tx.db.delete(s.recurringInvoices).where(eq(s.recurringInvoices.id, id));

    tx.audit({
      action: "recurring_invoice.delete",
      entityType: "recurring_invoice",
      entityId: id,
      entityLabel: before.subject ?? "Recurring invoice",
      before,
    });
  });
}

/**
 * Raise the next invoice from a schedule and move it on one period.
 *
 * The invoice and the advance happen in one transaction, so a crash between
 * them cannot leave a schedule that fires the same period twice. That property
 * is what the daily job in TALLY-26 will depend on, and it is why the advance
 * lives here rather than in the caller.
 */
export async function issueRecurringNow(ctx: Ctx, id: string): Promise<{ invoiceId: string }> {
  assertCan(ctx, "invoice:manage");

  return withTransaction(ctx, async (tx) => {
    const schedule = await getRecurring(tx, id);

    if (schedule.state === "completed") {
      throw validationFailed({ _: ["This schedule has finished."] });
    }
    if (!schedule.nextIssueOn) {
      throw validationFailed({ _: ["This schedule has no next date to issue."] });
    }

    const issueDate = schedule.nextIssueOn;
    const invoice = await createInvoice(tx, {
      clientId: schedule.clientId,
      subject: schedule.subject,
      notes: schedule.notes,
      issueDate,
      dueDate: addDays(issueDate, schedule.paymentTermDays),
      taxPercent: schedule.taxPercent,
      discountPercent: schedule.discountPercent,
      lines: schedule.lines,
    });

    const anchor = anchorDayOf(schedule.startsOn);
    const following = nextOccurrence(issueDate, schedule.frequency, schedule.interval, anchor);
    const remaining =
      schedule.occurrencesRemaining == null ? null : Math.max(0, schedule.occurrencesRemaining - 1);
    const finished = hasFinished(following, schedule.endsOn, remaining);

    await tx.db
      .update(s.recurringInvoices)
      .set({
        lastIssuedOn: issueDate,
        nextIssueOn: finished ? null : following,
        occurrencesRemaining: remaining,
        state: finished ? "completed" : schedule.state,
        updatedAt: tx.now(),
      })
      .where(eq(s.recurringInvoices.id, id));

    await tx.db
      .update(s.invoices)
      .set({ recurringInvoiceId: id })
      .where(and(eq(s.invoices.id, invoice.id)));

    tx.audit({
      action: "recurring_invoice.issue",
      entityType: "recurring_invoice",
      entityId: id,
      entityLabel: schedule.subject ?? "Recurring invoice",
      after: { invoiceId: invoice.id, issuedOn: issueDate, nextIssueOn: finished ? null : following },
    });

    return { invoiceId: invoice.id };
  });
}
