import { route } from "@/server/http";
import { listProfiles } from "@/server/services/people";

export const GET = route(async (ctx) => listProfiles(ctx), { rateLimit: "read", capability: "people:manage" });
