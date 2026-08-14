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
  limit: z.coerce.number().int().min(1).max(10000).default(5000),
});

export const GET = route(
  async (ctx, req) => {
    const q = query(req, listSchema);
    // One row past the cap, then dropped, so `hasMore` is a fact rather than a
    // guess and a truncated list never reads as a complete one.
    const rows = await listExpenses(ctx, {
      from: q.from,
      to: q.to,
      userId: q.user_id,
      projectId: q.project_id,
      reimbursableOnly: q.reimbursable,
      invoiced: q.invoiced,
      limit: q.limit + 1,
    });
    const hasMore = rows.length > q.limit;
    return { data: hasMore ? rows.slice(0, q.limit) : rows, meta: { hasMore, perPage: q.limit } };
  },
  { rateLimit: "read" }
);

export const POST = route(
  async (ctx, req) => createExpense(ctx, await body(req, expenseSchema)),
  { rateLimit: "write", capability: "expense:create_own" }
);
