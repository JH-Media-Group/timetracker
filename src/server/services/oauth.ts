import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { withTransaction, type Ctx } from "@/server/ctx";
import * as s from "@/server/db/schema";
import { newId } from "@/server/db/ids";
import { TOKEN_SCOPES } from "./api-keys";
import { forbidden, validationFailed } from "@/server/errors";
import { db } from "@/server/db/client";
import { mcpResource, oauthIssuer } from "@/server/auth/oauth-metadata";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const challenge = (value: string) => createHash("sha256").update(value).digest("base64url");
const MAX_OAUTH_CLIENTS = 5000;
export class OAuthError extends Error {
  constructor(readonly oauthCode: "invalid_request" | "invalid_grant" | "invalid_scope" | "invalid_target" | "invalid_client" | "unsupported_grant_type" | "temporarily_unavailable", message: string) { super(message); this.name = "OAuthError"; }
}
function redirectUri(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new OAuthError("invalid_request", "Invalid redirect URI."); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.hash || url.username || url.password || (url.protocol !== "https:" && !(local && url.protocol === "http:"))) {
    throw new OAuthError("invalid_request", "Redirect URIs require HTTPS or loopback HTTP, with no credentials or fragment.");
  }
  // Retain exact spelling for registered HTTPS callbacks and code exchange.
  return value;
}

function registeredRedirect(registered: string[], requested: string) {
  redirectUri(requested);
  return registered.some((value) => {
    if (value === requested) return true;
    const original = new URL(value), candidate = new URL(requested);
    // RFC 8252: native IP-loopback clients select an ephemeral port. Only
    // that port may change; localhost and non-loopback URLs match exactly.
    if (original.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(original.hostname)) return false;
    if (candidate.protocol !== original.protocol || candidate.hostname !== original.hostname) return false;
    original.port = ""; candidate.port = "";
    return original.href === candidate.href;
  });
}

function resource(value?: string) {
  // Older Tally clients omitted resource. They can only request this one
  // canonical resource, never an arbitrary audience or a multi-resource token.
  if (value !== undefined && value !== mcpResource()) throw new OAuthError("invalid_target", "Request the Tally MCP resource.");
  return mcpResource();
}

export interface OAuthRequest {
  clientId: string;
  redirectUri: string;
  scope: string;
  codeChallenge: string;
  resource?: string;
}

function scopes(value: string | string[]) {
  const list = Array.isArray(value) ? value : value.split(/\s+/).filter(Boolean);
  if (!list.length || list.some((item) => !(TOKEN_SCOPES as readonly string[]).includes(item))) throw new OAuthError("invalid_scope", "Request one or more documented Tally scopes.");
  return [...new Set(list)];
}

