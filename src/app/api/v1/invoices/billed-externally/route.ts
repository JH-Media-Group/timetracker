import { z } from "zod";
import { body, route } from "@/server/http";
import { markBilledExternally } from "@/server/services/invoices";

/**
 * POST /api/v1/invoices/billed-externally
 *
 * Records that work was billed outside Tally, which for JH Media Group means
 * QuickBooks. It creates no invoice and moves no money; it takes hours and
 * expenses off the uninvoiced list so they stop reading as a receivable.
 *
 * No `requireIdempotencyKey`, unlike its neighbours in this folder. Those
 * create records, so a retry makes a second one. This sets a boolean to a
 * value, and the service only claims rows that are not already at that value,
 * so a retry claims nothing and reports zero. The operation is idempotent by
 * construction rather than by ledger.
 */
const schema = z
  .object({
    clientId: z.string().uuid(),
    timeEntryIds: z.array(z.string().uuid()).max(1000).optional(),
    expenseIds: z.array(z.string().uuid()).max(1000).optional(),
    billed: z.boolean().default(true),
  })
  .strict();

export const POST = route(
  async (ctx, req) => markBilledExternally(ctx, await body(req, schema)),
  { rateLimit: "write", capability: "invoice:manage" }
);
