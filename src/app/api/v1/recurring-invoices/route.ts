import { body, route } from "@/server/http";
import { recurringSchema } from "@/server/schemas";
import { createRecurring, listRecurring } from "@/server/services/recurring";

export const GET = route(async (ctx) => listRecurring(ctx), {
  rateLimit: "read",
  capability: "invoice:view",
});

/**
 * A schedule is not money yet, but it is a standing instruction to move some
 * every month, so a retried request must not leave two of them.
 */
export const POST = route(
  async (ctx, req) => createRecurring(ctx, await body(req, recurringSchema)),
  { rateLimit: "write", capability: "invoice:manage", requireIdempotencyKey: true }
);
