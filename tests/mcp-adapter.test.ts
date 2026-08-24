import { describe, expect, it } from "vitest";
import { createMcpServer } from "@/mcp/server";
import { requestStore } from "@/mcp/context";

const uuid = "01900000-0000-7000-8000-000000000001";

async function call(name: string, input: Record<string, unknown>) {
  const calls: any[] = [];
  const api = {
    get: async () => ({ data: [] }),
    post: async (path: string, body: unknown, key?: string) => { calls.push({ method: "post", path, body, key }); return { data: {} }; },
    patch: async (path: string, body: unknown, key?: string) => { calls.push({ method: "patch", path, body, key }); return { data: {} }; },
    delete: async () => ({ data: {} }),
  };
  const server: any = createMcpServer();
  await requestStore.run({ api: api as any, token: { userId: uuid, scopes: ["tally.admin"], readOnly: false, expiresAt: null } }, () => server._registeredTools[name].handler(input, {}));
  return calls[0];
}

describe("MCP adapter wire mapping", () => {
  it("maps approval confirmation and removes transport fields", async () => {
    expect(await call("tally_approvals_decide", { submission_id: uuid, decision: "approve", confirmation_token: "signed", idempotency_key: "once" })).toEqual({ method: "post", path: "/mcp/approval-decision", key: "once", body: { submission_id: uuid, decision: "approve", note: undefined, confirmationToken: "signed" } });
  });
  it("maps every administrative confirmation and record id", async () => {
    expect(await call("tally_client_update", { id: uuid, name: "Client", confirmation_token: "signed", idempotency_key: "once" })).toEqual({ method: "patch", path: `/mcp/admin/clients/${uuid}`, key: "once", body: { name: "Client", confirmationToken: "signed" } });
  });
});
