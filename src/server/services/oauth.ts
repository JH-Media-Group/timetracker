import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import type { Ctx } from "@/server/ctx";
import * as s from "@/server/db/schema";
import { newId } from "@/server/db/ids";
import { TOKEN_SCOPES } from "./api-keys";
import { forbidden, validationFailed } from "@/server/errors";
import { db } from "@/server/db/client";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const challenge = (value: string) => createHash("sha256").update(value).digest("base64url");
const MAX_OAUTH_CLIENTS = 5000;
export class OAuthError extends Error {
  constructor(readonly oauthCode: "invalid_request" | "invalid_grant" | "invalid_scope", message: string) { super(message); this.name = "OAuthError"; }
}
function redirectUri(value: string) {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.hash || (url.protocol !== "https:" && !(local && url.protocol === "http:"))) throw validationFailed({ redirect_uris: ["Redirect URIs must use HTTPS (HTTP is allowed only on loopback) and cannot contain fragments."] });
  return url.toString();
}
function scopes(value: string | string[]) {
  const list = Array.isArray(value) ? value : value.split(/\s+/).filter(Boolean);
  if (!list.length || list.some((item) => !(TOKEN_SCOPES as readonly string[]).includes(item))) throw new OAuthError("invalid_scope", "Request one or more documented Tally scopes.");
  return [...new Set(list)];
}

export async function registerOAuthClient(ctx: Ctx, input: { client_name?: string; redirect_uris: string[] }) {
  await ctx.db.execute(sql`select pg_advisory_xact_lock(74251968)`);
  const [usage] = await ctx.db.select({ count: sql<number>`count(*)::int` }).from(s.oauthClients);
  if ((usage?.count ?? 0) >= MAX_OAUTH_CLIENTS) throw validationFailed({ client_name: ["Dynamic client registration is temporarily at capacity."] });
  const clientId = randomBytes(24).toString("base64url"), uris = input.redirect_uris.map(redirectUri);
  if (!uris.length) throw validationFailed({ redirect_uris: ["At least one redirect URI is required."] });
  await ctx.db.insert(s.oauthClients).values({ id: newId(), clientId, clientName: input.client_name?.trim() || "MCP client", redirectUris: uris });
  return { client_id: clientId, client_name: input.client_name?.trim() || "MCP client", redirect_uris: uris, token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"] };
}

export async function oauthRequest(ctx: Ctx, input: { clientId: string; redirectUri: string; scope: string; codeChallenge: string }) {
  const [client] = await ctx.db.select().from(s.oauthClients).where(eq(s.oauthClients.clientId, input.clientId)).limit(1);
  if (!client || !(client.redirectUris as string[]).includes(redirectUri(input.redirectUri))) throw validationFailed({ redirect_uri: ["That redirect URI is not registered for this client."] });
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(input.codeChallenge)) throw validationFailed({ code_challenge: ["A valid S256 PKCE challenge is required."] });
  return { clientName: client.clientName, scopes: scopes(input.scope) };
}

/**
 * CONSENT IS GIVEN BY A PERSON. A TOKEN CANNOT GIVE IT TO ITSELF.
 *
 * This is the other door into the same escalation `createApiToken` closed. The
 * exchange below inserts straight into `api_tokens` with whatever scopes the
 * code carries, so it never passes the check that made token creation refuse a
 * token. Without this line a bearer limited to `tally.time.write` can register
 * a client through public dynamic registration, approve `tally.admin` for
 * itself, exchange the code with the PKCE verifier it chose, and hold a wider
 * token resolving against its owner's full permissions. No second account, no
 * interactive step, no race: three requests it is allowed to make.
 *
 * Every legitimate caller is a browser session on `/oauth/authorize`, which is
 * `kind: "user"`. There is no system path: consent by definition has somebody
 * consenting, so this refuses everything else rather than making an exception
 * nothing needs.
 */
