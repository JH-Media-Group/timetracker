import { z } from "zod";
import { body, query, route } from "@/server/http";
import { invoiceSchema } from "@/server/schemas";
import { createInvoice, listInvoices } from "@/server/services/invoices";

const listSchema = z.object({
  state: z.enum(["outstanding", "draft", "paid", "all"]).default("all"),
  client_id: z.string().uuid().optional(),
});

export const GET = route(
  async (ctx, req) => {
    const { state, client_id } = query(req, listSchema);
    return listInvoices(ctx, { state, clientId: client_id });
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