export async function registerOAuthClient(ctx: Ctx, input: { client_name?: string; redirect_uris: string[] }) {
  await ctx.db.execute(sql`select pg_advisory_xact_lock(74251968)`);
  // Reclaim abandoned registrations even if scheduled housekeeping was delayed.
  // Active authorization codes and all clients that ever issued tokens survive.
  await purgeUnusedClients(ctx);
  const [usage] = await ctx.db.select({ count: sql<number>`count(*)::int` }).from(s.oauthClients);
  if ((usage?.count ?? 0) >= MAX_OAUTH_CLIENTS) {
    console.warn("[oauth] dynamic client registration capacity reached");
    throw new OAuthError("temporarily_unavailable", "New connections are temporarily at capacity. Try again later.");
  }
  const clientId = randomBytes(24).toString("base64url"), uris = input.redirect_uris.map(redirectUri);
  if (!uris.length) throw validationFailed({ redirect_uris: ["At least one redirect URI is required."] });
  await ctx.db.insert(s.oauthClients).values({ id: newId(), clientId, clientName: input.client_name?.trim() || "MCP client", redirectUris: uris });
  return { client_id: clientId, client_name: input.client_name?.trim() || "MCP client", redirect_uris: uris, token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"] };
}

export async function oauthRequest(ctx: Ctx, input: OAuthRequest) {
  if (ctx.actor.kind !== "user") throw forbidden("Authorising an application has to be done while signed in.");
  const [client] = await ctx.db.select().from(s.oauthClients).where(eq(s.oauthClients.clientId, input.clientId)).limit(1);
  if (!client) throw new OAuthError("invalid_client", "The OAuth client is not registered.");
  if (!registeredRedirect(client.redirectUris, input.redirectUri)) throw new OAuthError("invalid_request", "That redirect URI is not registered for this client.");
  if (!/^[A-Za-z0-9_-]{43}$/.test(input.codeChallenge)) throw new OAuthError("invalid_request", "A valid S256 PKCE challenge is required.");
  const [person] = await ctx.db.select({ email: s.users.email }).from(s.users).where(eq(s.users.id, ctx.actor.userId)).limit(1);
  return { clientName: client.clientName, redirectUri: input.redirectUri, scopes: scopes(input.scope), resource: resource(input.resource), userId: ctx.actor.userId, email: person?.email };
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
export async function approveOAuth(ctx: Ctx, input: OAuthRequest & { state?: string; approved: boolean; expectedUserId?: string; selectedScopes: string[] }) {
  if (ctx.actor.kind !== "user") throw forbidden("Authorising an application has to be done while signed in.");
  const request = await oauthRequest(ctx, input);
  if (input.expectedUserId && input.expectedUserId !== ctx.actor.userId) throw forbidden("Your signed-in account changed. Review the connection again.");
  const target = new URL(input.redirectUri);
  target.searchParams.set("iss", oauthIssuer());
  if (!input.approved) { target.searchParams.set("error", "access_denied"); if (input.state) target.searchParams.set("state", input.state); return { redirectTo: target.toString() }; }
  // A person can explicitly adjust a client's requested scope at consent
  // (RFC 6749 section 3.3). No unrequested scope is selected by default.
  const grantedScopes = scopes(input.selectedScopes);
  const rawCode = randomBytes(32).toString("base64url");
  ctx.audit({ action: "oauth.consent_granted", entityType: "user", entityId: ctx.actor.userId, after: { clientId: input.clientId, resource: request.resource, scopes: grantedScopes } });
  await ctx.db.insert(s.oauthAuthorizationCodes).values({ id: newId(), codeHash: hash(rawCode), clientId: input.clientId, userId: ctx.actor.userId, redirectUri: input.redirectUri, codeChallenge: input.codeChallenge, resource: request.resource, scopes: grantedScopes, expiresAt: new Date(ctx.now().getTime() + 10 * 60_000) });
  target.searchParams.set("code", rawCode); if (input.state) target.searchParams.set("state", input.state);
  return { redirectTo: target.toString() };
}

export async function exchangeOAuthCode(ctx: Ctx, input: { code: string; clientId: string; redirectUri: string; codeVerifier: string; resource?: string }) {
  return withTransaction(ctx, (tx) => exchangeCodeInTransaction(tx, input));
}

async function exchangeCodeInTransaction(ctx: Ctx, input: { code: string; clientId: string; redirectUri: string; codeVerifier: string; resource?: string }) {
  const now = ctx.now();
  const audience = resource(input.resource);
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(input.codeVerifier)) throw new OAuthError("invalid_grant", "Invalid PKCE verifier.");
  const [code] = await ctx.db.select().from(s.oauthAuthorizationCodes).where(and(eq(s.oauthAuthorizationCodes.codeHash, hash(input.code)), eq(s.oauthAuthorizationCodes.clientId, input.clientId), eq(s.oauthAuthorizationCodes.redirectUri, redirectUri(input.redirectUri)), isNull(s.oauthAuthorizationCodes.consumedAt), gt(s.oauthAuthorizationCodes.expiresAt, now))).limit(1);
  if (!code || (code.resource !== null && code.resource !== audience) || challenge(input.codeVerifier) !== code.codeChallenge) throw new OAuthError("invalid_grant", "The authorization code is invalid, expired, used, or failed PKCE verification.");
  const [person] = await ctx.db.select({ archivedAt: s.users.archivedAt }).from(s.users).where(eq(s.users.id, code.userId)).limit(1);
  if (!person || person.archivedAt) throw new OAuthError("invalid_grant", "This account can no longer authorize access.");
  const [client] = await ctx.db.select({ name: s.oauthClients.clientName }).from(s.oauthClients).where(eq(s.oauthClients.clientId, code.clientId)).limit(1);
  if (!client) throw new OAuthError("invalid_client", "The OAuth client is not registered.");
  const [claimed] = await ctx.db.update(s.oauthAuthorizationCodes).set({ consumedAt: now }).where(and(eq(s.oauthAuthorizationCodes.id, code.id), isNull(s.oauthAuthorizationCodes.consumedAt))).returning({ id: s.oauthAuthorizationCodes.id });
  if (!claimed) throw new OAuthError("invalid_grant", "The authorization code has already been used.");
  const prefix = randomBytes(4).toString("hex"), secret = randomBytes(32).toString("base64url"), token = `tally_${prefix}_${secret}`, expiresAt = new Date(now.getTime() + 90 * 86_400_000);
  await ctx.db.insert(s.apiTokens).values({ id: newId(), userId: code.userId, label: client.name, oauthClientId: code.clientId, resource: audience, tokenHash: hash(token), prefix, scopes: code.scopes, expiresAt });
  await ctx.db.update(s.oauthClients).set({ lastTokenIssuedAt: now }).where(eq(s.oauthClients.clientId, code.clientId));
  // This public endpoint has no signed-in actor. Attribute issuance to the
  // verified code owner inside the same transaction, without changing ctx.
  await ctx.db.insert(s.auditLog).values({
    actorId: code.userId, actorKind: "api", tokenPrefix: prefix,
    action: "oauth.token_issued", entityType: "user", entityId: code.userId,
    after: { clientId: code.clientId, resource: audience, scopes: code.scopes, expiresAt: expiresAt.toISOString() },
    requestId: ctx.request.requestId, ip: ctx.request.ip, userAgent: ctx.request.userAgent,
  });
  return { access_token: token, token_type: "Bearer", expires_in: 90 * 86_400, scope: code.scopes.join(" ") };
}

async function purgeUnusedClients(ctx: Pick<Ctx, "db" | "now">) {
  return ctx.db.delete(s.oauthClients).where(and(
    isNull(s.oauthClients.lastTokenIssuedAt),
    lt(s.oauthClients.createdAt, new Date(ctx.now().getTime() - 86_400_000)),
    sql`NOT EXISTS (SELECT 1 FROM ${s.oauthAuthorizationCodes} WHERE ${s.oauthAuthorizationCodes.clientId} = ${s.oauthClients.clientId} AND ${s.oauthAuthorizationCodes.consumedAt} IS NULL AND ${s.oauthAuthorizationCodes.expiresAt} > ${ctx.now().toISOString()}::timestamptz)`
  )).returning({ id: s.oauthClients.id });
}

export async function purgeOAuthStorage() {
  const now = new Date(), abandoned = new Date(now.getTime() - 30 * 86_400_000);
  const confirmations = await db.delete(s.mcpConfirmationClaims).where(lt(s.mcpConfirmationClaims.claimedAt, new Date(now.getTime() - 86_400_000))).returning({ id: s.mcpConfirmationClaims.id });
  const codes = await db.delete(s.oauthAuthorizationCodes).where(or(lt(s.oauthAuthorizationCodes.expiresAt, now), lt(s.oauthAuthorizationCodes.consumedAt, abandoned))).returning({ id: s.oauthAuthorizationCodes.id });
  const clients = await purgeUnusedClients({ db, now: () => now });
  return { codes: codes.length, clients: clients.length, confirmations: confirmations.length };
}
