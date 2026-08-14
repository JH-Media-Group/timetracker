import { z } from "zod";
import { body, query, route } from "@/server/http";
import { clientSchema } from "@/server/schemas";
import { createClient, listClients } from "@/server/services/clients";

const listSchema = z.object({ status: z.enum(["active", "archived", "all"]).default("active") });

export const GET = route(async (ctx, req) => {
  const { status } = query(req, listSchema);
  return listClients(ctx, { includeArchived: status === "all", archivedOnly: status === "archived" });
});

export const POST = route(async (ctx, req) => createClient(ctx, await body(req, clientSchema)), { rateLimit: "write", capability: "client:manage" });
