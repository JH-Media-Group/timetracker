import { createHash } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createCtx } from "@/server/ctx";
import { BASE_PROFILES } from "@/server/auth/capabilities";
import { approveOAuth, exchangeOAuthCode, oauthRequest, registerOAuthClient } from "@/server/services/oauth";
import { createApiToken, listApiTokens, resolveApiToken } from "@/server/services/api-keys";
import { mcpResource, oauthIssuer, protectedResourceMetadata, authorizationServerMetadata } from "@/server/auth/oauth-metadata";
import { TOKEN_SCOPES } from "@/lib/api-token-scopes";
import { db, s, resetDb, seedProfiles, makeUser, closeDb, raw } from "./helpers";

let userId: string, profileId: string;
const ctx = () => createCtx({ actor: { userId, profileId, kind: "user", baseKey: "administrator", capabilities: new Set(BASE_PROFILES.administrator.capabilities), timezone: "UTC", isOwner: false } });
const verifier = "v".repeat(64);
const codeChallenge = createHash("sha256").update(verifier).digest("base64url");
beforeEach(async () => { await resetDb(); profileId = (await seedProfiles()).administrator!; userId = await makeUser({ profileId, email: "oauth@example.com" }); });
afterAll(closeDb);

async function request(redirectUri = "https://client.example/callback") {
  const client = await registerOAuthClient(ctx(), { client_name: "Example client", redirect_uris: [redirectUri] });
  return { clientId: client.client_id, redirectUri, scope: "tally.read", codeChallenge, resource: mcpResource(), selectedScopes: ["tally.read"] };
}
async function grant() {
  const input = await request();
  const result = await approveOAuth(ctx(), { ...input, approved: true, expectedUserId: userId });
  return { code: new URL(result.redirectTo).searchParams.get("code")!, clientId: input.clientId, redirectUri: input.redirectUri, codeVerifier: verifier, resource: mcpResource() };
}

