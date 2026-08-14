import { z } from "zod";
import { body, query, route } from "@/server/http";
import { invoiceSchema } from "@/server/schemas";
import { createInvoice, listInvoices } from "@/server/services/invoices";

const listSchema = z.object({
  state: z.enum(["outstanding", "draft", "paid", "all"]).default("all"),
  client_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(2000).default(1000),
});

/**
 * The collection, with an honest `hasMore`.
 *
 * One row more than the caller asked for is fetched and then dropped. A cap
 * that trims in silence reads to every consumer as "this is all of it", and
 * with years of invoice history behind an agency that is a number somebody will
 * eventually add up and act on.
 */
export const GET = route(
  async (ctx, req) => {
    const { state, client_id, limit } = query(req, listSchema);
    const rows = await listInvoices(ctx, { state, clientId: client_id, limit: limit + 1 });
    const hasMore = rows.length > limit;
    return { data: hasMore ? rows.slice(0, limit) : rows, meta: { hasMore, perPage: limit } };
  },
  { rateLimit: "read", capability: "invoice:view" }
);

/**
 * Creating an invoice moves money, so it requires an Idempotency-Key: a retried
 * request must produce one invoice, not two.
 */
export const POST = route(
  async (ctx, req) => createInvoice(ctx, await body(req, invoiceSchema)),
  { rateLimit: "write", capability: "invoice:manage", requireIdempotencyKey: true }
);
