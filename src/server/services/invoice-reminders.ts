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
 * The escalation steps below are days past due. A reminder goes out when an
 * invoice crosses into a step above the one it was last chased about, which
 * `invoices.reminder_level` records.
 *
 * **Counting the reminders already sent was the first attempt and it was
 * wrong.** An invoice discovered when it is already thirty days late has
 * crossed three steps at once, and a count-based rule sends one per run to
 * catch up. The mail job runs every five minutes, so that is three emails to a
 * client inside a quarter of an hour, which is worse than sending nothing. A
 * review caught it. Recording the level means crossing straight to the last
 * step sends exactly one message, and it is the right one: nobody needs the
 * "one day late" note when they are a month past due.
 *
 * Each invoice is handled in its own transaction with the row locked, so two
 * overlapping runs cannot both decide to send. The lock is per invoice rather
 * than around the whole pass: a long run must not hold every invoice.
 *
 * THE LEVEL GOES DOWN AS WELL AS UP
 *
 * A level that only ever climbed silenced an invoice permanently, and the way
 * in was the ordinary one: a client asks for more time, somebody moves the due
 * date out, and the invoice stops being late. It then fell out of the scan
 * altogether (the scan asked for `due_date <= today`), so its level stayed at
 * whatever it had reached. When the new date passed and it was one day late
 * again, `stepsPassed` was 1 against a recorded level of 3, which reads as
 * already chased. **Granting an extension quietly disabled chasing for the rest
 * of that invoice's life**, and the symptom is silence, which nobody reports.
 *
 * So the level tracks the step the invoice is actually at, in both directions,
 * and the scan takes anything that has been chased even if it is no longer
 * late, so that there is something to correct.
 */

import { and, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import { withTransaction, type Ctx } from "@/server/ctx";
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
  /** Invoices whose escalation was wound back, because they are no longer as late. */
  reset: number;
  skippedNoContact: string[];
  /** Invoices whose own template or data refused to render, and why. */
  failed: { invoice: string; reason: string }[];
}

/**
 * Send the reminders due today.
 *
 * `today` is a parameter so the run can be checked against a future date
 * without waiting for it, the way the recurring job takes `--on`.
 */
export async function sendDueReminders(ctx: Ctx, today: string): Promise<ReminderReport> {
  const report: ReminderReport = { considered: 0, sent: 0, reset: 0, skippedNoContact: [], failed: [] };

  /*
    Open, actually owing money, and either late or previously chased.

    `paid_cents < total_cents` rather than a state check alone: a partly paid
    invoice is still owed and still worth chasing, and its state is `open` in
    exactly the same way an untouched one is.

    The `reminder_level > 0` arm is what makes an extension recoverable. An
    invoice whose due date has been moved into the future is not late and would
    otherwise never be looked at again, so its stale level would sit there
    silencing it. It costs one extra row per invoice we have ever chased.
  */
  const candidates = await ctx.db
    .select({
      id: s.invoices.id,
      number: s.invoices.number,
      dueDate: s.invoices.dueDate,
      clientId: s.invoices.clientId,
      reminderLevel: s.invoices.reminderLevel,
    })
    .from(s.invoices)
    .where(
      and(
        eq(s.invoices.state, "open"),
        isNull(s.invoices.deletedAt),
        or(lte(s.invoices.dueDate, today), gt(s.invoices.reminderLevel, 0)),
        sql`${s.invoices.paidCents} < ${s.invoices.totalCents}`
      )
    );

  for (const invoice of candidates) {
    report.considered++;

    const daysLate = Math.floor(
      (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${invoice.dueDate}T00:00:00Z`)) / 86_400_000
    );
    const stepsPassed = ESCALATION_DAYS.filter((d) => daysLate >= d).length;

    /*
      Nothing to send and nothing to wind back, so do not take a lock for it.

      A filter, not the decision: the level read here came from an unlocked
      scan, and the authoritative comparison happens below under the row lock.
      Skipping only when both numbers are zero means a stale read can cost a
      wasted lock, never a missed reminder. An invoice due today is the common
      case this saves.
    */
    if (stepsPassed === 0 && invoice.reminderLevel === 0) continue;

    /*
      One invoice must not take the whole run with it.

      This loop ran inside the mail job's single try, so a template promising a
      token nothing fills threw, the job exited non-zero, and `drainMail` never
      ran at all: one bad invoice stopped every password reset and every invite
      in the queue, on every run, for ever. The blast radius of an unrenderable
      message is now that message.
    */
    let outcome: "sent" | "up_to_date" | "no_contact" | "reset";
    try {
      outcome = await withTransaction(ctx, async (tx) => {
      /*
        Re-read the level under a lock.

        The scan above ran outside any transaction, so by now another run may
        have chased this invoice. Deciding on the value read here, rather than
        on the one from the scan, is what makes two overlapping jobs safe.
      */
      const [locked] = await tx.db
        .select({ level: s.invoices.reminderLevel })
        .from(s.invoices)
        .where(eq(s.invoices.id, invoice.id))
        .limit(1)
        .for("update");

      if (!locked) return "up_to_date" as const;

      /*
        No longer as late as the level says, so wind it back.

        This sends nothing. It restores the invoice to the step it is actually
        at, so that when it next crosses one there is a step to cross. A due
        date moved into the future lands here with `stepsPassed` of zero.
      */
      if (stepsPassed < locked.level) {
        await tx.db
          .update(s.invoices)
          .set({ reminderLevel: stepsPassed })
          .where(eq(s.invoices.id, invoice.id));
        return "reset" as const;
      }

      if (stepsPassed === locked.level) return "up_to_date" as const;

      const contacts = await tx.db
        .select({ email: s.clientContacts.email })
        .from(s.clientContacts)
        .where(and(eq(s.clientContacts.clientId, invoice.clientId), isNull(s.clientContacts.archivedAt)));

      const to = contacts.map((c) => c.email).filter((e): e is string => Boolean(e));

      if (!to.length) {
        // Silence here would be the worst outcome: an invoice nobody is chasing
        // and nobody knows nobody is chasing. The job reports these. The level
        // is deliberately not advanced, so it is chased the moment a contact
        // exists rather than having quietly used up its escalation.
        return "no_contact" as const;
      }

      // Straight to the step actually reached, not one per run.
      await tx.db
        .update(s.invoices)
        .set({ reminderLevel: stepsPassed })
        .where(eq(s.invoices.id, invoice.id));

        await recordMessage(tx, invoice.id, "reminder", { to });
        return "sent" as const;
      });
    } catch (e) {
      report.failed.push({
        invoice: invoice.number ?? invoice.id,
        reason: e instanceof Error ? e.message : String(e),
      });
      continue;
    }

    if (outcome === "sent") report.sent++;
    else if (outcome === "reset") report.reset++;
    else if (outcome === "no_contact") report.skippedNoContact.push(invoice.number ?? invoice.id);
  }

  return report;
}
