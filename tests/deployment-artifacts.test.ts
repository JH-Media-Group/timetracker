import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("production deployment artifacts", () => {
  it.each(["harvest-import", "harvest-reconcile", "bootstrap-owner", "invite-link"])(
    "ships the guarded %s command", (name) => {
      const dockerfile = read("Dockerfile");
      expect(dockerfile).toContain(`scripts/${name}.mts`);
      expect(dockerfile).toContain(`--outfile=ops/${name}.mjs`);
    }
  );

  it("keeps staging private behind Caddy and constrained", () => {
    const compose = read("docker/compose.production.yml");
    expect(compose).not.toMatch(/^\s*ports:/m);
    expect(compose).toContain("read_only: true");
    expect(compose).toContain("no-new-privileges:true");
    expect(compose).toContain("cap_drop:");
    expect(compose).toContain("mem_limit: 768m");
    expect(compose).toContain("max-size: 10m");
    expect(compose).toContain("name: opt_default");
  });

  it("gives MCP its own database-independent liveness probe", () => {
    const compose = read("docker/compose.production.yml");
    const mcp = compose.slice(compose.indexOf("  mcp:"));
    expect(mcp).toContain("http://127.0.0.1:3201/mcp");
    expect(mcp).toContain("r.status===405");
    expect(mcp).not.toContain("http://127.0.0.1:3000/api/health/live");
  });
});
