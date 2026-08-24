import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
describe("Tally systemd schedule", () => {
  for (const name of ["mail", "recurring", "sweep", "backup"]) {
    it(`ships an isolated ${name} service and timer`, () => {
      const service = read(`ops/systemd/tally-${name}.service`), timer = read(`ops/systemd/tally-${name}.timer`);
      expect(service).toContain("Type=oneshot"); expect(timer).toContain("Persistent=true"); expect(timer).toContain("WantedBy=timers.target");
      if (name !== "backup") expect(service).toContain("docker compose run --rm web node ops/");
    });
  }
  it("creates a custom-format dump, verifies it, and retains only Tally dumps", () => {
    const script = read("ops/backup-postgres.sh");
    expect(script).toContain("pg_dump --format=custom"); expect(script).toContain("pg_restore --list");
    expect(script).toContain("/var/backups/tally"); expect(script).toContain("-name 'tally-*.dump'");
  });
  it("runs MCP without application database credentials", () => {
    const compose = read("docker/compose.production.yml"), mcp = compose.slice(compose.indexOf("  mcp:"));
    expect(mcp).toContain("TALLY_API_BASE_URL"); expect(mcp).not.toContain("env_file"); expect(mcp).not.toContain("DATABASE_URL");
  });
});
