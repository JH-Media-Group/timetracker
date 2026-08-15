/**
 * Effects that must wait for a commit.
 *
 * `runAfterCommit` exists because a side effect outside the database cannot be
 * rolled back. The settings cache is the case that drove it: invalidating next
 * to the write fires one or two round trips before COMMIT, so a concurrent
 * reader can put the pre-write row back and serve it for the full cache TTL.
 *
 * This machinery sits on the path of every mutating request, which is the whole
 * reason to test it directly rather than through the one caller that uses it.
 * The first version was scoped to the `Ctx` rather than to the transaction, and
 * a reviewer showed what that costs: a Ctx outlives any single transaction, so
 * two overlapping calls shared one queue and each could run or discard the
 * other's callbacks.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/server/db/client";
import * as s from "@/server/db/schema";
import { createCtx, runAfterCommit, systemActor, withTransaction } from "@/server/ctx";
import { resetDb, seedProfiles, seedSettings } from "./helpers";

const ctxOn = (handle = db) => createCtx({ actor: systemActor(), db: handle });

beforeEach(async () => {
  await resetDb();
  await seedProfiles();
  await seedSettings();
});

describe("runAfterCommit", () => {
  it("runs the effect after the COMMIT, not merely after the callback returns", async () => {
    /*
      Asserting "it did not run inside `fn`" is too weak: it survives moving the
      drain to the last line of the transaction callback, which is still before
      Postgres commits. So the effect asks a **different connection** whether it
      can see the write. Only a real commit makes that true.
    */
    const ctx = ctxOn();
    const marker = `committed-${Date.now()}`;

    /*
      The read is started **inside the effect**, on the pool.

      An earlier version of this test only recorded that the effect had run and
      did the cross-connection read afterwards, in the test body. A reviewer
      pointed out that proves nothing: by then `withTransaction` has returned,
      so the write is visible no matter where the drain sits, and moving the
      drain to just before COMMIT kept every assertion green. Asking from the
      effect itself is what makes COMMIT the thing being tested, because a pool
      connection reading an uncommitted UPDATE sees the old value rather than
      blocking.
    */
    let visibleToOthers: Promise<string | undefined> | null = null;

    await withTransaction(ctx, async (tx) => {
      await tx.db.update(s.settings).set({ companyName: marker }).where(eq(s.settings.id, 1));

      runAfterCommit(tx, () => {
        visibleToOthers = db
          .select({ name: s.settings.companyName })
          .from(s.settings)
          .then((rows) => rows[0]?.name);
      });

      const [outside] = await db.select({ name: s.settings.companyName }).from(s.settings);
      expect(outside!.name, "another connection cannot see it yet").not.toBe(marker);
      expect(visibleToOthers, "and the effect has not run").toBeNull();
    });

    expect(visibleToOthers, "the effect ran").not.toBeNull();
    expect(await visibleToOthers!, "and when it ran, the commit had happened").toBe(marker);
  });

  it("does not run the effect when the transaction rolls back", async () => {
    const ran: string[] = [];
    const ctx = ctxOn();

    await expect(
      withTransaction(ctx, async (tx) => {
        runAfterCommit(tx, () => ran.push("effect"));
        throw new Error("the handler failed");
      })
    ).rejects.toThrow(/the handler failed/);

    expect(ran).toEqual([]);
  });

  it("does not carry a discarded effect into the next transaction on the same Ctx", async () => {
    /*
      Jobs reuse one Ctx across a loop, so this is the ordinary shape, not a
      corner. With the queue held on the Ctx, the failed transaction's callback
      stayed in the array and fired on the next unrelated commit.
    */
    const ran: string[] = [];
    const ctx = ctxOn();

    await expect(
      withTransaction(ctx, async (tx) => {
        runAfterCommit(tx, () => ran.push("from the failed one"));
        throw new Error("no");
      })
    ).rejects.toThrow();

    await withTransaction(ctx, async (tx) => {
      runAfterCommit(tx, () => ran.push("from the good one"));
      await tx.db.select({ id: s.settings.id }).from(s.settings).limit(1);
    });

    expect(ran).toEqual(["from the good one"]);
  });

  it("keeps two overlapping transactions on the same Ctx out of each other's way", async () => {
    /*
      The finding that made the queue transaction-scoped.

      One Ctx, two transactions open at once, which a job doing concurrent work
      produces without trying. Sharing one array meant the first to finish
      drained or discarded the other's callbacks: a rollback in B could throw
      away A's committed effect, and a commit in A could fire B's effect while B
      was still open and might yet roll back.
    */
    const ran: string[] = [];
    const ctx = ctxOn();

    let releaseA!: () => void;
    const aMayFinish = new Promise<void>((r) => {
      releaseA = r;
    });

    const a = withTransaction(ctx, async (tx) => {
      runAfterCommit(tx, () => ran.push("a"));
      await aMayFinish;
    });

    const b = withTransaction(ctx, async (tx) => {
      runAfterCommit(tx, () => ran.push("b"));
      throw new Error("b fails");
    });

    await expect(b).rejects.toThrow(/b fails/);
    expect(ran, "B's rollback must not have run or eaten A's effect").toEqual([]);

    releaseA();
    await a;
    expect(ran, "A committed, so A's effect runs, and only A's").toEqual(["a"]);
  });

  it("keeps one transaction's audit rows out of another's rollback", async () => {
    /*
      The defect the overlapping-callbacks test above could not see, because it
      only registered callbacks.

      Audit rows and outbox events used to live on the Ctx too, and the fix for
      the callback bug added a wholesale `discardBuffers(ctx)` on the rollback
      path. On one reused Ctx with two transactions open, B's rollback then
      emptied A's pending audit rows, and A committed its business write with no
      audit row and no outbox event: the write happens, the log does not mention
      it, and nothing anywhere reports a problem. A reviewer traced it.

      Scoping all three buffers to the transaction is what makes this hold.
    */
    const ctx = ctxOn();
    const action = `isolated.${Date.now()}`;

    let releaseA!: () => void;
    const aMayFinish = new Promise<void>((r) => {
      releaseA = r;
    });

    const a = withTransaction(ctx, async (tx) => {
      tx.audit({ action, entityType: "settings", entityId: null });
      await aMayFinish;
    });

    const b = withTransaction(ctx, async (tx) => {
      tx.audit({ action: "should.never.be.written", entityType: "settings", entityId: null });
      throw new Error("b fails");
    });

    await expect(b).rejects.toThrow(/b fails/);
    releaseA();
    await a;

    const rows = await db.select().from(s.auditLog);
    const actions = rows.map((r) => r.action);
    expect(actions, "A committed, so A's audit row must exist").toContain(action);
    expect(actions, "B rolled back, so B's must not").not.toContain("should.never.be.written");
  });

  it("writes an audit row buffered before the transaction opened", async () => {
    /*
      Scoping the buffers to the transaction isolates them, and taken literally
      it also orphans anything the caller buffered first: `ctx.audit(...)` and
      then `withTransaction(ctx, ...)` wrote the row before that change and
      dropped it silently after. No caller does this today, which is exactly
      when a silent drop is cheapest to close and hardest to notice later.
    */
    const ctx = ctxOn();
    const action = `buffered.before.${Date.now()}`;

    ctx.audit({ action, entityType: "settings", entityId: null });

    await withTransaction(ctx, async (tx) => {
      await tx.db.select({ id: s.settings.id }).from(s.settings).limit(1);
    });

    const rows = await db.select().from(s.auditLog);
    expect(rows.map((r) => r.action)).toContain(action);
  });

  it("runs outside a transaction immediately, because there is nothing to wait for", async () => {
    const ran: string[] = [];
    runAfterCommit(ctxOn(), () => ran.push("effect"));
    expect(ran).toEqual(["effect"]);
  });

  it("runs every effect even when one throws, and lets none of it reach the caller", async () => {
    /*
      By this point the database has committed. An effect that fails must not
      turn a successful mutation into an error response, and must not stop the
      effects queued behind it. The first version spliced the queue and let the
      throw escape, so it did both.
    */
    const ran: string[] = [];
    const ctx = ctxOn();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await withTransaction(ctx, async (tx) => {
        runAfterCommit(tx, () => {
          // Recorded before throwing, or the test cannot tell "ran and failed"
          // from "was skipped", and an implementation that quietly dropped the
          // first callback would pass. A reviewer pointed that out.
          ran.push("first");
          throw new Error("this effect is broken");
        });
        runAfterCommit(tx, () => ran.push("second"));
        await tx.db.select({ id: s.settings.id }).from(s.settings).limit(1);
      });

      expect(ran, "both ran, in order, despite the first throwing").toEqual(["first", "second"]);
      expect(logged, "swallowed silently is not swallowed safely").toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  it("fires an effect registered by a joined inner call, once, at the outer commit", async () => {
    // `withTransaction` joins rather than nesting, so an inner service call
    // registering an effect must not run it when the inner call returns.
    const ran: string[] = [];
    const ctx = ctxOn();

    await withTransaction(ctx, async (outer) => {
      await withTransaction(outer, async (inner) => {
        runAfterCommit(inner, () => ran.push("inner"));
      });
      expect(ran, "the inner call returned, but nothing has committed").toEqual([]);
      await outer.db.select({ id: s.settings.id }).from(s.settings).limit(1);
    });

    expect(ran).toEqual(["inner"]);
  });

  it("still writes the audit rows the transaction buffered", async () => {
    // The scoped queue is a new object spread from `_buffers`. If that spread
    // had copied `audits` by value instead of by reference, auditing would have
    // quietly stopped, which is the sort of thing this repo has done before.
    const ctx = ctxOn();

    await withTransaction(ctx, async (tx) => {
      tx.audit({ action: "settings.update", entityType: "settings", entityId: null });
      await tx.db.select({ id: s.settings.id }).from(s.settings).limit(1);
    });

    const rows = await db.select().from(s.auditLog).where(eq(s.auditLog.action, "settings.update"));
    expect(rows).toHaveLength(1);
  });
});
