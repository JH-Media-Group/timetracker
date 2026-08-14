import { route } from "@/server/http";
import { listRoles } from "@/server/services/people";

export const GET = route(async (ctx) => listRoles(ctx), { rateLimit: "read" });
