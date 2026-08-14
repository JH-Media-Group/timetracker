import { body, route } from "@/server/http";
import { rateSchema } from "@/server/schemas";
import { createRate, listRates } from "@/server/services/rates";

export const GET = route(async (ctx, _req, params) => listRates(ctx, params.id!), { rateLimit: "read" });

export const POST = route(async (ctx, req, params) => createRate(ctx, params.id!, await body(req, rateSchema)), { rateLimit: "write", capability: "rates:manage" });
