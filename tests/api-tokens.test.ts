import { createHash } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { BASE_PROFILES } from "@/server/auth/capabilities";
import { createCtx, type Actor } from "@/server/ctx";
import { createApiToken, resolveApiToken, revokeApiToken } from "@/server/services/api-keys";
import { approveOAuth, exchangeOAuthCode, registerOAuthClient } from "@/server/services/oauth";
import { closeDb, db, makeUser, resetDb, seedProfiles, s } from "./helpers";

let profiles: Record<string, string>; let userId: string;
function ctx() { const actor: Actor = { userId, profileId: profiles.administrator!, baseKey: "administrator", capabilities: new Set(BASE_PROFILES.administrator.capabilities), kind: "user", timezone: "America/New_York", isOwner: false }; return createCtx({ actor }); }
beforeEach(async () => { await resetDb(); profiles = await seedProfiles(); userId = await makeUser({ profileId: profiles.administrator!, email: "api-owner@example.com" }); });
afterAll(closeDb);

describe("personal API tokens", () => {
  it("is shown once, stored as a digest, and resolves to a narrowed API actor", async () => {
    const made = await createApiToken(ctx(), { label: "Test", scopes: ["tally.read"] });
    expect(made.token).toMatch(/^tally_[a-f0-9]{8}_[A-Za-z0-9_-]+$/);
    const [stored] = await db.select().from(s.apiTokens);
    expect(stored!.tokenHash).not.toContain(made.token);
    const resolved = await resolveApiToken(made.token);
    expect(resolved!.actor.kind).toBe("api");
    expect(resolved!.actor.capabilities.has("report:view_own")).toBe(true);
    expect(resolved!.actor.capabilities.has("time:create_own")).toBe(false);
  });
  it("gives an empty scope list no capabilities", async () => {
    const made = await createApiToken(ctx(), { label: "Empty", scopes: [] });
    expect((await resolveApiToken(made.token))!.actor.capabilities.size).toBe(0);
  });
  it("revokes on the next resolution", async () => {
    const made = await createApiToken(ctx(), { label: "Revoke", scopes: ["tally.read"] });
    expect(await resolveApiToken(made.token)).not.toBeNull();
    await revokeApiToken(ctx(), made.id);
    expect(await resolveApiToken(made.token)).toBeNull();
  });
  it("refuses legacy or invented scope names", async () => {
    await expect(createApiToken(ctx(), { label: "Bad", scopes: ["time"] })).rejects.toMatchObject({ code: "validation_failed" });
  });
});

describe("OAuth authorization code with PKCE", () => {
  it("registers, requires consent, and mints exactly the consented scopes", async () => {
    const client = await registerOAuthClient(ctx(), { client_name: "Test MCP", redirect_uris: ["http://127.0.0.1:4567/callback"] });
    const verifier = "v".repeat(64), codeChallenge = createHash("sha256").update(verifier).digest("base64url");
    const approval = await approveOAuth(ctx(), { clientId: client.client_id, redirectUri: client.redirect_uris[0]!, scope: "tally.read tally.time.write", codeChallenge, state: "state-1", approved: true });
    const redirect = new URL(approval.redirectTo), code = redirect.searchParams.get("code")!;
    expect(redirect.searchParams.get("state")).toBe("state-1");
    const token = await exchangeOAuthCode(ctx(), { code, clientId: client.client_id, redirectUri: client.redirect_uris[0]!, codeVerifier: verifier });
    expect(token.scope).toBe("tally.read tally.time.write");
    expect((await resolveApiToken(token.access_token))!.scopes).toEqual(["tally.read", "tally.time.write"]);
    await expect(exchangeOAuthCode(ctx(), { code, clientId: client.client_id, redirectUri: client.redirect_uris[0]!, codeVerifier: verifier })).rejects.toMatchObject({ code: "validation_failed" });
  });
  it("declining creates no authorization code or token", async () => {
    const client = await registerOAuthClient(ctx(), { redirect_uris: ["http://localhost:9876/cb"] });
    const result = await approveOAuth(ctx(), { clientId: client.client_id, redirectUri: client.redirect_uris[0]!, scope: "tally.read", codeChallenge: "x".repeat(43), approved: false });
    expect(new URL(result.redirectTo).searchParams.get("error")).toBe("access_denied");
    expect(await db.select().from(s.oauthAuthorizationCodes)).toHaveLength(0);
  });
});
