import { route } from "@/server/http";
import { pinProject, pinnedProjectIds } from "@/server/services/projects";

/**
 * Pinning is a per-user preference, so it needs no project capability: your
 * pins never rearrange a teammate's list.
 *
 * The whole new list comes back rather than just `{ pinned: true }`, because
 * the caller is holding the old one and a boolean does not let it produce the
 * new one without guessing.
 */
export const POST = route(async (ctx, _req, params) => {
  await pinProject(ctx, params.id!, true);
  return { pinned: true, pinnedProjectIds: await pinnedProjectIds(ctx) };
}, { rateLimit: "write" });
