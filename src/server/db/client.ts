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
 * Under test, a Date that reaches the driver as a bind parameter is a bug.
 *
 * Drizzle's column mappers turn a Date into a string long before it gets here,
 * so a Date arriving as a parameter means it went in through a raw `sql`
 * template, where it has no column to be typed by. The driver then tries to
 * serialise an object as text and throws `ERR_INVALID_ARG_TYPE` at whatever
 * moment that line happens to run. That bug has been written four times, and
 * three of the four hid in code that runs rarely: a timer stop, a nightly
 * purge, an hourly session touch.
 *
 * `tests/sql-literals.test.ts` catches this statically, including in code no
 * test ever executes, which is where two of the four lived. This is the other
 * half: any query a test actually runs is checked no matter how the value got
 * into the template, so the two together cover both the unreached and the
 * unwritten. Neither subsumes the other.
 *
 * Test-only because it costs a scan of every parameter list on every query, and
 * because production has no business discovering this at runtime: by then the
 * query has already failed.
 *
 * Scope, precisely. postgres.js on its own does handle a Date: it infers OID
 * 1184 and serialises with `toISOString()`. This hook is on the pool drizzle
 * uses, and everything that reaches it has been through drizzle, where a Date
 * arrives as an untyped bind parameter with no column to be inferred from and
 * the driver throws. The migration runner builds its own postgres.js client
 * (`migrate.ts`) and is untouched by this, which is correct: there a Date is
 * genuinely fine.
 */
function refuseDateParameters(_connection: number, query: string, parameters: unknown[]): void {
  const index = parameters.findIndex((value) => value instanceof Date);
  if (index === -1) return;

  throw new TypeError(
    `A Date reached the driver as bind parameter $${index + 1}. Drizzle maps column ` +
      "values to strings before they get here, so this came from a raw `sql` template, " +
      "where the driver has no column type to serialise it against and throws. " +
      "Use `${value.toISOString()}::timestamptz`.\n\n" +
      `  ${query.replace(/\s+/g, " ").trim().slice(0, 200)}`
  );
}

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
    debug: env.isTest ? refuseDateParameters : undefined,
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

export const db = drizzle(sql, { schema, casing: "snake_case" });

export type Database = typeof db;

/** A transaction handle. Services take `Ctx["db"]`, which is either of these. */
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Either a pool handle or an open transaction. Every query in the app takes this. */
export type Db = Database | Transaction;

export { schema };
