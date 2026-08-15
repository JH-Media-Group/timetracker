ALTER TABLE "invoices" ADD COLUMN "reminder_due_date" date;--> statement-breakpoint
-- Anything already chased is treated as chased against the due date it has now.
-- Without this, every invoice carrying a level would look like one whose date had
-- changed, and the first run after deploying would dun the lot of them again.
UPDATE "invoices" SET "reminder_due_date" = "due_date" WHERE "reminder_level" > 0;
