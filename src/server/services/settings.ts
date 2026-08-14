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
import { assertCan, type Ctx } from "@/server/ctx";
import * as s from "@/server/db/schema";
import { db } from "@/server/db/client";
import { notFound } from "@/server/errors";
import type { RoundingRule } from "@/domain/rounding";

const CACHE_TTL_MS = 5_000;

let cached: { at: number; row: s.SettingsRow } | null = null;

export async function getSettings(ctx?: Ctx): Promise<s.SettingsRow> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.row;

  const handle = ctx?.db ?? db;
  const [row] = await handle.select().from(s.settings).where(eq(s.settings.id, 1)).limit(1);
  if (!row) {
    throw notFound(
      "Account settings. The singleton row is missing; run pnpm db:migrate, which inserts it"
    );
  }

  cached = { at: now, row };
  return row;
}

/** Call after any write, so the next read does not serve the old row. */
export const invalidateSettings = () => {
  cached = null;
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

  invalidateSettings();

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
