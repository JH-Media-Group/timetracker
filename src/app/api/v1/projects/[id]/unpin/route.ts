import { route } from "@/server/http";
import { pinProject } from "@/server/services/projects";

export const POST = route(async (ctx, _req, params) => {
  await pinProject(ctx, params.id!, false);
  return { pinned: false };
}, { rateLimit: "write" });
