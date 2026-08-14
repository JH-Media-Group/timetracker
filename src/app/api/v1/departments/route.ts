import { route } from "@/server/http";
import { listDepartments } from "@/server/services/people";

export const GET = route(async (ctx) => listDepartments(ctx), { rateLimit: "read" });
