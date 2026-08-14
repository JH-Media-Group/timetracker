import { body, route } from "@/server/http";
import { userPatchSchema } from "@/server/schemas";
import { getUser, updateUser } from "@/server/services/people";

export const GET = route(async (ctx, _req, params) => getUser(ctx, params.id!), { rateLimit: "read" });

export const PATCH = route(async (ctx, req, params) =>
  updateUser(ctx, params.id!, await body(req, userPatchSchema))
, { rateLimit: "write", capability: "people:manage" });
