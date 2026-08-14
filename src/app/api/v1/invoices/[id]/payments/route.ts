import { body, route } from "@/server/http";
import { paymentSchema } from "@/server/schemas";
import { recordPayment } from "@/server/services/invoices";

/** Money moving, so an Idempotency-Key is required. */
export const POST = route(
  async (ctx, req, params) => recordPayment(ctx, params.id!, await body(req, paymentSchema)),
  { rateLimit: "write", capability: "invoice:manage", requireIdempotencyKey: true }
);
