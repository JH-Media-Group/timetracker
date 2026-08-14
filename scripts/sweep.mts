/**
 * The nightly sweep.
 *
 * Two tables accumulate rows that stop being useful: expired and revoked
 * sessions, and idempotency claims whose retry window has long closed. Both had
 * a purge function and neither had a caller, which is a housekeeping job that
 * exists only as a good intention.
 *
 * There is no job queue yet, so this runs from cron. On the droplet:
 *
 *   0 3 * * *  cd /srv/tally && pnpm sweep >> /var/log/tally-sweep.log 2>&1
 *
 * It is safe to run at any time and safe to run twice: both deletes are bounded
 * by an age, so a second run in the same minute removes nothing.
 */

import { purgeDeadSessions, purgeIdempotencyKeys } from "../src/server/auth/session";

const startedAt = Date.now();

const sessions = await purgeDeadSessions();
const idempotency = await purgeIdempotencyKeys();

console.log(
  `swept in ${Date.now() - startedAt}ms: ${sessions} dead sessions, ${idempotency} idempotency claims`
);
process.exit(0);
