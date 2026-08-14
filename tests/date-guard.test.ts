/**
 * The runtime half of the Date-in-sql guard, and the concurrency bug it had.
 *
 * The guard used to throw from inside postgres.js's `debug` callback. That
 * fires within `build(q)`, after the query has been pushed onto the
 * connection's `sent` array, so throwing unwound into the driver's own error
 * path: it rejected whichever query the connection currently pointed at rather
 * than the offending one, skipped the Sync needed to resynchronise, and left
 * the offender in `sent` so the next `ReadyForQuery` handed it the following
 * query's rows.
 *
 * A reviewer reproduced that deterministically: three concurrent queries with a
 * Date in the middle one, and the innocent first query was rejected with the
 * Date error while the actual offender resolved carrying the third query's
 * result set. A guard that blames the wrong line and silently returns the wrong
 * rows is worse than the bug it watches for.
 *
 * It now lives in drizzle's `logger.logQuery`, which runs before the driver is
 * called at all. These tests exist so it cannot drift back: the first two prove
 * it still catches the bug, and the third is the concurrency case that failed.
 */

import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "@/server/db/client";
import * as s from "@/server/db/schema";

describe("the Date bind-parameter guard", () => {
  it("refuses a Date interpolated into a raw sql template", async () => {
    const cutoff = new Date();

    await expect(
      db.select().from(s.sessions).where(sql`${s.sessions.expiresAt} < ${cutoff}`)
    ).rejects.toThrow(/A Date reached the database as bind parameter/);
  });

  /**
   * The shape the type checker cannot see.
   *
   * `tests/sql-literals.test.ts` asks the compiler, and the compiler does not
   * know what an `any` holds either. This half does not care about types, which
   * is the whole reason both exist.
   */
  it("refuses a Date the type checker could not have seen", async () => {
    const untyped: any = new Date();

    await expect(
      db.select().from(s.sessions).where(sql`${s.sessions.expiresAt} < ${untyped}`)
    ).rejects.toThrow(/A Date reached the database as bind parameter/);
  });

  it("leaves correct queries alone", async () => {
    const cutoff = new Date();

    await expect(
      db
        .select()
        .from(s.sessions)
        .where(sql`${s.sessions.expiresAt} < ${cutoff.toISOString()}::timestamptz`)
    ).resolves.toBeInstanceOf(Array);
  });

  /**
   * The regression that sent this guard back to the drawing board.
   *
   * Under the old placement the rejection landed on the wrong promise and one
   * of the innocent queries resolved with another query's rows. Every
   * assertion here is about attribution: the offender fails, and the queries
   * around it are untouched and correct.
   */
  it("blames the right query when several run at once", async () => {
    const offender = new Date();

    const results = await Promise.allSettled([
      db.select({ id: s.users.id }).from(s.users).limit(1),
      db.select().from(s.sessions).where(sql`${s.sessions.expiresAt} < ${offender}`),
      db.execute(sql`select 'third'::text as tag`),
      db.select({ id: s.clients.id }).from(s.clients).limit(1),
    ]);

    expect(results[0]!.status, "an innocent query must not be blamed").toBe("fulfilled");
    expect(results[1]!.status, "the query holding the Date must be the one that fails").toBe("rejected");
    expect(results[3]!.status, "an innocent query must not be blamed").toBe("fulfilled");

    if (results[1]!.status === "rejected") {
      expect(String(results[1]!.reason)).toMatch(/A Date reached the database as bind parameter/);
    }

    // And the survivor's rows have to be its own, not the offender's.
    expect(results[2]!.status).toBe("fulfilled");
    if (results[2]!.status === "fulfilled") {
      const rows = results[2]!.value as unknown as { tag: string }[];
      expect(rows[0]?.tag, "a query resolved with another query's result set").toBe("third");
    }
  });

  /** The connection has to be usable afterwards, not left mid-protocol. */
  it("leaves the connection healthy", async () => {
    const rows = (await db.execute(sql`select 1::int as ok`)) as unknown as { ok: number }[];
    expect(rows[0]?.ok).toBe(1);

    // A real query through the ORM, not just a literal, to exercise the pool.
    await expect(
      db
        .select({ id: s.users.id })
        .from(s.users)
        .where(and(eq(s.users.archivedAt, sql`null`)))
        .limit(1)
    ).resolves.toBeInstanceOf(Array);
  });
});
