import { route } from "@/server/http";
import { archiveProject } from "@/server/services/projects";

export const POST = route(async (ctx, _req, params) => archiveProject(ctx, params.id!, false), { rateLimit: "write", capability: "project:manage" });
