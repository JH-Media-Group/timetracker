/**
 * The database handle.
 *
 * One pool for the process, reused across hot reloads in development. Next's
 * dev server re-evaluates modules on every change; without the global stash
 * you leak a pool per edit and hit Postgres's connection limit inside an hour.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "@/server/env";
import * as schema from "./schema";

const connectionString = env.isTest && env.TEST_DATABASE_URL ? env.TEST_DATABASE_URL : env.DATABASE_URL;

declare global {
  // eslint-disable-next-line no-var
  var __tallySql: ReturnType<typeof postgres> | undefined;
}

/**
 * Under test, a Date that reaches the database layer as a bind parameter is a bug.
 *
 * Drizzle's column mappers turn a Date into a string long before this point, so
 * a Date arriving as a parameter means it went in through a raw `sql` template,
 * where it has no column to be typed by. The driver then tries to serialise an
 * object as text and throws `ERR_INVALID_ARG_TYPE` at whatever moment that line
 * happens to run. That bug has been written four times, and three of the four
 * hid in code that runs rarely: a timer stop, a nightly purge, an hourly
 * session touch.
 *
 * `tests/sql-literals.test.ts` catches this statically, including in code no
 * test ever executes, which is where two of the four lived. This is the other
 * half: any query a test actually runs is checked no matter how the value got
 * into the template, and in particular no matter whether the type checker could
 * see it, which is how `any` gets covered. Neither half subsumes the other.
 *
 * WHY THIS IS DRIZZLE'S LOGGER AND NOT POSTGRES.JS'S `debug` HOOK
 *
 * The first version threw from inside postgres.js's `debug` callback, and a
 * reviewer showed that it corrupts the connection under concurrency. `debug`
 * fires inside `build(q)`, after the query has been pushed onto the connection's
 * `sent` array. Throwing there unwinds into the driver's own error path, which
 * rejects whichever query the connection currently points at rather than the one
 * that offended, skips the Sync it would need to resynchronise, and leaves the
 * offending entry in `sent` so the next `ReadyForQuery` hands it the *following*
 * query's rows. Reproduced deterministically with three concurrent queries: the
 * innocent first query was rejected with the Date error, the actual offender
 * resolved successfully carrying the third query's result set, and the third got
 * a protocol error. The pool is `max: 5` under test and several services issue
 * nine queries in one `Promise.all`, so this was reachable, and a guard that
 * misattributes the failure and silently returns the wrong rows is worse than
 * the bug it was watching for.
 *
 * Drizzle's `logger.logQuery` runs in drizzle's own code before the driver is
 * called at all. Throwing there rejects exactly the call that made the mistake,
 * the query is never sent, and the connection state machine is never entered.
 *
 * As a side benefit it also avoids postgres.js's `debug` option flipping
 * `enumerable` on every query's parameters, which put argon2 hashes and session
 * token hashes into vitest failure output.
 *
 * Test-only, because production has no business discovering this at runtime: by
 * then the query has already failed. Note also that postgres.js on its own
 * handles a Date correctly (OID 1184, serialised with `toISOString()`); it is
 * specifically the drizzle path, where the parameter arrives untyped, that
 * breaks. The migration runner builds its own postgres.js client and is
 * untouched, which is right.
 */
const dateParameterGuard = {
  logQuery(query: string, params: unknown[]): void {
    const index = params.findIndex((value) => value instanceof Date);
    if (index === -1) return;

    throw new TypeError(
      `A Date reached the database as bind parameter $${index + 1}. Drizzle maps column ` +
        "values to strings before this point, so it came from a raw `sql` template, where " +
        "there is no column type to serialise it against and the driver throws. " +
        "Use `${value.toISOString()}::timestamptz`.\n\n" +
        `  ${query.replace(/\s+/g, " ").trim().slice(0, 200)}`
    );
  },
};

export const sql =
  globalThis.__tallySql ??
  postgres(connectionString, {
    // Eleven users on one droplet. A small pool bounds Postgres's memory and
    // backend count; the trade is that a burst queues client-side rather than
    // opening connections the server then has to feed.
    max: env.isTest ? 5 : 12,
    idle_timeout: 30,
    connect_timeout: 10,
    // Calendar days are strings in and strings out.
    //
    // `spent_on` is a date, not an instant. Letting the driver hand back a Date
    // would drag it through the server's timezone and move it by a day for
    // anyone east of UTC. A Date arriving on the way *in* is the same bug in
    // reverse, and rather than guess which midnight was meant, we refuse it:
    // the caller has a timezone and we do not.
    types: {
      date: {
        to: 1082,
        from: [1082],
        serialize: (v: unknown) => {
          if (typeof v === "string") return v;
          throw new TypeError(
            "A date column was given a Date. Calendar days must be passed as YYYY-MM-DD strings, " +
              "resolved in the owning user's timezone (see src/domain/calendar.ts)."
          );
        },
        parse: (v: string) => v,
      },
    },
    onnotice: env.isProduction ? () => {} : undefined,
  });

if (!env.isProduction) globalThis.__tallySql = sql;

/**
 * Closes the pool and clears the hot-reload stash.
 *
 * Clearing the stash is the part that matters: leaving a closed pool on
 * `globalThis` means the next module that imports this file picks it up and
 * every query fails with CONNECTION_ENDED. That bites the second test file in
 * a worker, not the first, which makes it a confusing failure to diagnose.
 */
export async function closePool(): Promise<void> {
  await sql.end({ timeout: 5 });
  globalThis.__tallySql = undefined;
}

export const db = drizzle(sql, {
  schema,
  casing: "snake_case",
  // See dateParameterGuard above. Only under test, and only ever throws.
  logger: env.isTest ? dateParameterGuard : undefined,
});

export type Database = typeof db;

/** A transaction handle. Services take `Ctx["db"]`, which is either of these. */
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Either a pool handle or an open transaction. Every query in the app takes this. */
export type Db = Database | Transaction;

export { schema };
