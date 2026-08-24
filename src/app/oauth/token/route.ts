import { z } from "zod";
import { route } from "@/server/http";
import { exchangeOAuthCode } from "@/server/services/oauth";
const schema = z.object({ grant_type: z.literal("authorization_code"), code: z.string(), client_id: z.string(), redirect_uri: z.string().url(), code_verifier: z.string().min(43).max(128) });
export const POST = route(async (ctx, req) => { const value = schema.parse(Object.fromEntries((await req.formData()).entries())); return exchangeOAuthCode(ctx, { code: value.code, clientId: value.client_id, redirectUri: value.redirect_uri, codeVerifier: value.code_verifier }); }, { public: true, rateLimit: "auth", rawResponse: true, oauthErrors: true });
