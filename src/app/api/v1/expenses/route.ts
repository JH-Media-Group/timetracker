import { z } from "zod";
import { body, query, route } from "@/server/http";
import { expenseSchema, isoDate, queryBool } from "@/server/schemas";
import { createExpense, listExpenses } from "@/server/services/expenses";

const listSchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  user_id: z.string().uuid().optional(),
  project_id: z.string().uuid().optional(),
  reimbursable: queryBool,
  invoiced: queryBool,
});

export const GET = route(
  async (ctx, req) => {
    const q = query(req, listSchema);
    return listExpenses(ctx, {
      from: q.from,
      to: q.to,
      userId: q.user_id,
      projectId: q.project_id,
      reimbursableOnly: q.reimbursable,
      invoiced: q.invoiced,
    });
  },
  { rateLimit: "read" }
);

export const POST = route(
  async (ctx, req) => createExpense(ctx, await body(req, expenseSchema)),
  { rateLimit: "write", capability: "expense:create_own" }
);
