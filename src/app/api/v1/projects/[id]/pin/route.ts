import { route } from "@/server/http";
import { pinProject } from "@/server/services/projects";

/** Pinning is a per-user preference, so it needs no project capability. */
export const POST = route(async (ctx, _req, params) => {
  await pinProject(ctx, params.id!, true);
  return { pinned: true };
}, { rateLimit: "write" });
