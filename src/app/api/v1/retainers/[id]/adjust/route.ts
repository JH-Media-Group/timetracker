import { z } from "zod";
import { body, route } from "@/server/http";
import { adjustBalance } from "@/server/services/retainers";

const schema = z.object({
  deltaCents: z.number().int(),
  note: z.string().trim().min(1, "Say why the balance is being corrected.").max(500),
});

/**
 * A correction, in either direction, and it always carries a reason. An
 * unexplained movement is the one ledger row nobody can account for later.
 */
export const POST = route(
  async (ctx, req, params) => adjustBalance(ctx, params.id!, await body(req, schema)),
  { rateLimit: "write", capability: "invoice:manage", requireIdempotencyKey: true }
);
