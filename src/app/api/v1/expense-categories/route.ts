import { route } from "@/server/http";
import { listExpenseCategories } from "@/server/services/bootstrap";

export const GET = route(async (ctx) => listExpenseCategories(ctx), { rateLimit: "read" });
