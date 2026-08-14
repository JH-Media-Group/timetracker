import { z } from "zod";
import { body, query, route } from "@/server/http";
import { projectSchema } from "@/server/schemas";
import { createProject, listProjects } from "@/server/services/projects";

const listSchema = z.object({
  status: z.enum(["active", "archived", "all"]).default("active"),
  client_id: z.string().uuid().optional(),
});

export const GET = route(async (ctx, req) => {
  const { status, client_id } = query(req, listSchema);
  return listProjects(ctx, {
    includeArchived: status === "all",
    archivedOnly: status === "archived",
    clientId: client_id,
  });
}, { rateLimit: "read" });

export const POST = route(async (ctx, req) => createProject(ctx, await body(req, projectSchema)), { rateLimit: "write", capability: "project:manage" });
