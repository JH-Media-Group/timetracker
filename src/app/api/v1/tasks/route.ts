import { z } from "zod";
import { body, query, route } from "@/server/http";
import { taskSchema } from "@/server/schemas";
import { createTask, listTasks } from "@/server/services/tasks";

const listSchema = z.object({ status: z.enum(["active", "all"]).default("active") });

export const GET = route(async (ctx, req) => {
  const { status } = query(req, listSchema);
  return listTasks(ctx, { includeArchived: status === "all" });
});

export const POST = route(async (ctx, req) => createTask(ctx, await body(req, taskSchema)), { rateLimit: "write", capability: "task:manage" });
