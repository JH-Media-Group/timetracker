import { z } from "zod";
import { body, route } from "@/server/http";
import { registerOAuthClient } from "@/server/services/oauth";
const schema = z.object({ client_name: z.string().max(200).optional(), redirect_uris: z.array(z.string().url()).min(1).max(10), token_endpoint_auth_method: z.literal("none").optional() });
export const POST = route(async (ctx, req) => registerOAuthClient(ctx, await body(req, schema)), { public: true, rateLimit: "auth", rawResponse: true });
