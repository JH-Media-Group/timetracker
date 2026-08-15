/**
 * Account settings.
 *
 * A singleton row. Almost every other service reads it, for rounding, the
 * account timezone, the week start, or the invoice sequence, so it is cached
 * for a few seconds per process: eleven users generate a lot of reads of a row
 * that changes once a quarter.
 *
 * The cache is deliberately short and deliberately not invalidated across
 * processes. There is one process; if that stops being true, the fix is to drop
 * the TTL to zero, not to build a cache-invalidation protocol.
 */

import { eq } from "drizzle-orm";
import { assertCan, runAfterCommit, type Ctx } from "@/server/ctx";
import * as s from "@/server/db/schema";
import { db } from "@/server/db/client";
import { notFound } from "@/server/errors";
import type { RoundingRule } from "@/domain/rounding";

const CACHE_TTL_MS = 5_000;

let cached: { at: number; row: s.SettingsRow } | null = null;

/**
 * Bumped by every invalidation, so a read can tell whether one happened while
 * it was in flight.
 *
 * Without it, `invalidateSettings()` was losable, and the way it lost was
 * ordinary: a read misses the cache and issues its SELECT, a write commits and
 * invalidates, and then the read resolves and stores the row it fetched *before*
 * the write. The invalidation is overwritten by data older than itself, and the
 * pre-write settings are then served for a further five seconds. The comment on
 * `invalidateSettings` said "so the next read does not serve the old row", and
 * that was the one thing it could not guarantee.
 *
 * It was found through a test suite that failed thirteen tests and then passed
 * six runs in a row. A `beforeEach` reset the invoice templates and invalidated,
 * an earlier test's read landed after it, and every test that rendered a message
 * spent the next five seconds rendering from a template that was supposed to be
 * gone. In production the same shape means an admin saves a setting and requests
 * already in flight put the old value back.
 */
let generation = 0;

export async function getSettings(ctx?: Ctx): Promise<s.SettingsRow> {
  const now = Date.now();
  const handle = ctx?.db ?? db;

  /*
    The cache belongs to the pool, and a transaction that has written settings
    stops reading it.

    **Never written from a transaction**, because a transactional read can see
    uncommitted data and this cache is process-wide.

    **Not read by a transaction that wrote settings**, because that caller can
    see further than the cache can. This half was missing and the effect was
    visible: `updateInvoiceConfig` wrote the row and then returned
    `getInvoiceConfig(ctx)`, whose comment says it must return what the request
    just wrote, and on the real route path it returned the values from *before*
    the write, because a GET moments earlier had warmed the cache and the
    invalidation now waits for the commit. The tests missed it because they pass
    a pool-backed Ctx, where `withTransaction` opens and commits its own
    transaction before the read.

    **Every other transactional read still uses the cache**, and the first fix
    for the above did not, which was a poor trade nobody asked for: every
    mutating request runs in a transaction, so `copyDay` went from zero settings
    queries to two per copied entry and `upsertWeek` to roughly `2N + 2`. A
    reviewer counted them. A transaction that has not touched settings cannot
    see anything the pool cannot, so there is nothing to be gained by making it
    ask again.
  */
  const transactional = handle !== db;
  const seesFurther = transactional && ctx?._buffers?.settingsWritten === true;
  if (!seesFurther && cached && now - cached.at < CACHE_TTL_MS) return cached.row;

  const startedAt = generation;
  const [row] = await handle.select().from(s.settings).where(eq(s.settings.id, 1)).limit(1);
  if (!row) {
    throw notFound(
      "Account settings. The singleton row is missing; run pnpm db:migrate, which inserts it"
    );
  }

  /*
    Two conditions, and each closes a different hole.

    **Never from a transaction**, for the reason above: a transactional read can
    see uncommitted data, and this cache is process-wide. `updateInvoiceConfig`
    writes the settings row and reads it straight back on the request's
    transaction, so caching that would publish a row to every other request that
    a rollback could then erase, the rounding rule money math runs on included.
    A reviewer reproduced it: the row rolled back correctly and the cache kept
    the phantom for five seconds.

    **No invalidation while the read was in flight.** A read that misses, issues
    its SELECT, and resolves after a write has invalidated would otherwise put
    the pre-write row back and serve it for the full TTL.

    Neither covers the third case, a write that invalidates before it commits,
    because that is not fixable here. It is fixed by invalidating from an
    after-commit callback. See `runAfterCommit` in ctx.ts.

    `at` is the timestamp from before the query, not after, so a slow read
    produces an entry that expires sooner rather than later.
  */
  if (!transactional && generation === startedAt) cached = { at: now, row };
  return row;
}

