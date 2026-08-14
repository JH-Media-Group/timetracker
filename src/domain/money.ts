/**
 * Money.
 *
 * Cents, as integers, always. The rules here are the specification in
 * docs/BACKEND_PRD.md section 4.1, and they are the reason invoice totals
 * reconcile to the cent against Harvest.
 *
 * Why a JavaScript `number` and not `bigint`: cents are exact in a double up to
 * 2^53, which is ninety trillion dollars. `assertSafeCents` guards the boundary
 * so the assumption is checked rather than assumed. bigint would be safer in
 * theory and worse in practice, because every arithmetic site would need a
 * conversion and one missed `Number()` reintroduces the bug it was meant to
 * prevent.
 */

export type Cents = number;

const MAX_SAFE_CENTS = Number.MAX_SAFE_INTEGER;

export function assertSafeCents(value: number, what = "amount"): Cents {
  if (!Number.isFinite(value)) throw new RangeError(`${what} is not a finite number`);
  if (!Number.isInteger(value)) throw new RangeError(`${what} must be whole cents, got ${value}`);
  if (Math.abs(value) > MAX_SAFE_CENTS) throw new RangeError(`${what} exceeds the safe integer range`);
  return value;
}

/**
 * Banker's rounding: halves go to the even neighbour.
 *
 * Half-up is the obvious choice and the wrong one. Across thousands of line
 * items it biases every total upward by a systematic fraction of a cent, which
 * is exactly the kind of drift that makes an accountant stop trusting a system.
 */
export function roundHalfEven(value: number): number {
  if (!Number.isFinite(value)) throw new RangeError("cannot round a non-finite number");
  const floor = Math.floor(value);
  const diff = value - floor;

  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  // Exactly a half: pick the even neighbour.
  return floor % 2 === 0 ? floor : floor + 1;
}

/** A percentage of an amount, rounded half-even. `percent` is 7.5 for 7.5%. */
export function percentOf(amountCents: Cents, percent: number | null | undefined): Cents {
  if (!percent) return 0;
  return roundHalfEven((amountCents * percent) / 100);
}

/**
 * Value of tracked time.
 *
 * Aggregate `seconds x rate` first and divide by 3600 exactly once, at the end.
 * Dividing per row and summing afterwards accumulates a rounding error across
 * thousands of entries, and the error is always in the same direction.
 */
export function secondsToCents(seconds: number, rateCents: Cents): Cents {
  return Math.round((seconds * rateCents) / 3600);
}

/** The same calculation over many rows, with the single division at the end. */
export function sumSecondsToCents(rows: Iterable<{ seconds: number; rateCents: Cents }>): Cents {
  let product = 0;
  for (const r of rows) product += r.seconds * r.rateCents;
  return Math.round(product / 3600);
}

/* --------------------------------------------------------- invoice totals */

export interface InvoiceLineInput {
  quantity: number;
  unitPriceCents: Cents;
  /** Present on stored lines; when absent it is computed from quantity x price. */
  amountCents?: Cents;
  isTaxed: boolean;
  isTaxed2: boolean;
}

export interface InvoiceTotals {
  subtotalCents: Cents;
  discountCents: Cents;
  taxCents: Cents;
  tax2Cents: Cents;
  totalCents: Cents;
}

export const lineAmount = (quantity: number, unitPriceCents: Cents): Cents =>
  roundHalfEven(quantity * unitPriceCents);

/**
 * The fixed order from BACKEND_PRD 4.1. Every intermediate is stored, because
 * "why is this invoice $0.02 different" is a question that has to be answerable
 * from the row alone, without rerunning the calculation.
 *
 * Discount applies to the subtotal. Tax applies to the taxed lines *after* the
 * discount, pro-rated by each line's share of the subtotal: taxing the
 * pre-discount amount would overcharge, and applying the whole discount to the
 * taxed portion would undercharge.
 */
export function computeInvoiceTotals(
  lines: readonly InvoiceLineInput[],
  opts: { discountPercent?: number | null; taxPercent?: number | null; tax2Percent?: number | null } = {}
): InvoiceTotals {
  const amounts = lines.map((l) => l.amountCents ?? lineAmount(l.quantity, l.unitPriceCents));
  const subtotalCents = amounts.reduce((a, b) => a + b, 0);

  const discountCents = percentOf(subtotalCents, opts.discountPercent);

  const taxableOf = (predicate: (l: InvoiceLineInput) => boolean) => {
    const gross = lines.reduce((sum, l, i) => sum + (predicate(l) ? amounts[i]! : 0), 0);
    if (gross === 0 || discountCents === 0 || subtotalCents === 0) return gross;
    // Pro-rate the discount by this group's share of the subtotal.
    const share = roundHalfEven((discountCents * gross) / subtotalCents);
    return gross - share;
  };

  const taxCents = percentOf(taxableOf((l) => l.isTaxed), opts.taxPercent);
  const tax2Cents = percentOf(taxableOf((l) => l.isTaxed2), opts.tax2Percent);

  const totalCents = subtotalCents - discountCents + taxCents + tax2Cents;

  return {
    subtotalCents: assertSafeCents(subtotalCents, "subtotal"),
    discountCents,
    taxCents,
    tax2Cents,
    totalCents: assertSafeCents(totalCents, "total"),
  };
}

/** What is still owed. Payments and any retainer draw both reduce it. */
export function invoiceBalance(totalCents: Cents, paidCents: Cents, retainerDrawCents: Cents = 0): Cents {
  return totalCents - paidCents - retainerDrawCents;
}

/* ------------------------------------------------------------- formatting */

/** Server-side money formatting, for emails and generated documents. */
export function formatCents(cents: Cents, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

/** Parses "1,234.56", "$1234.56", "1234" into cents. Null when unparseable. */
export function parseMoney(input: string): Cents | null {
  const cleaned = input.replace(/[^0-9.,-]/g, "").replace(/,/g, "");
  if (!cleaned || cleaned === "-" || cleaned === "." || cleaned === "-.") return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}
