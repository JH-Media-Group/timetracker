import { route } from "@/server/http";
import { propagateToActiveProjects } from "@/server/services/tasks";

/**
 * Adds this task to every active project that does not have it.
 *
 * A separate endpoint rather than a side effect of marking a task common:
 * it can touch hundreds of projects and should be something somebody chose.
 */
export const POST = route(async (ctx, _req, params) => ({
  projectsUpdated: await propagateToActiveProjects(ctx, params.id!),
}), { rateLimit: "write", capability: "task:manage" });