/** Call after any write, so the next read does not serve the old row. */
export const invalidateSettings = () => {
  cached = null;
  generation++;
};

export async function updateSettings(ctx: Ctx, patch: Partial<s.SettingsRow>) {
  assertCan(ctx, "settings:manage");

  const before = await getSettings(ctx);

  // Whitelist. Spreading the request body would let a caller set `id` or
  // `invoiceNextSeq`, and the second one would quietly reissue invoice numbers.
  const allowed: (keyof s.SettingsRow)[] = [
    "companyName",
    "companyAddress",
    "logoKey",
    "taxId",
    "baseCurrency",
    "timezone",
    "weekStartsOn",
    "fiscalYearStartMonth",
    "timerMode",
    "timeDisplay",
    "roundingMinutes",
    "roundingMode",
    "requireNotes",
    "allowFutureDates",
    "flagMissingBelowSeconds",
    "lockTimesheetsAfterDays",
    "projectNotesVisibility",
    "modules",
    "invoiceDefaults",
    "invoiceAppearance",
    "invoiceMessages",
    "invoiceFieldLabels",
    "invoiceNumberPattern",
  ];

  const update: Record<string, unknown> = { updatedAt: ctx.now(), updatedBy: ctx.actor.userId };
  for (const key of allowed) {
    if (key in patch) update[key] = patch[key];
  }

  const [after] = await ctx.db
    .update(s.settings)
    .set(update as never)
    .where(eq(s.settings.id, 1))
    .returning();

  /*
    This transaction can now see something the cache cannot, so its own reads
    must stop using it. Set before the audit below, which reads settings.
  */
  ctx._buffers.settingsWritten = true;

  /*
    After the commit, not here.

    Inline, this fired one or two round trips before COMMIT, which left a window
    that ordinary traffic hits: a concurrent reader misses the cache, reads the
    pre-write row on a different pooled connection (it cannot see an uncommitted
    write), and stores it *after* this invalidation. The write then commits into
    a cache holding the value it replaced. `invalidateSettings` promises "the
    next read does not serve the old row", and inline invalidation could not
    keep that promise no matter how the read side was written.
  */
  runAfterCommit(ctx, invalidateSettings);

  ctx.audit({
    action: "settings.update",
    entityType: "settings",
    entityId: null,
    entityLabel: "Account settings",
    before,
    after,
  });

  return after!;
}

/* ------------------------------------------------------------- shorthands */

export async function roundingRule(ctx?: Ctx): Promise<RoundingRule> {
  const settings = await getSettings(ctx);
  return {
    minutes: settings.roundingMinutes,
    mode: settings.roundingMode as RoundingRule["mode"],
  };
}

export async function weekStartsOn(ctx?: Ctx): Promise<number> {
  return (await getSettings(ctx)).weekStartsOn;
}

/** The ACCOUNT timezone, for cron boundaries and monthly budget resets. Not a person's. */
export async function accountTimezone(ctx?: Ctx): Promise<string> {
  return (await getSettings(ctx)).timezone;
}

/** Whether a module is switched on. Absent means on. */
export async function moduleEnabled(key: string, ctx?: Ctx): Promise<boolean> {
  const modules = (await getSettings(ctx)).modules as Record<string, boolean>;
  return modules?.[key] !== false;
}
