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

export const sql =
  globalThis.__tallySql ??
  postgres(connectionString, {
    // Eleven users on one droplet. A small pool keeps Postgres's memory
    // predictable and makes connection exhaustion impossible to reach.
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

export const db = drizzle(sql, { schema, casing: "snake_case" });

export type Database = typeof db;

/** A transaction handle. Services take `Ctx["db"]`, which is either of these. */
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Either a pool handle or an open transaction. Every query in the app takes this. */
export type Db = Database | Transaction;

export { schema };
