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
 * THE LEVEL BELONGS TO A DUE DATE
 *
 * A level on its own only ever climbed, which silenced an invoice for good by
 * an entirely ordinary route: a client asks for more time, somebody moves the
 * due date out, and when the new date passes the invoice is one day late
 * against a recorded level of three, which reads as already chased. Granting an
 * extension quietly disabled chasing for the rest of that invoice's life, and
 * the symptom is silence, which nobody reports.
 *
 * The first fix was a reset arm that wound the level back when the invoice was
 * no longer as late. It worked and it bought a duplicate: a due date edited by
 * mistake and put back sent the client a second copy of a dunning email they
 * already had. It also needed a widened scan to find invoices that were no
 * longer late, and an unlocked pre-filter to keep that scan cheap, and the
 * pre-filter then made a claim about locking that was not quite true.
 *
 * Recording the due date the level was reached against replaces all of it.
 * `reminder_due_date` and `reminder_level` are one fact: this invoice has been
 * chased to step L for due date D. A different due date means a different
 * schedule, so the escalation starts over on its own, and restoring the old
 * date restores the level that goes with it. No reset, no widened scan, no
 * pre-filter, and one less rule to keep true.
 *
 * **The pair is one fact, not a history, and that is a real limit.** Restoring
 * a due date restores its level only if nothing was sent against the date in
 * between: chase to step 3 for D, move to D2, let a reminder go out against D2,
 * and the pair now reads (1, D2). Move back to D and the escalation for D
 * starts again, so a client who is 30 days past D receives step 3 a second
 * time. Keeping every (date, level) an invoice has ever had would close it, and
 * is not worth a table for a case that needs two due-date changes with a
 * reminder between them. Recorded because the alternative is a comment that
 * claims more than the column can hold.
 */

import { and, eq, isNull, lte, sql } from "drizzle-orm";
import { withTransaction, type Ctx } from "@/server/ctx";
import { dayIn } from "@/domain/calendar";
import { accountTimezone } from "./settings";
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
  /** Invoices whose own template or data refused to render, and why. */
  failed: { invoice: string; reason: string }[];
}

/**
 * Send the reminders due today.
 *
 * `today` is a parameter so the run can be checked against a future date
 * without waiting for it, the way the recurring job takes `--on`.
 */
export async function sendDueReminders(ctx: Ctx, today?: string): Promise<ReminderReport> {
  /*
    The account's timezone, not UTC.

    The caller used to pass `new Date().toISOString().slice(0, 10)`. JHMG is in
    America/New_York and the mail job runs every five minutes, so from 20:00 ET
    every evening that string is already tomorrow: `daysLate` gains a day, the
    first escalation step is one day, and an invoice **due today** gets a
    dunning email at eight in the evening on its own due date. The sibling job
    states the rule three files away, in `recurring.ts`: "The account's
    timezone, not the actor's. Due on the 1st is a fact about the business."
    A due date is the same kind of fact.

    Still a parameter, so a run can be checked against a future date without
    waiting for it. `scripts/mail.mts` has no `--on` flag to pass one, so today
    the only caller that supplies it is the test suite; the comment here used to
    claim the flag existed by pointing at the recurring job, which does have one.
  */
  const on = today ?? dayIn(await accountTimezone(ctx), ctx.now());

  const report: ReminderReport = { considered: 0, sent: 0, skippedNoContact: [], failed: [] };

  /*
    Open, overdue, and actually owing money.

    `paid_cents < total_cents` rather than a state check alone: a partly paid
    invoice is still owed and still worth chasing, and its state is `open` in
    exactly the same way an untouched one is.

    Only invoices that are actually late. An earlier version also took anything
    previously chased, so that a stale level could be wound back; pairing the
    level with its due date removed the need, and with it a scan whose `OR`
    could not use the index.
  */
  const candidates = await ctx.db
    .select({
      id: s.invoices.id,
      number: s.invoices.number,
      clientId: s.invoices.clientId,
    })
    .from(s.invoices)
    .where(
      and(
        eq(s.invoices.state, "open"),
        isNull(s.invoices.deletedAt),
        lte(s.invoices.dueDate, on),
        sql`${s.invoices.paidCents} < ${s.invoices.totalCents}`
      )
    );

  for (const invoice of candidates) {
    report.considered++;

    /*
      One invoice must not take the whole run with it.

      This loop ran inside the mail job's single try, so a template promising a
      token nothing fills threw, the job exited non-zero, and `drainMail` never
      ran at all: one bad invoice stopped every password reset and every invite
      in the queue, on every run, for ever. The blast radius of an unrenderable
      message is now that message.
    */
    let outcome: "sent" | "up_to_date" | "no_contact";
    try {
      outcome = await withTransaction(ctx, async (tx) => {
      /*
        Re-read under the lock, and re-read **everything the decision uses**.

        The scan above ran outside any transaction, so by now another run may
        have chased this invoice and somebody may have moved its due date. An
        earlier version locked the row but re-read only the level, and computed
        how late the invoice was from the scan's copy of `due_date`. A reviewer
        found the hole that leaves: the due date changes between the scan and
        the lock, and the run then writes a level that belongs to a date the
        invoice no longer has. Deciding on values read here is the whole point
        of taking the lock, so nothing from the scan is used below.
      */
      const [locked] = await tx.db
        .select({
          level: s.invoices.reminderLevel,
          levelDueDate: s.invoices.reminderDueDate,
          dueDate: s.invoices.dueDate,
        })
        .from(s.invoices)
        .where(eq(s.invoices.id, invoice.id))
        .limit(1)
        .for("update");

      if (!locked) return "up_to_date" as const;

      const daysLate = Math.floor(
        (Date.parse(`${on}T00:00:00Z`) - Date.parse(`${locked.dueDate}T00:00:00Z`)) / 86_400_000
      );
      const stepsPassed = ESCALATION_DAYS.filter((d) => daysLate >= d).length;

      /*
        The level counts only against the due date it was reached for.

        A different due date is a different schedule, so the escalation starts
        over without anything having to reset it, and putting a mistaken edit
        back restores the level along with the date rather than re-sending a
        step the client already received.
      */
      const effectiveLevel = locked.levelDueDate === locked.dueDate ? locked.level : 0;
      if (stepsPassed <= effectiveLevel) return "up_to_date" as const;

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

      // Straight to the step actually reached, not one per run, and stamped
      // with the due date it was reached against.
      await tx.db
        .update(s.invoices)
        .set({ reminderLevel: stepsPassed, reminderDueDate: locked.dueDate })
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
    else if (outcome === "no_contact") report.skippedNoContact.push(invoice.number ?? invoice.id);
  }

  return report;
}
