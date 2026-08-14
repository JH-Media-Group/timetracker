/**
 * Raise the recurring invoices that are due today.
 *
 * The other half of TALLY-25. A schedule that nothing ever issues is a diary
 * entry, and roughly $[private total removed] a month of JHMG's billing lives in these.
 *
 * WHY CRON AND NOT A QUEUE
 *
 * One droplet, about thirty schedules, thirty invoices a month, and the only
 * thing this touches is Postgres. A queue would add a second process to deploy
 * and watch, and would make Redis load-bearing for correctness when today it is
 * an optimisation with an in-process fallback. The property a queue would sell
 * us here, "each schedule is issued exactly once", is already held by the row
 * lock and the due-date recheck in `issueIfDue`, which is a better place for it:
 * it holds even if two runs overlap, or if somebody presses Issue now while the
 * job is mid-flight.
 *
 * So: safe to run at any time, safe to run twice, and a missed day is fixed by
 * running it again. The failure mode is "late", never "billed twice".
 *
 * On the droplet, an hour after the sweep:
 *
 *   0 6 * * *  cd /srv/tally && pnpm jobs:recurring >> /var/log/tally-recurring.log 2>&1
 *
 * Locally:  pnpm jobs:recurring [--on 2026-09-01] [--dry]
 *
 * `--on` bills as if it were that date, which is how you check next month's run
 * before it happens. `--dry` reports what is due and issues nothing.
 */

import type { IsoDate } from "../src/domain/calendar";
import { systemCtx } from "../src/server/jobs/context";
import { listRecurring, runDueRecurring } from "../src/server/services/recurring";

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const onIndex = args.indexOf("--on");
const on = onIndex !== -1 ? (args[onIndex + 1] as IsoDate | undefined) : undefined;

if (onIndex !== -1 && !/^\d{4}-\d{2}-\d{2}$/.test(on ?? "")) {
  console.error("--on wants a date as YYYY-MM-DD.");
  process.exit(2);
}

const startedAt = Date.now();

try {
  const ctx = await systemCtx();

  if (dry) {
    const day = on ?? new Date().toISOString().slice(0, 10);
    const due = (await listRecurring(ctx)).filter(
      (r) => r.state === "active" && r.nextIssueOn != null && r.nextIssueOn <= day
    );
    console.log(`Dry run for ${day}: ${due.length} schedule(s) due, nothing issued.`);
    for (const r of due) {
      console.log(`  ${r.nextIssueOn}  ${(r.subject ?? "(no subject)").padEnd(40)} ${r.id}`);
    }
    process.exit(0);
  }

  const outcome = await runDueRecurring(ctx, on);

  console.log(
    `Recurring run for ${outcome.on}: ${outcome.issued.length} issued, ` +
      `${outcome.skipped.length} skipped, ${outcome.failed.length} failed ` +
      `(${Date.now() - startedAt}ms)`
  );
  for (const i of outcome.issued) console.log(`  issued   ${i.scheduleId} -> ${i.invoiceId}`);
  for (const s of outcome.skipped) console.log(`  skipped  ${s.scheduleId}: ${s.why}`);
  for (const f of outcome.failed) console.error(`  FAILED   ${f.scheduleId}: ${f.why}`);

  // A non-zero exit is what makes a failure visible in a cron log that nobody
  // reads: the mail cron sends on failure is the alerting we have until there
  // is any other kind.
  process.exit(outcome.failed.length > 0 ? 1 : 0);
} catch (error) {
  console.error("The recurring run could not start.", error);
  process.exit(1);
}
