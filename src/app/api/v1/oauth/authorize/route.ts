import { z } from "zod";
import { body, route } from "@/server/http";
import { approveOAuth } from "@/server/services/oauth";
const schema = z.object({ clientId: z.string(), redirectUri: z.string().url(), scope: z.string(), codeChallenge: z.string(), state: z.string().optional(), approved: z.boolean() });
export const POST = route(async (ctx, req) => approveOAuth(ctx, await body(req, schema)), { rateLimit: "auth" });
