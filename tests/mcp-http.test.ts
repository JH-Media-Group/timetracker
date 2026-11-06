import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpHttpServer } from "@/mcp/http";
import { createCtx } from "@/server/ctx";
import { BASE_PROFILES } from "@/server/auth/capabilities";
import { createApiToken, revokeApiToken } from "@/server/services/api-keys";
import { createSession } from "@/server/auth/session";
import { consume } from "@/server/auth/rate-limit";
import { mcpResource, oauthIssuer } from "@/server/auth/oauth-metadata";
import { db, s, resetDb, seedProfiles, makeUser, closeDb, seedSettings, makeClient, makeProject } from "./helpers";
import { apiHttpServer, listen, close } from "./support/mcp-http-harness";

vi.hoisted(() => { delete process.env.REDIS_URL; });

const apiServer = apiHttpServer();
let apiUrl: string, mcpUrl: string;
let mcpServer: ReturnType<typeof createMcpHttpServer>;
let userId: string, profileId: string;
const ctx = () => createCtx({ actor: { userId, profileId, baseKey: "administrator", kind: "user", timezone: "UTC", isOwner: false, capabilities: new Set(BASE_PROFILES.administrator.capabilities) } });
const headers = (token: string) => ({ authorization: `Bearer ${token}`, accept: "application/json, text/event-stream", "content-type": "application/json" });

beforeAll(async () => {
  apiUrl = await listen(apiServer);
  mcpServer = createMcpHttpServer({ baseUrl: apiUrl, publicUrl: oauthIssuer() });
  mcpUrl = `${await listen(mcpServer)}/mcp`;
});
beforeEach(async () => {
  await resetDb();
  profileId = (await seedProfiles()).administrator!;
  userId = await makeUser({ profileId, email: "connector@example.com" });
  await seedSettings();
  await makeProject(await makeClient("Example client"), { name: "Example project" });
});
afterAll(async () => { await close(mcpServer); await close(apiServer); await closeDb(); });