describe("OAuth compatibility and trust boundaries", () => {
  it("discovery uses the full scope registry and one exact issuer", () => {
    expect(protectedResourceMetadata().scopes_supported).toEqual([...TOKEN_SCOPES]);
    expect(authorizationServerMetadata().scopes_supported).toEqual([...TOKEN_SCOPES]);
    expect(protectedResourceMetadata().authorization_servers).toEqual([authorizationServerMetadata().issuer]);
    expect(authorizationServerMetadata().grant_types_supported).toEqual(["authorization_code"]);
  });
  it("binds new OAuth credentials to the client and resource and preserves PATs", async () => {
    const input = await grant();
    const token = await exchangeOAuthCode(ctx(), input);
    const [row] = await listApiTokens(ctx());
    expect(row).toMatchObject({ label: "Example client", oauthClientId: input.clientId, resource: mcpResource(), scopes: ["tally.read"], callbackHosts: ["client.example"] });
    expect(token.expires_in).toBe(90 * 86400);
    const [audit] = await db.select().from(s.auditLog).where(eq(s.auditLog.action, "oauth.token_issued"));
    expect(audit).toMatchObject({ actorId: userId, tokenPrefix: row!.prefix });
    expect(JSON.stringify(audit)).not.toContain(token.access_token);
    await db.update(s.apiTokens).set({ resource: "https://other.example/mcp" }).where(eq(s.apiTokens.id, row!.id));
    expect(await resolveApiToken(token.access_token)).toBeNull();
    const pat = await createApiToken(ctx(), { label: "OAuth MCP client", scopes: ["tally.read"] });
    expect(await resolveApiToken(pat.token)).not.toBeNull();
  });
  it("matches HTTPS callbacks exactly and allows only native IP-loopback port changes", async () => {
    const https = await request();
    for (const redirectUri of ["https://client.example:444/callback", "https://client.example/callback/", "https://client.example/elsewhere", "https://evil.example/callback"]) {
      await expect(oauthRequest(ctx(), { ...https, redirectUri })).rejects.toMatchObject({ oauthCode: "invalid_request" });
    }
    const local = await request("http://127.0.0.1/callback?client=test");
    expect(await oauthRequest(ctx(), { ...local, redirectUri: "http://127.0.0.1:54545/callback?client=test" })).toHaveProperty("clientName");
    for (const redirectUri of ["http://localhost:54545/callback?client=test", "http://127.0.0.1:54545/other?client=test", "http://127.0.0.1:54545/callback?client=other"]) {
      await expect(oauthRequest(ctx(), { ...local, redirectUri })).rejects.toMatchObject({ oauthCode: "invalid_request" });
    }
  });
  it("rejects redirects with credentials, fragments or non-loopback HTTP", async () => {
    for (const redirectUri of ["http://client.example/callback", "https://user:password@client.example/callback", "https://client.example/callback#fragment"]) {
      await expect(registerOAuthClient(ctx(), { redirect_uris: [redirectUri] })).rejects.toMatchObject({ oauthCode: "invalid_request" });
    }
  });
  it("rejects unknown scopes, wrong resource and malformed S256 challenges", async () => {
    const input = await request();
    await expect(oauthRequest(ctx(), { ...input, scope: "openid" })).rejects.toMatchObject({ oauthCode: "invalid_scope" });
    await expect(oauthRequest(ctx(), { ...input, resource: "https://other.example/mcp" })).rejects.toMatchObject({ oauthCode: "invalid_target" });
    await expect(oauthRequest(ctx(), { ...input, codeChallenge: "x".repeat(64) })).rejects.toMatchObject({ oauthCode: "invalid_request" });
  });
  it("declines without a code and returns state and exact issuer", async () => {
    const result = await approveOAuth(ctx(), { ...await request(), approved: false, state: "a state with + and &" });
    const callback = new URL(result.redirectTo);
    expect(callback.searchParams.get("error")).toBe("access_denied");
    expect(callback.searchParams.get("iss")).toBe(oauthIssuer());
    expect(callback.searchParams.get("state")).toBe("a state with + and &");
    expect(await db.select().from(s.oauthAuthorizationCodes)).toHaveLength(0);
    expect(await db.select().from(s.apiTokens)).toHaveLength(0);
  });
  it("refuses consent if the signed-in account changed", async () => {
    const other = await makeUser({ profileId });
    await expect(approveOAuth(ctx(), { ...await request(), expectedUserId: other, approved: true })).rejects.toMatchObject({ code: "forbidden" });
    expect(await db.select().from(s.oauthAuthorizationCodes)).toHaveLength(0);
  });
  it("grants extra access only from an explicit valid selection", async () => {
    const input = await request();
    for (const selectedScopes of [[], ["unknown"]]) {
      await expect(approveOAuth(ctx(), { ...input, approved: true, selectedScopes })).rejects.toMatchObject({ oauthCode: "invalid_scope" });
    }
    const approved = await approveOAuth(ctx(), { ...input, approved: true, selectedScopes: ["tally.read", "tally.time.write"] });
    const token = await exchangeOAuthCode(ctx(), { code: new URL(approved.redirectTo).searchParams.get("code")!, clientId: input.clientId, redirectUri: input.redirectUri, codeVerifier: verifier });
    expect(token.scope).toBe("tally.read tally.time.write");
    expect(token.scope).not.toContain("tally.admin");
    expect(token.scope).not.toContain("tally.financial.read");
  });
  it("validates audience, client, exact exchange redirect and verifier before consuming a code", async () => {
    const input = await grant();
    for (const bad of [{ resource: "https://other.example/mcp" }, { clientId: "wrong" }, { redirectUri: "https://client.example/other" }, { codeVerifier: "w".repeat(64) }]) {
      await expect(exchangeOAuthCode(ctx(), { ...input, ...bad })).rejects.toMatchObject({ oauthCode: "resource" in bad ? "invalid_target" : "invalid_grant" });
    }
    const result = await exchangeOAuthCode(ctx(), input);
    expect(await resolveApiToken(result.access_token)).not.toBeNull();
    await expect(exchangeOAuthCode(ctx(), input)).rejects.toMatchObject({ oauthCode: "invalid_grant" });
  });
  it("consumes a code only once under concurrent exchanges", async () => {
    const input = await grant();
    // Warm connections before the race; the conditional UPDATE is the arbiter.
    await Promise.all([db.select().from(s.users), db.select().from(s.users)]);
    const results = await Promise.allSettled([exchangeOAuthCode(ctx(), input), exchangeOAuthCode(ctx(), input)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.select().from(s.apiTokens)).toHaveLength(1);
  });
  it("rejects expired codes and disabled accounts at exchange", async () => {
    const input = await grant();
    await db.update(s.oauthAuthorizationCodes).set({ expiresAt: new Date(0) });
    await expect(exchangeOAuthCode(ctx(), input)).rejects.toMatchObject({ oauthCode: "invalid_grant" });
    const fresh = await grant();
    await db.update(s.users).set({ archivedAt: new Date() }).where(eq(s.users.id, userId));
    await expect(exchangeOAuthCode(ctx(), fresh)).rejects.toMatchObject({ oauthCode: "invalid_grant" });
  });

  it("reclaims old unused registrations but retains a client with a live authorization code", async () => {
    const abandoned = await request();
    const pending = await grant();
    await db.update(s.oauthClients).set({ createdAt: new Date(Date.now() - 25 * 3600_000) });
    await request();
    const clients = await db.select().from(s.oauthClients);
    expect(clients.some((c) => c.clientId === abandoned.clientId)).toBe(false);
    expect(clients.some((c) => c.clientId === pending.clientId)).toBe(true);
    expect((await exchangeOAuthCode(ctx(), pending)).access_token).toBeTruthy();
  });

  it("reports registration capacity as temporary unavailability without creating more clients", async () => {
    await db.execute(raw`INSERT INTO oauth_clients (id,client_id,client_name,redirect_uris)
      SELECT gen_random_uuid(), 'capacity-' || n, 'Example client', '["https://client.example/callback"]'::jsonb FROM generate_series(1,5000) n`);
    await expect(request()).rejects.toMatchObject({ oauthCode: "temporarily_unavailable" });
    const [count] = await db.execute(raw`SELECT count(*)::int AS n FROM oauth_clients`);
    expect(count!.n).toBe(5000);
  });
});
