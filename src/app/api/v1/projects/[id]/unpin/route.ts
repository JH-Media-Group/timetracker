import { route } from "@/server/http";
import { pinProject, pinnedProjectIds } from "@/server/services/projects";

export const POST = route(async (ctx, _req, params) => {
  await pinProject(ctx, params.id!, false);
  return { pinned: false, pinnedProjectIds: await pinnedProjectIds(ctx) };
}, { rateLimit: "write" });
