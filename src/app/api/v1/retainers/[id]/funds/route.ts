import { z } from "zod";
import { body, route } from "@/server/http";
import { addFunds } from "@/server/services/retainers";

const schema = z.object({
  amountCents: z.number().int().positive("Enter an amount greater than zero."),
  note: z.string().max(500).nullable().optional(),
});

/** Money in. Idempotent by key, because crediting twice is the expensive mistake. */
export const POST = route(
  async (ctx, req, params) => addFunds(ctx, params.id!, await body(req, schema)),
  { rateLimit: "write", capability: "invoice:manage", requireIdempotencyKey: true }
);
