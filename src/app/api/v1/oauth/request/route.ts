import { z } from "zod";
import { query, route } from "@/server/http";
import { oauthRequest } from "@/server/services/oauth";
const schema = z.object({ client_id: z.string(), redirect_uri: z.string().url(), scope: z.string(), code_challenge: z.string(), code_challenge_method: z.literal("S256") });
export const GET = route(async (ctx, req) => { const q = query(req, schema); return oauthRequest(ctx, { clientId: q.client_id, redirectUri: q.redirect_uri, scope: q.scope, codeChallenge: q.code_challenge }); }, { rateLimit: "auth" });
