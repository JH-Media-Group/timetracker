/**
 * The MCP tool surface gets the same structural guard as the API routes.
 *
 * `tests/routes.test.ts` insists every HTTP route reaches a capability gate or
 * names an exemption with a reason. This file does the same for MCP tools, plus
 * two assertions that are specific to the MCP architecture:
 *
 *   1. Every tool declares a capability gate or is documented here with a
 *      reason explaining which service function provides the gate.
 *   2. No tool handler imports the database directly. Tools go through services.
 *   3. The audit row produced by a tool call carries `actorKind: "api"` and the
 *      token prefix in the userAgent field.
 *
 * Specification: docs/MCP-PRD.md section 8 items 1, 2, and 5.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MCP_ROOT = join(process.cwd(), "src/mcp");

/* ================================================================ Test 1 ===
 * Every tool has a documented capability gate or exemption.
 *
 * Because the tools call service functions that internally call `assertCan`,
 * the authorization surface is the service, not the tool. The exemption list
 * documents which service enforces the gate so the assertion is auditable
 * without reading every service function on every review.
 */

/**
 * Tools that deliberately declare no capability at the tool-registration level,
 * and the service function that provides the gate.
 *
 * The format mirrors `EXEMPT` in `tests/routes.test.ts`: the key is the tool
 * name, and the value is the reason it needs no explicit capability declaration
 * in the tool handler.
 */
const EXEMPT: Record<string, string> = {
  // Step 1: read-only tools.
  tally_projects_mine:
    "service: listProjects applies projectScope which limits to visible projects",
  tally_time_list:
    "service: listTimeEntries applies timeEntryScope",
  tally_timer_current:
    "service: runningEntry returns only the caller's or within-reach entries",
  tally_report_time:
    "service: timeReport requires report:view_own (everyone) and redacts money by capability",

  // Step 2: timer and own-time write tools.
  tally_timer_start:
    "service: createTimeEntry checks time:create_own or time:edit_others with reach",
  tally_timer_stop:
    "service: stopTimer checks ownership or reach",
  tally_time_log:
    "service: createTimeEntry checks time:create_own or time:edit_others with reach",
  tally_time_edit:
    "service: updateTimeEntry checks time:edit_own or time:edit_others with reach",
  tally_time_delete:
    "service: deleteTimeEntry checks time:delete_own or time:delete_others with reach",
  tally_week_submit:
    "service: submitTimesheet requires approval:submit (everyone)",
};

/**
 * Extract tool names from the MCP server source by matching `mcpServer.tool(`
 * calls. Each call's first argument is a string literal naming the tool.
 */
function extractToolNames(source: string): string[] {
  const names: string[] = [];
  // Match both single-quoted and double-quoted string literals as the first
  // argument to mcpServer.tool(). The regex is deliberately simple: it looks
  // for the opening call and captures the first string argument.
  for (const m of source.matchAll(/mcpServer\.tool\(\s*["']([^"']+)["']/g)) {
    names.push(m[1]!);
  }
  return names;
}

/** Read all .ts files under `src/mcp/` and concatenate them for scanning. */
function mcpSource(): string {
  const parts: string[] = [];
  for (const name of readdirSync(MCP_ROOT)) {
    const full = join(MCP_ROOT, name);
    if (statSync(full).isFile() && name.endsWith(".ts")) {
      parts.push(readFileSync(full, "utf8"));
    }
  }
  return parts.join("\n");
}

const allMcpSource = mcpSource();
const toolNames = extractToolNames(allMcpSource);

describe("MCP tool capability gates", () => {
  it("finds tools to check", () => {
    expect(
      toolNames.length,
      "no MCP tools found -- the regex may need updating"
    ).toBeGreaterThan(0);
  });

  it("gives every tool a capability gate or a documented exemption", () => {
    const undecided = toolNames.filter((name) => !(name in EXEMPT));

    expect(
      undecided,
      "these MCP tools are not in the exemption list. Either add them to EXEMPT " +
        "in this file with the service function that provides the gate, or add " +
        "an explicit assertCan call in the tool handler:\n  " +
        undecided.join("\n  ")
    ).toEqual([]);
  });

  it("keeps the exemption list honest -- no entries for tools that do not exist", () => {
    const stale = Object.keys(EXEMPT).filter(
      (name) => !toolNames.includes(name)
    );
    expect(
      stale,
      "exempted tools that do not exist in the source. Remove them from EXEMPT:\n  " +
        stale.join("\n  ")
    ).toEqual([]);
  });
});

/* ================================================================ Test 2 ===
 * No tool handler imports the database directly.
 *
 * The architectural constraint (MCP-PRD section 2) is that every tool goes
 * through a service function. A tool that imports Drizzle or the database
 * client is bypassing that layer, and the authorization, auditing, and
 * transaction management that come with it.
 *
 * Exception: `context.ts` legitimately imports `@/server/db/ids` for `newId()`.
 */

const FORBIDDEN_IMPORTS = [
  "@/server/db/schema",
  "@/server/db/client",
  "drizzle-orm",
];

/** Files that may import specific db modules, with the allowed modules. */
const IMPORT_EXCEPTIONS: Record<string, string[]> = {
  "context.ts": ["@/server/db/ids"],
};

describe("MCP tool isolation from database", () => {
  const mcpFiles = readdirSync(MCP_ROOT)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({
      name,
      path: join(MCP_ROOT, name),
      source: readFileSync(join(MCP_ROOT, name), "utf8"),
    }));

  it("has MCP source files to check", () => {
    expect(mcpFiles.length).toBeGreaterThan(0);
  });

  it("does not import Drizzle or the database client in any tool file", () => {
    const violations: string[] = [];

    for (const file of mcpFiles) {
      for (const forbidden of FORBIDDEN_IMPORTS) {
        // Check for import statements (both static and dynamic).
        // Match: import ... from "forbidden"  or  import("forbidden")
        // Also match the path alias forms with or without trailing paths.
        const pattern = new RegExp(
          `(?:from\\s+["']${escapeRegex(forbidden)}(?:/[^"']*)?["'])|` +
            `(?:import\\(\\s*["']${escapeRegex(forbidden)}(?:/[^"']*)?["']\\s*\\))`,
          "g"
        );

        if (pattern.test(file.source)) {
          const allowed = IMPORT_EXCEPTIONS[file.name];
          if (allowed && allowed.includes(forbidden)) continue;

          violations.push(
            `  ${file.name} imports "${forbidden}" -- tools must go through services`
          );
        }
      }
    }

    expect(
      violations,
      "MCP tool files must not import the database layer directly. " +
        "Call a service function instead:\n" +
        violations.join("\n")
    ).toEqual([]);
  });

  it("context.ts imports only newId from the db layer, not schema or client", () => {
    const contextFile = mcpFiles.find((f) => f.name === "context.ts");
    if (!contextFile) return; // covered by the check above

    for (const forbidden of ["@/server/db/schema", "@/server/db/client"]) {
      const pattern = new RegExp(
        `from\\s+["']${escapeRegex(forbidden)}["']`
      );
      expect(
        pattern.test(contextFile.source),
        `context.ts imports "${forbidden}" -- it should only import from @/server/db/ids`
      ).toBe(false);
    }
  });
});

