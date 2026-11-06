import { z } from "zod";
import { route } from "@/server/http";
import { exchangeOAuthCode, OAuthError } from "@/server/services/oauth";
const schema = z.object({ grant_type: z.literal("authorization_code"), code: z.string(), client_id: z.string(), redirect_uri: z.string().url(), code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/), resource: z.string().url().optional() });
export const POST = route(async (ctx, req) => {
  if (req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/x-www-form-urlencoded") {
    throw new OAuthError("invalid_request", "Use application/x-www-form-urlencoded.");
  }
  let form: FormData;
  try { form = await req.formData(); }
  catch { throw new OAuthError("invalid_request", "Invalid token request body."); }
  if (form.get("grant_type") !== "authorization_code") {
    throw new OAuthError("unsupported_grant_type", "Only authorization_code is supported.");
  }
  const value = schema.parse(Object.fromEntries(form.entries()));
  return exchangeOAuthCode(ctx, {
    code: value.code, clientId: value.client_id, redirectUri: value.redirect_uri,
    codeVerifier: value.code_verifier, resource: value.resource,
  });
}, { public: true, rateLimit: "oauthExchange", rawResponse: true, oauthErrors: true });
