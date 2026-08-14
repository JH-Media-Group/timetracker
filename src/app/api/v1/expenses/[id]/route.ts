import { body, route } from "@/server/http";
import { expensePatchSchema } from "@/server/schemas";
import { deleteExpense, getExpense, updateExpense } from "@/server/services/expenses";

export const GET = route(async (ctx, _req, params) => getExpense(ctx, params.id!), { rateLimit: "read" });

export const PATCH = route(
  async (ctx, req, params) => updateExpense(ctx, params.id!, await body(req, expensePatchSchema)),
  { rateLimit: "write" }
);

export const DELETE = route(
  async (ctx, _req, params) => {
    await deleteExpense(ctx, params.id!);
    return { deleted: true };
  },
  { rateLimit: "write" }
);
