import { z } from "zod";
import { body, route } from "@/server/http";
import { listExpenseCategories } from "@/server/services/bootstrap";
import { createExpenseCategory } from "@/server/services/expenses";

export const GET = route(async (ctx) => listExpenseCategories(ctx), { rateLimit: "read" });

const schema = z.object({
  name: z.string().trim().min(1, "A category needs a name.").max(120),
  unitName: z.string().max(40).nullable().optional(),
  unitPriceCents: z.number().int().min(0).nullable().optional(),
});

/**
 * A category with a unit price bills by quantity, like mileage, and then it
 * computes its own totals: see `createExpense`, which refuses to take an
 * amount for one.
 */
export const POST = route(
  async (ctx, req) => createExpenseCategory(ctx, await body(req, schema)),
  { rateLimit: "write", capability: "expense:manage" }
);
