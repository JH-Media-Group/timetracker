ALTER TABLE "invoices" ADD COLUMN "reminder_due_date" date;--> statement-breakpoint
-- Anything already chased is stamped with the due date it has NOW, which is not
-- necessarily the date it was chased against: an invoice chased at step 3 and
-- then given a new due date before this ran is recorded as though all three
-- reminders had been sent for the new date, and stays quiet until the new date
-- is itself 30 days past. The original date is not recoverable from any column,
-- so this is the honest limit of the backfill rather than a claim about history.
--
-- The alternative, leaving the column null, re-chases every currently overdue
-- invoice on the next run, which mails clients. Silence for one escalation
-- cycle is the better failure.
--
-- It affects nothing today: the account has no invoices at all, so no row has
-- reminder_level > 0. Checked, not assumed.
UPDATE "invoices" SET "reminder_due_date" = "due_date" WHERE "reminder_level" > 0;
