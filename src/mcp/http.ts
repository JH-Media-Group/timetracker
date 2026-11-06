import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { TallyApi, TallyApiError, TallyApiUnavailable } from "./api-client.js";
import { requestStore, type TokenInfo } from "./context.js";
import { createMcpServer } from "./server.js";

async function body(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_048_576) throw new Error("request_too_large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function respond(res: ServerResponse, status: number, error: string, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify({ error, request_id: res.getHeader("x-request-id") }));
}

/** Kept separate from the process entrypoint so tests exercise the real wire. */
export function createMcpHttpServer(options: { baseUrl: string; publicUrl: string }) {
  const publicUrl = options.publicUrl.replace(/\/$/, "");
  const origin = new URL(publicUrl).origin;
  const challenge = `Bearer resource_metadata="${publicUrl}/.well-known/oauth-protected-resource", scope="tally.read"`;
  return createServer(async (req, res) => {
    const requestId = randomUUID();
    res.setHeader("x-request-id", requestId);
    res.setHeader("cache-control", "no-store");
    if ((req.url ?? "").split("?")[0] !== "/mcp") return respond(res, 404, "not_found");
    if (req.headers.origin && req.headers.origin !== origin) return respond(res, 403, "invalid_origin");
    if (req.method !== "POST") return respond(res, 405, "method_not_allowed", { allow: "POST" });
    const header = req.headers.authorization ?? "";
    if (!/^Bearer\s+\S+$/i.test(header)) return respond(res, 401, "bearer_required", { "www-authenticate": challenge });
    const api = new TallyApi(options.baseUrl, header.replace(/^Bearer\s+/i, ""));
    try {
      // No authorization cache: revocation and changed permissions apply now.
      const token = (await api.get<TokenInfo>("/auth/token-info")).data;
      const payload = await body(req);
      await requestStore.run({ api, token }, async () => {
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        const server = createMcpServer();
        res.once("close", () => { void server.close().catch(() => {}); });
        await server.connect(transport);
        await transport.handleRequest(req, res, payload);
      });
    } catch (error) {
      if (res.headersSent) return;
      if (error instanceof TallyApiError) {
        if (error.status === 401) return respond(res, 401, "invalid_token", { "www-authenticate": `${challenge}, error="invalid_token"` });
        if (error.status === 429) {
          const delay = error.problem.retryAfter;
          const retryAfter = Number.isFinite(delay) && delay! > 0 ? Math.ceil(delay!) : 60;
          return respond(res, 429, "rate_limited", { "retry-after": String(retryAfter) });
        }
        if (error.status === 403) return respond(res, 403, "forbidden");
        return respond(res, 502, "api_unavailable");
      }
      if (error instanceof TallyApiUnavailable) return respond(res, 503, "api_unavailable", { "retry-after": "5" });
      if (error instanceof SyntaxError) return respond(res, 400, "invalid_json");
      if (error instanceof Error && error.message === "request_too_large") return respond(res, 413, "request_too_large");
      // Do not log exception objects: they can contain URLs, headers or data.
      console.error(`[mcp] request ${requestId} failed`);
      respond(res, 500, "internal_error");
    }
  });
}
