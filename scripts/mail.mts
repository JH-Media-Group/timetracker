/**
 * Send the queued mail (TALLY-49).
 *
 * The half of email that is not a template. `queueMail` writes a row inside the
 * transaction that produced it; this is what turns those rows into messages.
 *
 * WHY THIS ONE IS DIFFERENT FROM THE OTHER JOBS
 *
 * BACKEND_PRD §9.0 argues that cron is enough because "neither job talks to
 * anything that can fail transiently". **This one does.** An SMTP server
 * greylists, rate limits, and goes down, and those are exactly the conditions
 * retry with backoff exists for. The retry state lives in the row
 * (`attempts`, `next_attempt_at`, `last_error`) rather than in a queue, which
 * keeps the single-process deployment and makes the backlog inspectable with
 * SQL, but it is a queue in everything but name and §9.0 now says so.
 *
 * Safe to run at any time and safe to overlap: rows are claimed with
 * `FOR UPDATE SKIP LOCKED`.
 *
 * Locally:  pnpm jobs:mail [--limit 20]
 *
 * With no `SMTP_URL` it reports that and sends nothing, which is the state a
 * developer machine is usually in. `MAIL_TO_DISK=1` writes to `.mail/` instead
 * of the internet, so the invite flow can be tested without mailing anybody.
 */

// On the droplet, every five minutes. A line comment rather than part of the
// block above, because a cron step expression contains the two characters that
// end a block comment and silently swallowed the rest of this file's header.
//
//   */5 * * * *  cd /srv/tally && pnpm jobs:mail >> /var/log/tally-mail.log 2>&1

import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { drainMail, mailQueueDepth } from "../src/server/services/mail";
import { sendDueReminders } from "../src/server/services/invoice-reminders";
import { systemCtx } from "../src/server/jobs/context";
import { sql as pg } from "../src/server/db/client";

const args = process.argv.slice(2);
const limitIndex = args.indexOf("--limit");
const limit = limitIndex !== -1 ? Number(args[limitIndex + 1]) : undefined;

if (limitIndex !== -1 && (!Number.isInteger(limit) || limit! < 1)) {
  console.error("--limit wants a positive whole number.");
  process.exit(2);
}

const startedAt = Date.now();

try {
  /*
    Queue the overdue reminders before draining, so anything raised this run
    goes out this run rather than waiting five minutes.

    Reminders live here rather than in their own job because they are the same
    concern on the same cadence, and a second cron line is a second thing to
    notice has stopped.
  */
  if (!args.includes("--no-reminders")) {
    const ctx = await systemCtx();
    const today = new Date().toISOString().slice(0, 10);
    const reminders = await sendDueReminders(ctx, today);
    if (reminders.sent) console.log(`Queued ${reminders.sent} overdue reminder(s).`);
    if (reminders.skippedNoContact.length) {
      console.warn(
        `  ! ${reminders.skippedNoContact.length} overdue invoice(s) have no client contact to chase: ` +
          reminders.skippedNoContact.slice(0, 10).join(", ")
      );
    }
  }

  const before = await mailQueueDepth();
  const report = await drainMail({ limit });
  const after = await mailQueueDepth();
  const ms = Date.now() - startedAt;

  if (report.skipped === "no_transport") {
    console.log(
      `Mail run skipped: no SMTP_URL, so nothing was attempted. ` +
        `${before.queued} message(s) waiting. Set MAIL_TO_DISK=1 to write them to .mail/ instead.`
    );
  } else {
    console.log(
      `Mail run: ${report.sent} sent, ${report.retrying} retrying, ${report.failed} failed, ` +
        `${after.queued} still queued, ${after.sending} in flight (${ms}ms)`
    );
    if (report.reconciled) {
      console.warn(
        `  ! ${report.reconciled} message(s) were abandoned mid-send with no attempts left and have been ` +
          `marked failed. A process died while sending; they were invisible until now.`
      );
    }
  }

  // A message that has run out of attempts will not move again on its own, so
  // it is worth saying out loud every run rather than only on the run that
  // gave up on it.
  if (after.failed) {
    console.warn(
      `  ! ${after.failed} message(s) have exhausted their attempts and will not be retried. ` +
        `Look at outbound_messages.last_error.`
    );
  }

  await pg.end();
  process.exit(report.failed > 0 ? 1 : 0);
} catch (e) {
  console.error("Mail run failed:", e instanceof Error ? e.message : e);
  await pg.end().catch(() => {});
  process.exit(1);
}
