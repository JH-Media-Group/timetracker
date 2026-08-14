import { z } from "zod";
import { body, route } from "@/server/http";
import { addRetainerTransaction } from "@/server/services/invoices";

const schema = z.object({
  kind: z.enum(["add", "draw", "adjust"]),
  amountCents: z.number().int().positive(),
  note: z.string().max(500).nullable().optional(),
});

export const POST = route(
  async (ctx, req, params) => addRetainerTransaction(ctx, params.id!, await body(req, schema)),
  { rateLimit: "write", capability: "invoice:manage", requireIdempotencyKey: true }
);
