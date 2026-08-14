import { z } from "zod";
import { body, route } from "@/server/http";
import { updateExpenseCategory } from "@/server/services/expenses";

const schema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  unitName: z.string().max(40).nullable().optional(),
  unitPriceCents: z.number().int().min(0).nullable().optional(),
  archived: z.boolean().optional(),
});

export const PATCH = route(
  async (ctx, req, params) => updateExpenseCategory(ctx, params.id!, await body(req, schema)),
  { rateLimit: "write", capability: "settings:manage" }
);
