import { body, route } from "@/server/http";
import { projectPatchSchema } from "@/server/schemas";
import { archiveProject, getProject, updateProject } from "@/server/services/projects";

export const GET = route(async (ctx, _req, params) => getProject(ctx, params.id!), { rateLimit: "read" });

export const PATCH = route(async (ctx, req, params) =>
  updateProject(ctx, params.id!, await body(req, projectPatchSchema))
, { rateLimit: "write", capability: "project:manage" });

/** Archive rather than delete: a project owns tracked hours and invoice lines. */
export const DELETE = route(async (ctx, _req, params) => archiveProject(ctx, params.id!, true), { rateLimit: "write", capability: "project:archive" });
