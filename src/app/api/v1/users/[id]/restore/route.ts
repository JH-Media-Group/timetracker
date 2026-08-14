import { route } from "@/server/http";
import { archiveUser } from "@/server/services/people";

export const POST = route(async (ctx, _req, params) => archiveUser(ctx, params.id!, false), { rateLimit: "write", capability: "people:manage" });
