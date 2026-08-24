/**
 * Tally MCP server entry point.
 *
 * A standalone Node process that speaks MCP over streamable HTTP, behind the
 * existing Caddy reverse proxy for TLS. It imports the same services the web
 * app calls, so authorization, auditing, and rate limiting are identical.
 *
 * Run with: pnpm mcp
 *
 * Specification: docs/MCP-PRD.md
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpServer } from "./server.js";
import { resolveApiToken } from "@/server/services/api-keys";
import { authStore } from "./context.js";

const PORT = parseInt(process.env.MCP_PORT ?? "3201", 10);

/* ---------------------------------------------------------- body parsing */

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/* ---------------------------------------------------------- HTTP handler */

function jsonError(res: ServerResponse, status: number, error: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error }));
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  // CORS preflight for remote MCP clients.
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Session-Id",
      "Access-Control-Max-Age": "86400",
    });
    res.end();
    return;
  }

  // Only the /mcp endpoint exists.
  const path = (req.url ?? "").split("?")[0];
  if (path !== "/mcp") {
    jsonError(res, 404, "Not found");
    return;
  }

  // GET and DELETE are used by stateful sessions (SSE and session
  // termination). In stateless mode we only need POST, but respond cleanly
  // to the others so a misconfigured client gets a useful error.
  if (req.method === "GET") {
    jsonError(res, 405, "Stateless server: SSE sessions are not supported. Use POST.");
    return;
  }
  if (req.method === "DELETE") {
    jsonError(res, 405, "Stateless server: session termination is not supported.");
    return;
  }
  if (req.method !== "POST") {
    jsonError(res, 405, "Method not allowed");
    return;
  }

  // ---- Auth: Bearer token required on every request.
  const authHeader = req.headers.authorization ?? "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    jsonError(res, 401, "Bearer token required. Create one in Settings > Security > API tokens.");
    return;
  }

  const rawToken = authHeader.slice(7).trim();
  const resolved = await resolveApiToken(rawToken);
  if (!resolved) {
    jsonError(res, 401, "Invalid, expired, or revoked token.");
    return;
  }

  // ---- Parse the JSON-RPC body.
  const body = await readBody(req);
  if (!body) {
    jsonError(res, 400, "Request body must be JSON.");
    return;
  }

  // ---- CORS headers on every response.
  res.setHeader("Access-Control-Allow-Origin", "*");

  // ---- Handle the MCP request with the auth context available to tools.
  try {
    await authStore.run(resolved, async () => {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
      });
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, body);
    });
  } catch (e) {
    console.error("[mcp] request failed:", e);
    if (!res.headersSent) {
      jsonError(res, 500, "Internal error");
    }
  }
});

server.listen(PORT, () => {
  console.log(`Tally MCP server listening on :${PORT}`);
});
