/**
 * Invoice configuration.
 *
 * The settings row already had four jsonb columns for this, plus the numbering
 * pattern and sequence. They were written by the settings API and read by
 * nothing: TALLY-33's whole point is that storage which is designed and never
 * connected is worse than storage that does not exist, because a screen offers
 * a promise the invoice does not keep.
 *
 * So every section here lands with its consumer, and
 * `tests/invoice-config.test.ts` asserts the value moved rather than that the
 * code path ran. `tests/settings-consumed.test.ts` is the structural version of
 * the same rule and is the part that outlives this epic.
 *
 * Reading is `settings:view`-free: the invoice document needs the labels, and a
 * person who may see an invoice may see what its columns are called. Writing is
 * `settings:manage` throughout.
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { assertCan, runAfterCommit, withTransaction, type Ctx } from "@/server/ctx";
import * as s from "@/server/db/schema";
import { validationFailed } from "@/server/errors";
import {
  resolveAppearance, resolveDefaults, resolveLabels, resolveMessages, ROUNDING_MINUTES,
  type FieldLabels, type InvoiceAppearance, type InvoiceDefaults, type InvoiceMessages,
} from "@/domain/invoice-config";
import { renderInvoiceNumber } from "@/domain/invoices";
import { getSettings, invalidateSettings } from "./settings";

export interface InvoiceConfig {
  company: { name: string; address: string | null; taxId: string | null };
  defaults: InvoiceDefaults;
  /** The account rounding rule, which this screen edits and reports also read. */
  rounding: { minutes: number; mode: string };
  appearance: InvoiceAppearance;
  messages: InvoiceMessages;
  labels: FieldLabels;
  numbering: { pattern: string; nextSeq: number; example: string };
}

/**
 * The whole configuration, resolved.
 *
 * One read rather than six, because the screen shows a left nav over all of it
 * and the document needs the labels on every render. The settings row is cached
 * for a few seconds in `settings.ts`, so this is close to free.
 */
export async function getInvoiceConfig(ctx: Ctx): Promise<InvoiceConfig> {
  const row = await getSettings(ctx);

  return {
    company: {
      name: row.companyName,
      address: row.companyAddress,
      taxId: row.taxId,
    },
    defaults: resolveDefaults(row.invoiceDefaults),
    rounding: { minutes: row.roundingMinutes, mode: row.roundingMode },
    appearance: resolveAppearance(row.invoiceAppearance),
    messages: resolveMessages(row.invoiceMessages),
    labels: resolveLabels(row.invoiceFieldLabels),
    numbering: {
      pattern: row.invoiceNumberPattern,
      nextSeq: row.invoiceNextSeq,
      example: exampleNumber(row.invoiceNumberPattern, row.invoiceNextSeq),
    },
  };
}

/** What the next invoice would be numbered, for the live example on the screen. */
export function exampleNumber(pattern: string, seq: number): string {
  const today = new Date().toISOString().slice(0, 10);
  return renderInvoiceNumber(pattern, {
    seq,
    issueDate: today,
    clientCode: "ACME",
    projectCode: "WEB",
    clientPrefix: null,
  });
}

export type ConfigPatch =
  | { section: "company"; value: { name: string; address?: string | null; taxId?: string | null } }
  | {
      section: "defaults";
      value: Partial<InvoiceDefaults> & { roundingMinutes?: number; roundingMode?: string };
    }
  | { section: "appearance"; value: Partial<InvoiceAppearance> }
  | { section: "messages"; value: Partial<InvoiceMessages> }
  | { section: "labels"; value: Partial<FieldLabels> }
  | { section: "numbering"; value: { pattern?: string; nextSeq?: number } };

/**
 * Write one section.
 *
 * Section at a time rather than a whole-object PATCH, so two people editing
 * different sections cannot overwrite each other's, and so the audit row says
 * which part of the configuration changed.
 */
