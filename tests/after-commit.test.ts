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

import { beforeEach, describe, expect, it } from "vitest";
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
  it("runs the effect once the transaction commits, and not before", async () => {
    const ran: string[] = [];
    const ctx = ctxOn();

    await withTransaction(ctx, async (tx) => {
      runAfterCommit(tx, () => ran.push("effect"));
      await tx.db.select({ id: s.settings.id }).from(s.settings).limit(1);
      expect(ran, "still inside the transaction").toEqual([]);
    });

    expect(ran).toEqual(["effect"]);
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

    await withTransaction(ctx, async (tx) => {
      runAfterCommit(tx, () => {
        throw new Error("this effect is broken");
      });
      runAfterCommit(tx, () => ran.push("second"));
      await tx.db.select({ id: s.settings.id }).from(s.settings).limit(1);
    });

    expect(ran, "the one behind the failure still ran").toEqual(["second"]);
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
