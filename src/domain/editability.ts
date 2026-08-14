/**
 * Can this record still be changed?
 *
 * One predicate, applied identically to time entries and expenses. Four locks,
 * any of which is enough:
 *
 *   1. it is on an invoice that has left draft;
 *   2. it was billed in Harvest before the migration;
 *   3. an *approved* submission covers its date;
 *   4. it is older than the account's timesheet lock window.
 *
 * Lock 3 is period-based rather than row-based on purpose. Checking whether the
 * row itself carries an approval_id leaves a loophole: back-date a new entry
 * into an approved week and it slips in unlocked, changing a week somebody has
 * already signed off. Asking "does an approved period cover this date" closes
 * it.
 *
 * Specification: docs/BACKEND_PRD.md section 4.10.
 */

import type { IsoDate } from "./calendar";
import { daysBetween } from "./calendar";

export type LockReason =
  | "invoiced"
  | "billed_externally"
  | "period_approved"
  | "period_locked";

export interface EditabilityRecord {
  spentOn: IsoDate;
  userId: string;
  invoiceId: string | null;
  /** State of the invoice named above, when there is one. */
  invoiceState: string | null;
  billedExternally: boolean;
}

export interface EditabilityContext {
  today: IsoDate;
  /** Approved submission periods for the record's owner. */
  approvedPeriods: readonly { periodStart: IsoDate; periodEnd: IsoDate }[];
  lockTimesheetsAfterDays: number | null;
  /** True for Administrators and People Admins, who may override every lock. */
  canOverride: boolean;
}

export interface EditabilityResult {
  editable: boolean;
  /** Every reason it is locked, not just the first, so the UI can be specific. */
  reasons: LockReason[];
  /** True when the actor is only allowed through because of their profile. */
  requiresOverride: boolean;
}

export function canEdit(record: EditabilityRecord, ctx: EditabilityContext): EditabilityResult {
  const reasons: LockReason[] = [];

  if (record.invoiceId && record.invoiceState && record.invoiceState !== "draft") {
    reasons.push("invoiced");
  }
  if (record.billedExternally) {
    reasons.push("billed_externally");
  }
  if (ctx.approvedPeriods.some((p) => record.spentOn >= p.periodStart && record.spentOn <= p.periodEnd)) {
    reasons.push("period_approved");
  }
  if (ctx.lockTimesheetsAfterDays != null && daysBetween(record.spentOn, ctx.today) > ctx.lockTimesheetsAfterDays) {
    reasons.push("period_locked");
  }

  if (reasons.length === 0) return { editable: true, reasons, requiresOverride: false };
  return { editable: ctx.canOverride, reasons, requiresOverride: ctx.canOverride };
}

/**
 * Creating a record dated into an approved period.
 *
 * Refused for the owner. An administrator override creates it, flags the
 * submission `amended`, and notifies the approver, so an approved week can
 * never change silently.
 */
export function canCreateOn(
  spentOn: IsoDate,
  ctx: Pick<EditabilityContext, "approvedPeriods" | "lockTimesheetsAfterDays" | "today" | "canOverride">
): EditabilityResult {
  return canEdit(
    { spentOn, userId: "", invoiceId: null, invoiceState: null, billedExternally: false },
    { ...ctx }
  );
}

export const LOCK_MESSAGES: Record<LockReason, string> = {
  invoiced: "This is on an invoice that has been sent.",
  billed_externally: "This was billed in Harvest before the move.",
  period_approved: "This week has been approved.",
  period_locked: "This period is closed for editing.",
};

/* ------------------------------------------------------------- uninvoiced */

/**
 * The one predicate shared by the Time report, the Invoicing report, the
 * project KPI card, and invoice line generation.
 *
 * `billedExternally` is what stops every historical Harvest hour showing up as
 * receivable on day one.
 */
export const isUninvoiced = (record: {
  invoiceId: string | null;
  billedExternally: boolean;
  isBillable: boolean;
}): boolean => record.invoiceId === null && !record.billedExternally && record.isBillable;
