import { z } from "zod";
import { body, route } from "@/server/http";
import { setReimbursementState } from "@/server/services/expenses";

const schema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
  state: z.enum(["pending", "approved", "paid"]),
  paidAt: z.string().datetime().optional(),
});

/**
 * Moves reimbursements along their own lifecycle, which runs alongside the
 * billing one: whether a client is charged for a taxi and whether the person
 * who paid for it has been repaid are unrelated questions.
 */
export const POST = route(
  async (ctx, req) => {
    const { ids, state, paidAt } = await body(req, schema);
    return { updated: await setReimbursementState(ctx, ids, state, paidAt) };
  },
  { rateLimit: "write", capability: "expense:manage" }
);
