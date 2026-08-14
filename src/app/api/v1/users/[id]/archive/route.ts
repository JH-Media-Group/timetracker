import { route } from "@/server/http";
import { archiveUser } from "@/server/services/people";

export const POST = route(async (ctx, _req, params) => archiveUser(ctx, params.id!, true), { rateLimit: "write", capability: "people:manage" });
