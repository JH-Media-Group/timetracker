/**
 * The settings cache, and the one thing it promises.
 *
 * `settings` is a singleton row that almost every service reads, so it is held
 * for five seconds per process. The whole contract of that cache is the comment
 * on `invalidateSettings`: after a write, the next read does not serve the old
 * row. That is the property tested here, and it was not true.
 *
 * HOW IT WAS FOUND, BECAUSE IT IS THE USEFUL PART
 *
 * The suite failed thirteen tests in `invoice-reminders.test.ts` and then passed
 * six consecutive runs. The thirteen were every test that renders a message; the
 * six that passed were every test that returns before rendering. That split is
 * not random, and it pointed at one thing: the invoice templates a `beforeEach`
 * had just reset were still in force.
 *
 * The mechanism is a lost update on the cache rather than on the row. A read
 * misses, issues its SELECT, and while it is in flight a write commits and
 * invalidates. The read then resolves and stores what it fetched before the
 * write, so the invalidation is overwritten by data older than itself and the
 * pre-write row is served for another five seconds.
 *
 * In a test that is a confusing failure. In production it is an admin saving a
 * setting, seeing it saved, and the old value coming back.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/server/db/client";
import * as s from "@/server/db/schema";
import { createCtx, systemActor, withTransaction } from "@/server/ctx";
import { getSettings, invalidateSettings } from "@/server/services/settings";
import { newId } from "@/server/db/ids";
import { resetDb, seedProfiles, seedSettings } from "./helpers";

/** A Ctx whose only job is to hand `getSettings` a query we control the timing of. */
function gatedCtx(rows: s.SettingsRow[]) {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });

  const ctx = {
    db: {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => gate.then(() => rows),
          }),
        }),
      }),
    },
  } as never;

  return { ctx, release };
}

/*
  Seeds rather than assuming.

  The first version of this file only did the UPDATE, so it passed when some
  earlier file had left a settings row behind and failed 3/3 on a clean database
  with "the singleton row is missing". A file written to pin down an
  order-dependent flake had made itself order-dependent, which a reviewer
  pointed out inside a minute. It also left its last test's company name in the
  shared singleton for whatever ran next.
*/
/** A real user id, because `settings.updated_by` is a real foreign key. */
let actorId: string;

beforeEach(async () => {
  await resetDb();
  const profiles = await seedProfiles();
  await seedSettings({ companyName: "Real Company" });

  actorId = newId();
  await db.insert(s.users).values({
    id: actorId,
    email: `settings-cache-${actorId}@example.test`,
    firstName: "Settings",
    lastName: "Admin",
    profileId: profiles.administrator!,
  });

  invalidateSettings();
});

/*
  Let go of the actor on the way out.

  `updateSettings` stamps `settings.updated_by`, which is a real foreign key, so
  leaving it pointing at this file's user made the *next* file's cleanup fail:
  `auth-tokens` deletes users by email pattern and hit a constraint violation
  that had nothing to do with anything it was testing. Sixteen tests failed in a
  file that had not changed. Cleaning up the reference is cheaper than every
  other file having to know about this one.
*/
afterEach(async () => {
  await db.update(s.settings).set({ updatedBy: null }).where(eq(s.settings.id, 1));
  invalidateSettings();
});