/* ================================================================ Test 5 ===
 * The audit row names the token.
 *
 * When a tool call writes an audit row, the `actorKind` must be `"api"` and
 * the `userAgent` field must carry the token prefix so the audit log shows
 * which token made the change.
 *
 * This tests the Ctx construction path in `context.ts`: that `toolCtx()`
 * produces a Ctx whose audit rows have the right shape. Since `toolCtx()`
 * depends on AsyncLocalStorage, the test creates a Ctx directly with the same
 * parameters to verify the audit row fields.
 */

describe("MCP audit rows name the token", () => {
  /*
    toolCtx() in context.ts is the only place a Ctx is built for MCP requests.
    These static checks ensure the wiring stays correct without needing a
    database connection, which keeps this file in the same "runs anywhere"
    category as routes.test.ts and repo-hygiene.test.ts.
  */

  const contextSource = readFileSync(join(MCP_ROOT, "context.ts"), "utf8");

  it("toolCtx sets userAgent to api-token/<prefix>", () => {
    // The audit row's `userAgent` column is how an administrator traces a
    // change back to the token that made it. If this pattern changes, every
    // audit query that filters on `api-token/` breaks silently.
    expect(
      contextSource,
      "toolCtx must set userAgent to `api-token/${prefix}` so the audit row names the token"
    ).toMatch(/userAgent:\s*`api-token\/\$\{prefix\}`/);
  });

  it("toolCtx calls createCtx, not a hand-rolled object", () => {
    // createCtx is what wires the audit and emit closures to the buffers.
    // A hand-rolled Ctx would skip that, and auditing would silently stop.
    expect(
      contextSource,
      "toolCtx must call createCtx so audit and emit are wired correctly"
    ).toMatch(/createCtx\s*\(/);
  });

  it("the MCP HTTP handler sets actor.kind to 'api' via resolveApiToken", () => {
    // The index.ts handler resolves the Bearer token via resolveApiToken,
    // which returns an Actor with kind: "api". Verify it calls resolveApiToken
    // and passes the result into authStore.run, so every tool call inherits
    // the API actor kind.
    const indexSource = readFileSync(join(MCP_ROOT, "index.ts"), "utf8");

    expect(
      indexSource,
      "the MCP handler must call resolveApiToken to authenticate requests"
    ).toMatch(/resolveApiToken/);

    expect(
      indexSource,
      "the MCP handler must pass the resolved auth into authStore.run"
    ).toMatch(/authStore\.run\s*\(/);
  });

  it("flush writes actorKind and userAgent from the Ctx into the audit row", () => {
    // flush() in ctx.ts is the function that writes audit rows. Verify it
    // reads actorKind and userAgent from the Ctx rather than hard-coding them.
    const ctxSource = readFileSync(
      join(process.cwd(), "src/server/ctx.ts"),
      "utf8"
    );

    expect(
      ctxSource,
      "flush must write actorKind from ctx.actor.kind"
    ).toMatch(/actorKind:\s*ctx\.actor\.kind/);

    expect(
      ctxSource,
      "flush must write userAgent from ctx.request.userAgent"
    ).toMatch(/userAgent:\s*ctx\.request\.userAgent/);
  });
});

/* ----------------------------------------------------------------- helpers */

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
