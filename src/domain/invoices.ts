/**
 * Invoice state machine and numbering.
 *
 * The states are stored; "Sent" and "Late" are not. `open` plus a due date in
 * the past is late, and deriving it means an invoice cannot sit in a stale
 * `late` row after somebody pays it.
 *
 * Specification: docs/BACKEND_PRD.md section 4.8.
 */

import type { IsoDate } from "./calendar";

export type InvoiceState = "draft" | "open" | "paid" | "written_off" | "closed";

/** What the UI shows, which is not the same as what the column holds. */
export type InvoiceDisplayState = "draft" | "sent" | "partial" | "late" | "paid" | "written_off" | "closed";

export type InvoiceAction =
  | "send"
  | "mark_sent"
  | "record_payment"
  | "void_payment"
  | "write_off"
  | "close"
  | "delete"
  | "edit";

const TRANSITIONS: Record<InvoiceState, readonly InvoiceAction[]> = {
  draft: ["send", "mark_sent", "delete", "edit"],
  open: ["record_payment", "void_payment", "write_off", "close", "edit"],
  paid: ["void_payment", "edit"],
  written_off: ["edit"],
  closed: ["edit"],
};

export const canTransition = (from: InvoiceState, action: InvoiceAction): boolean =>
  TRANSITIONS[from]?.includes(action) ?? false;

/**
 * Delete is draft-only for everyone except an Administrator, who may delete a
 * sent invoice. Doing so detaches its entries, reverses any retainer draw, and
 * writes the whole invoice into the audit row's `before`.
 */
export const canDelete = (state: InvoiceState, isAdministrator: boolean): boolean =>
  state === "draft" || isAdministrator;

/** Editing after send is allowed for Administrators and Accounting, loudly. */
export const editAfterSendRequiresAudit = (state: InvoiceState): boolean => state !== "draft";

export interface DisplayStateInput {
  state: InvoiceState;
  dueDate: IsoDate;
  totalCents: number;
  paidCents: number;
  today: IsoDate;
}

export function displayState(i: DisplayStateInput): InvoiceDisplayState {
  if (i.state !== "open") return i.state;
  if (i.paidCents > 0 && i.paidCents < i.totalCents) {
    return i.dueDate < i.today ? "late" : "partial";
  }
  return i.dueDate < i.today ? "late" : "sent";
}

/** The state a payment moves an invoice into. Additive rows, recomputed total. */
export function stateAfterPayment(totalCents: number, paidCents: number, current: InvoiceState): InvoiceState {
  if (current === "written_off" || current === "closed") return current;
  return paidCents >= totalCents ? "paid" : "open";
}

/* -------------------------------------------------------------- numbering */

export interface NumberPatternContext {
  seq: number;
  issueDate: IsoDate;
  clientCode?: string | null;
  projectCode?: string | null;
  /** A per-client prefix overrides the pattern's static prefix. */
  clientPrefix?: string | null;
}

/**
 * Renders `settings.invoice_number_pattern`.
 *
 * Supported tokens: {seq}, {seq:N} zero-padded, {year}, {yy}, {month},
 * {client_code}, {project_code}. Anything unrecognised is left alone rather
 * than dropped, so a typo shows up in the number instead of vanishing.
 *
 * The sequence itself is drawn inside the creating transaction under a row lock
 * on settings; this function only formats.
 */
export function renderInvoiceNumber(pattern: string, ctx: NumberPatternContext): string {
  const year = ctx.issueDate.slice(0, 4);
  const month = ctx.issueDate.slice(5, 7);

  const rendered = pattern.replace(/\{(\w+)(?::(\d+))?\}/g, (whole, token: string, pad?: string) => {
    switch (token) {
      case "seq":
        return pad ? String(ctx.seq).padStart(Number(pad), "0") : String(ctx.seq);
      case "year":
        return year;
      case "yy":
        return year.slice(2);
      case "month":
        return month;
      case "client_code":
        return ctx.clientCode ?? "";
      case "project_code":
        return ctx.projectCode ?? "";
      default:
        return whole;
    }
  });

  const cleaned = rendered.replace(/--+/g, "-").replace(/^-|-$/g, "");
  return ctx.clientPrefix ? `${ctx.clientPrefix}${cleaned}` : cleaned;
}

/** A short, stable code from a client name, for {client_code}. */
export const clientCodeFrom = (name: string): string =>
  name.replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase() || "XXX";

/* -------------------------------------------------------------- due dates */

export type PaymentTerm = "upon_receipt" | "net_15" | "net_30" | "net_45" | "net_60" | "custom";

export const TERM_DAYS: Record<Exclude<PaymentTerm, "custom">, number> = {
  upon_receipt: 0,
  net_15: 15,
  net_30: 30,
  net_45: 45,
  net_60: 60,
};

export function dueDateFor(issueDate: IsoDate, term: PaymentTerm, customDays: number | null): IsoDate {
  const days = term === "custom" ? (customDays ?? 0) : TERM_DAYS[term];
  const d = new Date(`${issueDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