export async function approveOAuth(ctx: Ctx, input: { clientId: string; redirectUri: string; scope: string; codeChallenge: string; state?: string; approved: boolean }) {
  if (ctx.actor.kind !== "user") throw forbidden("Authorising an application has to be done while signed in.");
  await oauthRequest(ctx, input);
  const target = new URL(input.redirectUri);
  if (!input.approved) { target.searchParams.set("error", "access_denied"); if (input.state) target.searchParams.set("state", input.state); return { redirectTo: target.toString() }; }
  const rawCode = randomBytes(32).toString("base64url");
  await ctx.db.insert(s.oauthAuthorizationCodes).values({ id: newId(), codeHash: hash(rawCode), clientId: input.clientId, userId: ctx.actor.userId, redirectUri: target.toString(), codeChallenge: input.codeChallenge, scopes: scopes(input.scope), expiresAt: new Date(ctx.now().getTime() + 10 * 60_000) });
  target.searchParams.set("code", rawCode); if (input.state) target.searchParams.set("state", input.state);
  return { redirectTo: target.toString() };
}

export async function exchangeOAuthCode(ctx: Ctx, input: { code: string; clientId: string; redirectUri: string; codeVerifier: string }) {
  const now = ctx.now();
  const [code] = await ctx.db.select().from(s.oauthAuthorizationCodes).where(and(eq(s.oauthAuthorizationCodes.codeHash, hash(input.code)), eq(s.oauthAuthorizationCodes.clientId, input.clientId), eq(s.oauthAuthorizationCodes.redirectUri, redirectUri(input.redirectUri)), isNull(s.oauthAuthorizationCodes.consumedAt), gt(s.oauthAuthorizationCodes.expiresAt, now))).limit(1);
  if (!code || challenge(input.codeVerifier) !== code.codeChallenge) throw new OAuthError("invalid_grant", "The authorization code is invalid, expired, used, or failed PKCE verification.");
  const [claimed] = await ctx.db.update(s.oauthAuthorizationCodes).set({ consumedAt: now }).where(and(eq(s.oauthAuthorizationCodes.id, code.id), isNull(s.oauthAuthorizationCodes.consumedAt))).returning({ id: s.oauthAuthorizationCodes.id });
  if (!claimed) throw new OAuthError("invalid_grant", "The authorization code has already been used.");
  const prefix = randomBytes(4).toString("hex"), secret = randomBytes(32).toString("base64url"), token = `tally_${prefix}_${secret}`, expiresAt = new Date(now.getTime() + 90 * 86_400_000);
  await ctx.db.insert(s.apiTokens).values({ id: newId(), userId: code.userId, label: "OAuth MCP client", tokenHash: hash(token), prefix, scopes: code.scopes, expiresAt });
  await ctx.db.update(s.oauthClients).set({ lastTokenIssuedAt: now }).where(eq(s.oauthClients.clientId, code.clientId));
  return { access_token: token, token_type: "Bearer", expires_in: 90 * 86_400, scope: code.scopes.join(" ") };
}

export async function purgeOAuthStorage() {
  const now = new Date(), abandoned = new Date(now.getTime() - 30 * 86_400_000);
  const confirmations = await db.delete(s.mcpConfirmationClaims).where(lt(s.mcpConfirmationClaims.claimedAt, new Date(now.getTime() - 86_400_000))).returning({ id: s.mcpConfirmationClaims.id });
  const codes = await db.delete(s.oauthAuthorizationCodes).where(or(lt(s.oauthAuthorizationCodes.expiresAt, now), lt(s.oauthAuthorizationCodes.consumedAt, abandoned))).returning({ id: s.oauthAuthorizationCodes.id });
  const clients = await db.delete(s.oauthClients).where(and(isNull(s.oauthClients.lastTokenIssuedAt), lt(s.oauthClients.createdAt, abandoned))).returning({ id: s.oauthClients.id });
  return { codes: codes.length, clients: clients.length, confirmations: confirmations.length };
}