describe("invalidateSettings", () => {
  it("is not undone by a read that was already in flight", async () => {
    /*
      The ordering that broke it, forced rather than waited for:

        1. a read misses the cache and issues its query
        2. a write commits and invalidates
        3. the read resolves, holding the pre-write row

      Step 3 must not repopulate the cache. The read may return what it fetched
      (it asked before the write, and that answer was true when it asked); it
      must not answer for anybody else.
    */
    const stale = { ...(await getSettings()), companyName: "Stale Company" } as s.SettingsRow;
    invalidateSettings();

    const { ctx, release } = gatedCtx([stale]);
    const inFlight = getSettings(ctx);

    // The write happens while that read is outstanding.
    await db.update(s.settings).set({ companyName: "Written While Reading" }).where(eq(s.settings.id, 1));
    invalidateSettings();

    release();
    expect((await inFlight).companyName, "the read returns what it fetched").toBe("Stale Company");

    const next = await getSettings();
    expect(next.companyName, "but the next reader must see the write").toBe("Written While Reading");
  });

  it("still caches a read that nothing interrupted", async () => {
    // The guard must not turn the cache off. If it did, the bug would be
    // "fixed" by making every service read the row on every call, and nothing
    // here would notice.
    await getSettings();
    await db.update(s.settings).set({ companyName: "Changed Behind The Cache" }).where(eq(s.settings.id, 1));

    expect((await getSettings()).companyName, "an uninvalidated write is not meant to be seen").toBe(
      "Real Company"
    );
  });

  it("does not publish a row read inside a transaction that then rolled back", async () => {
    /*
      The worst of the three, because the value it publishes never existed.

      `withTransaction` joins an open transaction rather than opening a second
      one, so a service that writes settings and then reads them back is reading
      its own uncommitted write, on the request's transaction handle, into a
      cache the whole process shares. `updateInvoiceConfig` does exactly that.
      If the request then fails, the row rolls back correctly and the cache
      keeps the phantom for the full five seconds, handing it to every unrelated
      request, `roundingMinutes` and `roundingMode` included.
    */
    await getSettings();
    invalidateSettings();

    await expect(
      db.transaction(async (tx) => {
        await tx.update(s.settings).set({ companyName: "Rolled Back Co" }).where(eq(s.settings.id, 1));

        const ctx = createCtx({ actor: systemActor(), db: tx });
        const seen = await getSettings(ctx);
        expect(seen.companyName, "its own write, which is what it asked for").toBe("Rolled Back Co");

        throw new Error("something later in the request failed");
      })
    ).rejects.toThrow(/something later/);

    const [row] = await db.select().from(s.settings).where(eq(s.settings.id, 1));
    expect(row!.companyName, "the database rolled back, as it should").toBe("Real Company");
    expect((await getSettings()).companyName, "and so must the cache").toBe("Real Company");
  });

  it("is invalidated after the write commits, not before", async () => {
    /*
      The wider window, and the one ordinary traffic hits.

      `updateSettings` used to invalidate inline, one or two round trips before
      COMMIT. A concurrent reader misses the cache, reads the pre-write row on a
      different pooled connection (it cannot see an uncommitted write), and
      caches it after the invalidation has already happened. The write then
      commits into a cache holding the value it replaced, and every reader in
      the process gets the old value for five seconds. That is precisely the
      "admin saves a setting and the old value comes back" symptom.

      The reader here is forced to land inside the window rather than raced for.
    */
    const { updateSettings } = await import("@/server/services/settings");

    // Through withTransaction, because that is what owns the after-commit
    // drain. A hand-rolled db.transaction would leave the callback queued and
    // the test would fail for a reason that has nothing to do with the bug.
    await withTransaction(createCtx({ actor: systemActor(actorId), db }), async (tx) => {
      await updateSettings(tx, { companyName: "Saved By The Admin" });

      // A concurrent request, on its own pooled connection, while the write is
      // still uncommitted. Without the after-commit hook this poisons the cache
      // with the row the write is in the middle of replacing.
      const seen = await getSettings();
      expect(seen.companyName, "it cannot see an uncommitted write").toBe("Real Company");
    });

    expect((await getSettings()).companyName, "the next reader must see the write").toBe(
      "Saved By The Admin"
    );
  });

  it("serves the row a write left behind, once invalidated", async () => {
    await getSettings();
    await db.update(s.settings).set({ companyName: "Seen After Invalidation" }).where(eq(s.settings.id, 1));
    invalidateSettings();

    expect((await getSettings()).companyName).toBe("Seen After Invalidation");
  });
});
