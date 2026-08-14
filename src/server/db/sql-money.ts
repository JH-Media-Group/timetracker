/**
 * Money and duration aggregation in SQL.
 *
 * There is a trap here that the type system cannot see. Postgres widens
 * `SUM(bigint)` to `numeric`, and the driver returns `numeric` as a **string**
 * to avoid losing precision. So this:
 *
 *     const rows = await db.select({ total: sum(invoices.totalCents) })...
 *     rows[0].total + otherTotal        // "123400" + 500 === "123400500"
 *
 * compiles, runs, and produces string concatenation where money was meant.
 * Drizzle's own `sum()` has the same shape. Every aggregate in this codebase
 * goes through the helpers below, which cast in SQL and parse in JavaScript
 * with the same safe-integer assertion the column type uses.
 *
 * The second rule, from BACKEND_PRD 3.6: when valuing time, sum
 * `seconds * rate_cents` first and divide by 3600 exactly once, at the end.
 * Dividing per row truncates per row, and the error only ever goes one way.
 */

import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

/** SUM as text, so the driver cannot hand back a lossy number. */
export const sumCentsSql = (column: SQLWrapper): SQL<string> =>
  sql<string>`COALESCE(SUM(${column}), 0)::text`;

/** SUM of an integer column (seconds, counts) as text. */
export const sumIntSql = (column: SQLWrapper): SQL<string> =>
  sql<string>`COALESCE(SUM(${column}), 0)::text`;

export const countSql = (): SQL<string> => sql<string>`COUNT(*)::text`;

/**
 * The value of tracked time: sum the products, then divide once.
 *
 * ROUND rather than integer division, because integer division truncates and
 * the whole point of aggregating first is to stop the truncation error
 * accumulating.
 */
export const sumTimeValueSql = (seconds: SQLWrapper, rateCents: SQLWrapper): SQL<string> =>
  sql<string>`COALESCE(ROUND(SUM(${seconds}::bigint * ${rateCents})::numeric / 3600), 0)::text`;

/** Conditional variants, for "billable only" style aggregates in one pass. */
export const sumCentsWhereSql = (column: SQLWrapper, condition: SQLWrapper): SQL<string> =>
  sql<string>`COALESCE(SUM(CASE WHEN ${condition} THEN ${column} ELSE 0 END), 0)::text`;

export const sumIntWhereSql = (column: SQLWrapper, condition: SQLWrapper): SQL<string> =>
  sql<string>`COALESCE(SUM(CASE WHEN ${condition} THEN ${column} ELSE 0 END), 0)::text`;

export const sumTimeValueWhereSql = (
  seconds: SQLWrapper,
  rateCents: SQLWrapper,
  condition: SQLWrapper
): SQL<string> =>
  sql<string>`COALESCE(ROUND(SUM(CASE WHEN ${condition} THEN ${seconds}::bigint * ${rateCents} ELSE 0 END)::numeric / 3600), 0)::text`;

/**
 * Parses an aggregate back into a number, refusing to lose precision quietly.
 *
 * The throw is deliberate. A total beyond 2^53 cents means either ninety
 * trillion dollars or a bug, and both deserve a loud failure rather than a
 * subtly wrong invoice.
 */
export function toNumber(value: string | number | null | undefined, what = "aggregate"): number {
  if (value == null) return 0;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RangeError(`${what} is not finite`);
    return value;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw new RangeError(`${what} "${value}" is not a number`);
  if (!Number.isSafeInteger(n) && Number.isInteger(Number(value))) {
    throw new RangeError(`${what} "${value}" is outside the safe integer range and would lose precision`);
  }
  return n;
}

/** Same, for a whole row of text-typed aggregates. */
export function toNumbers<K extends string>(row: Record<K, string | null> | undefined): Record<K, number> {
  const out = {} as Record<K, number>;
  if (!row) return out;
  for (const [key, value] of Object.entries(row) as [K, string | null][]) {
    out[key] = toNumber(value, key);
  }
  return out;
}
