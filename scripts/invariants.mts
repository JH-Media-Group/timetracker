/**
 * Data invariants, checked against whatever is actually in the database.
 *
 * The unit tests prove the code maintains these on the paths they exercise.
 * This asks the different question: is the data in front of me consistent right
 * now. It is the check to run after the Harvest import, after a migration, and
 * any time a number on a screen looks wrong, because it localises the problem
 * to a table rather than to a hunch.
 *
 * Read-only.
 *
 *   pnpm tsx scripts/invariants.mts
 */

import { sql } from "drizzle-orm";
import { db } from "../src/server/db/client";

interface Check {
  name: string;
  why: string;
  query: ReturnType<typeof sql>;
}

const checks: Check[] = [
  {
    name: "every invoice total equals the sum of its lines, less discount, plus tax",
    why: "The stored totals are a cache of the line items. A cache that can drift from its source will.",
    query: sql`
      SELECT i.id, i.number, i.subtotal_cents, i.total_cents,
             COALESCE(SUM(li.amount_cents), 0) AS line_sum
      FROM invoices i
      LEFT JOIN invoice_line_items li ON li.invoice_id = i.id
      WHERE i.deleted_at IS NULL
      GROUP BY i.id, i.number, i.subtotal_cents, i.total_cents
      HAVING COALESCE(SUM(li.amount_cents), 0) <> i.subtotal_cents
         OR i.total_cents <> i.subtotal_cents - i.discount_cents + i.tax_cents
    `,
  },
  {
    name: "every retainer balance equals the sum of its transactions",
    why: "The ledger is the truth and the balance column is a convenience. They must agree.",
    query: sql`
      SELECT r.id, r.balance_cents,
             COALESCE(SUM(CASE WHEN t.kind IN ('draw', 'reduce') THEN -t.amount_cents ELSE t.amount_cents END), 0) AS ledger
      FROM retainers r
      LEFT JOIN retainer_transactions t ON t.retainer_id = r.id
      GROUP BY r.id, r.balance_cents
      HAVING r.balance_cents <> COALESCE(SUM(CASE WHEN t.kind IN ('draw', 'reduce') THEN -t.amount_cents ELSE t.amount_cents END), 0)
    `,
  },
  {
    name: "every invoice's paid_cents equals the sum of its unvoided payments",
    why: "Recomputed from the rows on every payment. A drift means one write did not.",
    query: sql`
      SELECT i.id, i.number, i.paid_cents,
             COALESCE(SUM(p.amount_cents) FILTER (WHERE p.voided_at IS NULL), 0) AS ledger
      FROM invoices i
      LEFT JOIN invoice_payments p ON p.invoice_id = i.id
      WHERE i.deleted_at IS NULL
      GROUP BY i.id, i.number, i.paid_cents
      HAVING i.paid_cents <> COALESCE(SUM(p.amount_cents) FILTER (WHERE p.voided_at IS NULL), 0)
    `,
  },
  {
    name: "no time entry is attached to an invoice that no longer exists",
    why: "A stranded claim makes an hour permanently unbillable and invisible to the next preview.",
    query: sql`
      SELECT te.id, te.invoice_id
      FROM time_entries te
      LEFT JOIN invoices i ON i.id = te.invoice_id
      WHERE te.invoice_id IS NOT NULL AND (i.id IS NULL OR i.deleted_at IS NOT NULL)
    `,
  },
  {
    name: "no expense is attached to an invoice that no longer exists",
    why: "As above, for the other half of what an invoice claims.",
    query: sql`
      SELECT e.id, e.invoice_id
      FROM expenses e
      LEFT JOIN invoices i ON i.id = e.invoice_id
      WHERE e.invoice_id IS NOT NULL AND (i.id IS NULL OR i.deleted_at IS NOT NULL)
    `,
  },
  {
    name: "every time entry's task belongs to the project it is booked against",
    why: "Enforced by a composite foreign key. If this ever returns a row, the constraint is missing.",
    query: sql`
      SELECT te.id, te.project_id, pt.project_id AS task_project_id
      FROM time_entries te
      JOIN project_tasks pt ON pt.id = te.project_task_id
      WHERE pt.project_id <> te.project_id
    `,
  },
  {
    name: "no person has two timers running",
    why: "Enforced by a partial unique index, and the one invariant a person notices immediately.",
    query: sql`
      SELECT user_id, COUNT(*) AS running
      FROM time_entries
      WHERE timer_started_at IS NOT NULL AND deleted_at IS NULL
      GROUP BY user_id
      HAVING COUNT(*) > 1
    `,
  },
  {
    name: "no rate periods overlap for one person and kind",
    why: "Enforced by an exclusion constraint. Overlapping rates mean an entry's value depends on query order.",
    query: sql`
      SELECT a.user_id, a.kind, a.id AS first_id, b.id AS second_id
      FROM user_rates a
      JOIN user_rates b
        ON b.user_id = a.user_id AND b.kind = a.kind AND b.id > a.id
       AND daterange(a.starts_on, a.ends_on, '[]') && daterange(b.starts_on, b.ends_on, '[]')
    `,
  },
  {
    name: "no negative money anywhere it should be impossible",
    why: "CHECK constraints cover these. A row here means one was dropped in a migration.",
    query: sql`
      SELECT 'time_entries' AS source, id::text FROM time_entries WHERE duration_seconds < 0
      UNION ALL SELECT 'expenses', id::text FROM expenses WHERE total_cents < 0
      UNION ALL SELECT 'invoices', id::text FROM invoices WHERE total_cents < 0 OR paid_cents < 0
      UNION ALL SELECT 'retainers', id::text FROM retainers WHERE balance_cents < 0
    `,
  },
  {
    name: "every invoice number is unique among live invoices",
    why: "Two invoices with one number is a conversation with a client that cannot be resolved.",
    query: sql`
      SELECT number, COUNT(*) AS n
      FROM invoices WHERE deleted_at IS NULL
      GROUP BY number HAVING COUNT(*) > 1
    `,
  },
  {
    name: "exactly one item type is the default for billable hours",
    why:
      "Without one, a new time line has no type and the invoice cannot say what it is. " +
      "With two, which one wins depends on row order, which is not a decision anybody made.",
    query: sql`
      SELECT COUNT(*) AS n FROM invoice_item_types
       WHERE is_default_for_services AND archived_at IS NULL
      HAVING COUNT(*) <> 1
    `,
  },
  {
    name: "exactly one item type is the default for expenses",
    why: "Same as above, for the other half of the split.",
    query: sql`
      SELECT COUNT(*) AS n FROM invoice_item_types
       WHERE is_default_for_expenses AND archived_at IS NULL
      HAVING COUNT(*) <> 1
    `,
  },
  {
    name: "every invoice line has an item type",
    why:
      "A null type renders a blank Item Type column on a document a client is holding. " +
      "The migration backfilled the existing ones; anything null since then arrived by " +
      "a path that did not go through createInvoice.",
    query: sql`
      SELECT li.id, li.description
        FROM invoice_line_items li
        JOIN invoices i ON i.id = li.invoice_id
       WHERE li.item_type_id IS NULL AND i.deleted_at IS NULL
    `,
  },
  {
    name: "the invoice sequence is ahead of every number it has issued",
    why:
      "If the next sequence number is behind one already used, nothing is wrong until " +
      "the next invoice is drawn, and then the unique index surfaces it as a 500 in " +
      "front of a client.",
    query: sql`
      SELECT s.invoice_next_seq, i.number
        FROM settings s
        JOIN invoices i ON i.number = s.invoice_next_seq::text
       WHERE i.deleted_at IS NULL
    `,
  },
];

let broken = 0;

for (const check of checks) {
  const rows = await db.execute(check.query);
  const list = rows as unknown as Record<string, unknown>[];
  if (list.length === 0) {
    console.log(`  ok    ${check.name}`);
  } else {
    broken++;
    console.log(`  BROKEN ${check.name}`);
    console.log(`         ${check.why}`);
    for (const row of list.slice(0, 5)) console.log(`         ${JSON.stringify(row)}`);
    if (list.length > 5) console.log(`         ...and ${list.length - 5} more`);
  }
}

console.log(broken ? `\n${broken} invariants broken` : "\nall invariants hold");
process.exit(broken ? 1 : 0);