async function post(path: string, body: unknown, cookie?: string) {
  return fetch(`${apiUrl}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: oauthIssuer(), ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
}

async function oauthToken() {
  const cookie = `tally_session=${(await createSession(userId, {})).token}`;
  const registration = await post("/oauth/register", { client_name: "HTTP test client", redirect_uris: ["http://127.0.0.1/callback"] });
  expect(registration.status).toBe(201);
  const client = await registration.json();
  const verifier = "v".repeat(64), redirectUri = "http://127.0.0.1:45678/callback";
  const codeChallenge = createHash("sha256").update(verifier).digest("base64url");
  const consent = await post("/api/v1/oauth/authorize", { clientId: client.client_id, redirectUri, scope: "tally.read", codeChallenge, codeChallengeMethod: "S256", responseType: "code", resource: mcpResource(), state: "state", expectedUserId: userId, approved: true, selectedScopes: ["tally.read"] }, cookie);
  expect(consent.status).toBe(200);
  const callback = new URL((await consent.json()).data.redirectTo);
  expect(callback.searchParams.get("iss")).toBe(oauthIssuer());
  expect(callback.searchParams.get("state")).toBe("state");
  const exchange = await fetch(`${apiUrl}/oauth/token`, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code: callback.searchParams.get("code")!, client_id: client.client_id, redirect_uri: redirectUri, code_verifier: verifier, resource: mcpResource() }) });
  expect(exchange.status).toBe(200);
  return (await exchange.json()).access_token as string;
}

describe("MCP over HTTP through middleware, real API auth and services", () => {
  for (const kind of ["PAT", "OAuth"] as const) it(`${kind}: initializes and completes more than ten reads without cookies`, async () => {
    const token = kind === "OAuth" ? await oauthToken() : (await createApiToken(ctx(), { label: "HTTP test", scopes: ["tally.read"] })).token;
    const client = new Client({ name: "wire-test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    try {
      expect((await client.listTools()).tools.some((tool) => tool.name === "tally_timer_current")).toBe(true);
      const projects = await client.callTool({ name: "tally_projects_mine", arguments: {} });
      expect(projects.isError).not.toBe(true);
      expect(JSON.stringify(projects)).toContain("Example project");
      for (let i = 0; i < 20; i++) {
        const result = await client.callTool({ name: "tally_timer_current", arguments: {} });
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
      }
    } finally { await client.close(); }
  });

  it("keeps introspection quotas separate and returns 429 with recovery guidance", async () => {
    const token = await createApiToken(ctx(), { label: "Quota", scopes: ["tally.read"] });
    for (let i = 0; i < 600; i++) await consume("token", `token:${token.prefix}`);
    const limited = await fetch(mcpUrl, { method: "POST", headers: headers(token.token), body: "{}" });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    expect((await limited.json()).error).toBe("rate_limited");
    expect((await consume("auth", `token:${token.prefix}`)).allowed).toBe(true);
    const other = await createApiToken(ctx(), { label: "Other", scopes: ["tally.read"] });
    expect((await fetch(`${apiUrl}/api/v1/auth/token-info`, { headers: headers(other.token) })).status).toBe(200);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_001);
    try { expect((await fetch(`${apiUrl}/api/v1/auth/token-info`, { headers: headers(token.token) })).status).toBe(200); }
    finally { clock.mockRestore(); }
  });

  it("revokes immediately and never substitutes a cookie for a bad bearer", async () => {
    const token = await createApiToken(ctx(), { label: "Revoke", scopes: ["tally.read"] });
    expect((await fetch(`${apiUrl}/api/v1/projects`, { headers: headers(token.token) })).status).toBe(200);
    await revokeApiToken(ctx(), token.id);
    const cookie = `tally_session=${(await createSession(userId, {})).token}`;
    const response = await fetch(`${apiUrl}/api/v1/projects`, { headers: { ...headers(token.token), cookie } });
    expect(response.status).toBe(401);
    const emptyHeader = await fetch(`${apiUrl}/api/v1/projects`, { headers: { authorization: "", cookie } });
    expect(emptyHeader.status).toBe(401);
    const mcp = await fetch(mcpUrl, { method: "POST", headers: headers(token.token), body: "{}" });
    expect(mcp.status).toBe(401);
    expect(mcp.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("rejects disabled owners and malformed or absent credentials", async () => {
    const token = await createApiToken(ctx(), { label: "Disabled", scopes: ["tally.read"] });
    await db.update(s.users).set({ archivedAt: new Date() }).where(eq(s.users.id, userId));
    for (const authorization of [token.token, "invalid"]) {
      expect((await fetch(mcpUrl, { method: "POST", headers: headers(authorization), body: "{}" })).status).toBe(401);
    }
    expect((await fetch(mcpUrl, { method: "POST", body: "{}" })).status).toBe(401);
  });

  it("blocks token consent/minting and cross-origin session consent", async () => {
    const token = await createApiToken(ctx(), { label: "Narrow", scopes: ["tally.time.write"] });
    const minted = await fetch(`${apiUrl}/api/v1/api-tokens`, { method: "POST", headers: headers(token.token), body: JSON.stringify({ label: "Escalate", scopes: ["tally.admin"] }) });
    expect(minted.status).toBe(403);
    const cookie = `tally_session=${(await createSession(userId, {})).token}`;
    const crossOrigin = await fetch(`${apiUrl}/api/v1/oauth/authorize`, { method: "POST", headers: { cookie, origin: "https://evil.example", "content-type": "application/json" }, body: "{}" });
    expect(crossOrigin.status).toBe(403);
  });

  it("clears expired cookies so consent can resume at sign-in", async () => {
    const response = await fetch(`${apiUrl}/api/v1/oauth/request`, { headers: { cookie: "tally_session=expired" } });
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("does not clear a valid session when a bearer-only handler refuses cookie authentication", async () => {
    const cookie = `tally_session=${(await createSession(userId, {})).token}`;
    const response = await fetch(`${apiUrl}/api/v1/auth/token-info`, { headers: { cookie } });
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect((await fetch(`${apiUrl}/api/v1/projects`, { headers: { cookie } })).status).toBe(200);
  });

  it("isolates OAuth setup from sign-in quotas and rejects malformed token requests as protocol errors", async () => {
    for (let i = 0; i < 10; i++) await consume("auth", "ip:unknown");
    await oauthToken();
    const malformed = await post("/oauth/token", {});
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).error).toBe("invalid_request");
    const unsupported = await fetch(`${apiUrl}/oauth/token`, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token" }) });
    expect(unsupported.status).toBe(400);
    expect((await unsupported.json()).error).toBe("unsupported_grant_type");
  });

  it("rejects an untrusted browser origin before accepting MCP requests", async () => {
    const token = await createApiToken(ctx(), { label: "Origin", scopes: ["tally.read"] });
    const response = await fetch(mcpUrl, { method: "POST", headers: { ...headers(token.token), origin: "https://evil.example" }, body: "{}" });
    expect(response.status).toBe(403);
  });
});
