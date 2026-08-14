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
 * Three concrete reasons, and one that was claimed and withdrawn.
 *
 *   1. `logQuery` runs in drizzle's own code before the driver is called, so
 *      throwing there rejects exactly the call that made the mistake and the
 *      query is never sent. Throwing from `debug` happens inside the driver's
 *      `build(q)`, after the query has been pushed onto the connection's `sent`
 *      array, which is a worse place to raise from on principle even where it
 *      is survivable.
 *   2. The message survives. Drizzle wraps a driver-phase throw in
 *      `DrizzleQueryError`, so the explanation this guard exists to give was
 *      buried; a `logQuery` throw is passed through intact.
 *   3. `debug` also flips `enumerable` on every query's parameters, which put
 *      argon2 hashes and session token hashes into vitest failure output.
 *
 * **Withdrawn:** an earlier version of this comment said the old placement
 * corrupted pipelined connections, rejecting the wrong query and handing one
 * query another's rows. That came from a reviewer's reproduction, and a second
 * reviewer could not reproduce it: restoring the old placement and running
 * eighteen concurrent queries against a five-connection pool produced zero
 * misattributions, zero crossed result sets, and a healthy connection
 * afterwards. It is left recorded rather than deleted because asserting an
 * unverified failure as established fact is the same drift this file's
 * neighbours were written to stop, and the reasons above stand without it.
 *
 * Test-only, because production has no business discovering this at runtime: by
 * then the query has already failed. Note also that postgres.js on its own
 * handles a Date correctly (OID 1184, serialised with `toISOString()`); it is
 * specifically the drizzle path, where the parameter arrives untyped, that
 * breaks. The migration runner builds its own postgres.js client and is
 * untouched, which is right.
 */
/**
 * A Date anywhere in the value, not just at the top.
 *
 * `params.findIndex(v => v instanceof Date)` missed `${{ at: cutoff }}`, which a
 * reviewer demonstrated passing both this guard and the static one and then
 * failing inside the driver exactly as the bare Date does. Bounded depth so a
 * cyclic or enormous parameter cannot turn the check into the problem.
 */
function containsDate(value: unknown, depth = 0): boolean {
  if (value instanceof Date) return true;
  if (depth >= 4 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => containsDate(item, depth + 1));
  return Object.values(value as Record<string, unknown>).some((item) => containsDate(item, depth + 1));
}

const dateParameterGuard = {
  logQuery(query: string, params: unknown[]): void {
    const index = params.findIndex((value) => containsDate(value));
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
