import { z } from "zod";
import { body, query, route } from "@/server/http";
import { userCreateSchema } from "@/server/schemas";
import { createUser, listUsers } from "@/server/services/people";

const listSchema = z.object({ status: z.enum(["active", "archived", "all"]).default("active") });

export const GET = route(async (ctx, req) => {
  const { status } = query(req, listSchema);
  return listUsers(ctx, { includeArchived: status === "all", archivedOnly: status === "archived" });
});

export const POST = route(
  async (ctx, req) => createUser(ctx, await body(req, userCreateSchema)),
  { rateLimit: "write", capability: "people:manage" }
);
