import { body, route } from "@/server/http";
import { taskPatchSchema } from "@/server/schemas";
import { deleteTask, updateTask } from "@/server/services/tasks";

export const PATCH = route(async (ctx, req, params) =>
  updateTask(ctx, params.id!, await body(req, taskPatchSchema))
, { rateLimit: "write", capability: "task:manage" });

/** Hard delete, refused when the task has history. Archive is the alternative. */
export const DELETE = route(async (ctx, _req, params) => {
  await deleteTask(ctx, params.id!);
  return { deleted: true };
}, { rateLimit: "write", capability: "task:manage" });
