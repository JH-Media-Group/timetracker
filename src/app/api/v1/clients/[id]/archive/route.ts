import { route } from "@/server/http";
import { archiveClient } from "@/server/services/clients";

export const POST = route(async (ctx, _req, params) => archiveClient(ctx, params.id!, true), { rateLimit: "write", capability: "client:manage" });
