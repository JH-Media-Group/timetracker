import { body, route } from "@/server/http";
import { clientPatchSchema } from "@/server/schemas";
import { archiveClient, getClient, updateClient } from "@/server/services/clients";

export const GET = route(async (ctx, _req, params) => getClient(ctx, params.id!), { rateLimit: "read" });

export const PATCH = route(async (ctx, req, params) =>
  updateClient(ctx, params.id!, await body(req, clientPatchSchema))
, { rateLimit: "write", capability: "client:manage" });

/** Archive rather than delete: a client owns invoice history. */
export const DELETE = route(async (ctx, _req, params) => archiveClient(ctx, params.id!, true), { rateLimit: "write", capability: "client:manage" });
