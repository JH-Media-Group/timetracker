import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { BASE_PROFILES } from "@/server/auth/capabilities";
import { createCtx, withTransaction, type Actor } from "@/server/ctx";
import { confirmation } from "@/server/services/mcp-safety";
import { closeDb, db, makeUser, resetDb, seedProfiles, s } from "./helpers";

let profiles: Record<string, string>; let userId: string;
function ctx() { const actor: Actor = { userId, profileId: profiles.administrator!, baseKey: "administrator", capabilities: new Set(BASE_PROFILES.administrator.capabilities), kind: "api", timezone: "America/New_York", isOwner: false, tokenPrefix: "abcd1234", tokenScopes: ["tally.admin"] }; return createCtx({ actor }); }
beforeEach(async () => { await resetDb(); profiles = await seedProfiles(); userId = await makeUser({ profileId: profiles.administrator! }); });
afterAll(closeDb);

describe("MCP confirmation", () => {
  const plan = { action: "project.update", records: [{ type: "project", id: "01900000-0000-7000-8000-000000000001", label: "Untrusted project text" }], changes: { archived: true } };
  it("requires a signed second phase and binds it to the exact plan", () => {
    const first = confirmation(ctx(), "project.update", { archived: true }, plan);
    expect(first.confirmed).toBe(false);
    if (first.confirmed) throw new Error("expected a plan");
    expect(confirmation(ctx(), "project.update", { archived: true }, plan, first.confirmationToken)).toEqual({ confirmed: true });
    expect(() => confirmation(ctx(), "project.update", { archived: false }, plan, first.confirmationToken)).toThrow();
  });
  it("refuses a forged token", () => expect(() => confirmation(ctx(), "project.update", { archived: true }, plan, "forged.token")).toThrow());
});

describe("API audit attribution", () => {
  it("stores actor kind and token prefix as dedicated fields", async () => {
    await withTransaction(ctx(), async (tx) => { tx.audit({ action: "test.mcp", entityType: "test" }); });
    const [row] = await db.select().from(s.auditLog);
    expect(row).toMatchObject({ actorKind: "api", tokenPrefix: "abcd1234" });
  });
});
