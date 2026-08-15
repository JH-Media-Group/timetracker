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

import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/server/db/client";
import * as s from "@/server/db/schema";
import { getSettings, invalidateSettings } from "@/server/services/settings";

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

beforeEach(async () => {
  await db.update(s.settings).set({ companyName: "Real Company" }).where(eq(s.settings.id, 1));
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

  it("serves the row a write left behind, once invalidated", async () => {
    await getSettings();
    await db.update(s.settings).set({ companyName: "Seen After Invalidation" }).where(eq(s.settings.id, 1));
    invalidateSettings();

    expect((await getSettings()).companyName).toBe("Seen After Invalidation");
  });
});
