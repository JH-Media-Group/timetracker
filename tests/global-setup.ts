/**
 * One test run at a time, enforced rather than assumed.
 *
 * Every file in this suite shares one database and truncates it between files,
 * which is why `fileParallelism` is off. Nothing stopped a *second* `vitest run`
 * from starting against the same database and truncating the first one's
 * fixtures mid-assertion. The result is not a clean failure: it is a scattering
 * of unrelated tests failing in whichever run lost the race, with no indication
 * that anything but the code under test was involved.
 *
 * It cost real time. During a review, two full runs reported 59 and 234
 * failures while an agent was running the suite in parallel, and a third run
 * minutes later was green. Both failure reports were noise, and the only way to
 * know that was to notice the other process.
 *
 * A session-level advisory lock is the whole mechanism. It is held by this
 * connection for the life of the run and released when the connection closes,
 * including when the process is killed, so there is no stale lock to clear.
 */

import { config } from "dotenv";
import postgres from "postgres";

config({ path: ".env.local", quiet: true });

/**
 * Arbitrary but fixed. Advisory locks share one namespace per database, and
 * nothing else in this application takes one, so any constant would do.
 */
const SUITE_LOCK_KEY = 8_143_207;

let sql: ReturnType<typeof postgres> | null = null;

export async function setup() {
  const url = process.env.TEST_DATABASE_URL;
  // Not this file's job to validate: tests/setup.ts already refuses to run
  // against a database that is not named tally_test, with a better message.
  if (!url) return;

  sql = postgres(url, { max: 1, idle_timeout: 0, connect_timeout: 10 });

  const [row] = await sql<{ locked: boolean }[]>`SELECT pg_try_advisory_lock(${SUITE_LOCK_KEY}) AS locked`;
  if (!row?.locked) {
    await sql.end({ timeout: 5 });
    sql = null;
    throw new Error(
      "Another test run is already using tally_test. Two runs share one database and truncate " +
        "each other's fixtures, which shows up as unrelated tests failing in whichever run loses " +
        "the race. Wait for the other run to finish, or check for a stray vitest process."
    );
  }
}

export async function teardown() {
  // Ending the connection releases the lock. Explicit unlock would be redundant
  // and would leave the lock held if this throws.
  await sql?.end({ timeout: 5 });
  sql = null;
}
