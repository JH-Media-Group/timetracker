import { route } from "@/server/http";
import { restoreTimeEntry } from "@/server/services/time";

export const POST = route(async (ctx, _req, params) => restoreTimeEntry(ctx, params.id!), { rateLimit: "write" });
