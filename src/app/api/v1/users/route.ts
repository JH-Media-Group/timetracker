import { z } from "zod";
import { query, route } from "@/server/http";
import { listUsers } from "@/server/services/people";

const listSchema = z.object({ status: z.enum(["active", "archived", "all"]).default("active") });

export const GET = route(async (ctx, req) => {
  const { status } = query(req, listSchema);
  return listUsers(ctx, { includeArchived: status === "all", archivedOnly: status === "archived" });
});