export async function updateInvoiceConfig(ctx: Ctx, patch: ConfigPatch): Promise<InvoiceConfig> {
  assertCan(ctx, "settings:manage");

  await withTransaction(ctx, async (tx) => {
    const before = await getSettings(tx);
    const update: Record<string, unknown> = { updatedAt: tx.now(), updatedBy: tx.actor.userId };

    switch (patch.section) {
      case "company": {
        const name = patch.value.name?.trim() ?? "";
        if (!name) throw validationFailed({ name: ["The company name appears on every invoice."] });
        update.companyName = name;
        update.companyAddress = patch.value.address?.trim() || null;
        update.taxId = patch.value.taxId?.trim() || null;
        break;
      }

      case "defaults": {
        const { roundingMinutes, roundingMode, ...rest } = patch.value;

        // Rounding lives in its own columns, not in the jsonb, because the
        // summary reports already read it from there. One rule, two consumers.
        if (roundingMinutes !== undefined) {
          if (!(ROUNDING_MINUTES as readonly number[]).includes(roundingMinutes)) {
            throw validationFailed({ roundingMinutes: ["That is not a rounding increment."] });
          }
          update.roundingMinutes = roundingMinutes;
        }
        if (roundingMode !== undefined) update.roundingMode = roundingMode;

        update.invoiceDefaults = resolveDefaults({
          ...resolveDefaults(before.invoiceDefaults),
          ...rest,
        });
        break;
      }

      case "appearance":
        update.invoiceAppearance = resolveAppearance({
          ...resolveAppearance(before.invoiceAppearance),
          ...patch.value,
        });
        break;

      case "messages":
        update.invoiceMessages = resolveMessages({
          ...resolveMessages(before.invoiceMessages),
          ...patch.value,
        });
        break;

      case "labels": {
        // Only what differs from the default is stored, so a later change to a
        // default reaches an account that never overrode it. An empty string is
        // kept out for the same reason: it means "use the default".
        const merged = { ...((before.invoiceFieldLabels ?? {}) as Record<string, string>) };
        for (const [key, value] of Object.entries(patch.value)) {
          if (typeof value === "string" && value.trim() !== "") merged[key] = value;
          else delete merged[key];
        }
        update.invoiceFieldLabels = resolveOverrides(merged);
        break;
      }

      case "numbering": {
        if (patch.value.pattern !== undefined) {
          const pattern = patch.value.pattern.trim();
          if (!pattern) throw validationFailed({ pattern: ["A pattern is needed."] });
          if (!pattern.includes("{seq")) {
            throw validationFailed({
              pattern: ["A pattern without {seq} would give every invoice the same number."],
            });
          }
          update.invoiceNumberPattern = pattern;
        }

        if (patch.value.nextSeq !== undefined) {
          await assertSequenceIsFree(tx, patch.value.nextSeq, before);
          update.invoiceNextSeq = patch.value.nextSeq;
        }
        break;
      }
    }

    await tx.db.update(s.settings).set(update as never).where(eq(s.settings.id, 1));
    runAfterCommit(tx, invalidateSettings);

    tx.audit({
      action: `settings.invoice_${patch.section}.update`,
      entityType: "settings",
      entityId: null,
      entityLabel: `Invoice configuration: ${patch.section}`,
      before,
      after: update,
    });
  });

  /*
    No second invalidation here, and no reading back through `ctx`.

    Both were wrong for the same reason: `withTransaction` *joins* an existing
    transaction, so in the route path this line and the one inside the callback
    are both still inside the request transaction, one or two round trips before
    COMMIT. The invalidation bought nothing, and `getInvoiceConfig(ctx)` read
    through the open transaction and cached its uncommitted write process-wide.
    The invalidation now happens from an after-commit callback, and the read
    below is left on `ctx` deliberately: it must return what this request just
    wrote, including when that write has not committed yet, because it is this
    request's own response. `getSettings` refuses to cache a transactional read,
    so returning it here is safe in a way that caching it was not.
  */
  return getInvoiceConfig(ctx);
}

/** Drop anything that is not a known label key, since storage is jsonb. */
function resolveOverrides(merged: Record<string, string>): Record<string, string> {
  const complete = resolveLabels(merged);
  const overrides: Record<string, string> = {};
  for (const [key, value] of Object.entries(merged)) {
    if (key in complete) overrides[key] = value;
  }
  return overrides;
}

/**
 * Refuse a sequence number that would collide.
 *
 * Moving the counter forward is the normal case: continuing Harvest's sequence
 * at 71559 is exactly what this field is for. Moving it *backward* into a range
 * already issued is the dangerous one, because nothing goes wrong until the
 * next invoice is drawn, and then the unique index surfaces it as a 500 at the
 * worst possible moment, in front of a client.
 *
 * Two checks, because either alone leaves a hole:
 *
 *   1. The exact number the next invoice would take must not already exist.
 *      Catches continuing an imported sequence one step too early.
 *   2. The counter must not move backward once it has been drawn from, because
 *      check 1 only sees the very next number and the range behind it is just
 *      as used.
 */
async function assertSequenceIsFree(ctx: Ctx, nextSeq: number, before: s.SettingsRow) {
  if (!Number.isInteger(nextSeq) || nextSeq < 1) {
    throw validationFailed({ nextSeq: ["The next number must be a whole number, 1 or more."] });
  }

  const pattern = before.invoiceNumberPattern;
  const candidate = exampleNumber(pattern, nextSeq);

  const [clash] = await ctx.db
    .select({ number: s.invoices.number })
    .from(s.invoices)
    .where(and(eq(s.invoices.number, candidate), isNull(s.invoices.deletedAt)))
    .limit(1);

  if (clash) {
    throw validationFailed({
      nextSeq: [`Invoice ${clash.number} already uses that number.`],
    });
  }

  if (nextSeq < before.invoiceNextSeq) {
    const [{ count } = { count: 0 }] = await ctx.db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(s.invoices)
      .where(isNull(s.invoices.deletedAt));

    if (count > 0) {
      throw validationFailed({
        nextSeq: [
          `Numbers up to ${before.invoiceNextSeq - 1} have been issued. ` +
            "Moving the counter back would reissue one of them.",
        ],
      });
    }
  }
}
