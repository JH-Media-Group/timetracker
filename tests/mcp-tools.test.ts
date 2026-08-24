import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(process.cwd(), "src/mcp");
const files = readdirSync(root).filter((name) => name.endsWith(".ts")).map((name) => ({ name, source: readFileSync(join(root, name), "utf8") }));
const source = files.map((file) => file.source).join("\n");
const tools = [...source.matchAll(/(?:server\.tool|admin)\(\s*["']([^"']+)["']/g)].map((match) => match[1]!);

describe("MCP is an unprivileged HTTP client", () => {
  it("registers the full specified tool surface", () => {
    expect(tools).toEqual(expect.arrayContaining([
      "tally_projects_mine", "tally_timer_current", "tally_time_list", "tally_timer_start", "tally_timer_stop",
      "tally_time_log", "tally_time_edit", "tally_time_delete", "tally_undo", "tally_week_submit",
      "tally_approvals_list", "tally_approvals_decide", "tally_report_time", "tally_client_create",
      "tally_client_update", "tally_project_create", "tally_project_update", "tally_task_create", "tally_task_update",
      "tally_person_create", "tally_person_update", "tally_project_members", "tally_expense_category_create",
      "tally_invoice_config_get", "tally_invoice_config_update", "tally_checkpoint_diff",
    ]));
  });
  it("cannot import the database, schema, services, or application secret", () => {
    for (const file of files) {
      expect(file.source, file.name).not.toMatch(/@\/server\/(db|services|ctx|env)/);
      expect(file.source, file.name).not.toMatch(/DATABASE_URL|SESSION_SECRET/);
    }
  });
  it("validates every bearer through token-info", () => expect(readFileSync(join(root, "index.ts"), "utf8")).toContain('api.get<TokenInfo>("/auth/token-info")'));
  it("forwards the bearer and hashes it before using it as a cache key", () => {
    const api = readFileSync(join(root, "api-client.ts"), "utf8");
    expect(api).toContain("authorization: `Bearer ${this.bearer}`");
    expect(api).toContain('createHash("sha256").update(bearer)');
  });
  it("caps list requests at 200", () => expect(readFileSync(join(root, "server.ts"), "utf8")).toContain("Math.min(value ?? 50, 200)"));
  it("has no confirmation bypass", () => expect(source).not.toMatch(/skip.?confirm|disable.?confirm|auto.?approve/i));
  it("enforces read-only tokens again at the shared HTTP seam", () => {
    const http = readFileSync(join(process.cwd(), "src/server/http.ts"), "utf8");
    expect(http).toContain("if (mutating && tokenReadOnly)");
  });
  it("does not narrate a next action in tool responses", () => expect(source).not.toMatch(/next you should|you should now|recommended next/i));
});
