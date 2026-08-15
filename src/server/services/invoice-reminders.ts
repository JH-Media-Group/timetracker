/**
 * Chasing unpaid invoices, on a schedule (TALLY-50).
 *
 * The reminder template has existed since the invoicing epic and nothing ever
 * triggered it, so chasing a late invoice meant somebody remembering to. This
 * is the trigger.
 *
 * FIRE ON CROSSING, NOT ON STATE
 *
 * An invoice forty days late must not produce a reminder every single morning.
 * The rule the notifications epic sets out applies here too: an alert that
 * repeats gets filtered, and then the one that mattered gets filtered with it.
 *
 * The escalation steps below are days past due. A reminder is sent when an
 * invoice has crossed a step it has not been reminded about yet, which is
 * decided by counting the reminders already recorded against it rather than by
 * storing a separate cursor. `invoice_messages` is already the record of what
 * was sent; a second place to look would be a second place to be wrong.
 */

import { and, count, eq, isNull, lte, sql } from "drizzle-orm";
import type { Ctx } from "@/server/ctx";
import * as s from "@/server/db/schema";
import { recordMessage } from "./invoices";

/**
 * Days past due at which a reminder goes out.
 *
 * Three is enough. A fourth email to somebody who has ignored three is a phone
 * call, not a template.
 */
export const ESCALATION_DAYS = [1, 14, 30] as const;

export interface ReminderReport {
  considered: number;
  sent: number;
  skippedNoContact: string[];
}

/**
 * Send the reminders due today.
 *
 * `today` is a parameter so the run can be checked against a future date
 * without waiting for it, the way the recurring job takes `--on`.
 */
export async function sendDueReminders(ctx: Ctx, today: string): Promise<ReminderReport> {
  const report: ReminderReport = { considered: 0, sent: 0, skippedNoContact: [] };

  /*
    Open, overdue, and actually owing money.

    `paid_cents < total_cents` rather than a state check alone: a partly paid
    invoice is still owed and still worth chasing, and its state is `open` in
    exactly the same way an untouched one is.
  */
  const overdue = await ctx.db
    .select({
      id: s.invoices.id,
      number: s.invoices.number,
      dueDate: s.invoices.dueDate,
      clientId: s.invoices.clientId,
    })
    .from(s.invoices)
    .where(
      and(
        eq(s.invoices.state, "open"),
        isNull(s.invoices.deletedAt),
        lte(s.invoices.dueDate, today),
        sql`${s.invoices.paidCents} < ${s.invoices.totalCents}`
      )
    );

  for (const invoice of overdue) {
    report.considered++;

    const daysLate = Math.floor(
      (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${invoice.dueDate}T00:00:00Z`)) / 86_400_000
    );

    /*
      How many steps this invoice has passed, against how many it has been told
      about. Equal means it is up to date; nothing to do.

      Counted with its own query rather than a correlated subquery in the select
      above. The subquery came back undefined, `Number(undefined)` is NaN, and
      every comparison against NaN is false, so the guard silently never fired
      and a day-late invoice was mailed once per run. There are only ever a
      handful of overdue invoices, so a query each is the cheaper mistake.
    */
    const [counted] = await ctx.db
      .select({ n: count() })
      .from(s.invoiceMessages)
      .where(and(eq(s.invoiceMessages.invoiceId, invoice.id), eq(s.invoiceMessages.kind, "reminder")));

    const stepsPassed = ESCALATION_DAYS.filter((d) => daysLate >= d).length;
    if (stepsPassed <= (counted?.n ?? 0)) continue;

    const contacts = await ctx.db
      .select({ email: s.clientContacts.email })
      .from(s.clientContacts)
      .where(and(eq(s.clientContacts.clientId, invoice.clientId), isNull(s.clientContacts.archivedAt)));

    const to = contacts.map((c) => c.email).filter((e): e is string => Boolean(e));

    if (!to.length) {
      // Silence here would be the worst outcome: an invoice nobody is chasing
      // and nobody knows nobody is chasing. The job reports these.
      report.skippedNoContact.push(invoice.number ?? invoice.id);
      continue;
    }

    await recordMessage(ctx, invoice.id, "reminder", { to });
    report.sent++;
  }

  return report;
}
