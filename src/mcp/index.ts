import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { TallyApi, TallyApiError } from "./api-client.js";
import { requestStore, type TokenInfo } from "./context.js";
import { createMcpServer } from "./server.js";

const port = Number(process.env.MCP_PORT ?? 3201);
const baseUrl = process.env.TALLY_API_BASE_URL;
if (!baseUrl) throw new Error("TALLY_API_BASE_URL is required");
const publicUrl = (process.env.TALLY_PUBLIC_URL ?? baseUrl).replace(/\/$/, "");

async function body(req: IncomingMessage) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { const b = Buffer.from(chunk); size += b.length; if (size > 1_048_576) throw new Error("request_too_large"); chunks.push(b); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function respond(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers }); res.end(JSON.stringify(value)); }
function unauthorized(res: ServerResponse, error: string) {
  return respond(res, 401, { error }, { "www-authenticate": `Bearer resource_metadata="${publicUrl}/.well-known/oauth-protected-resource"` });
}

createServer(async (req, res) => {
  if ((req.url ?? "").split("?")[0] !== "/mcp") return respond(res, 404, { error: "not_found" });
  if (req.method !== "POST") return respond(res, 405, { error: "method_not_allowed" });
  const header = req.headers.authorization ?? "";
  if (!/^Bearer\s+\S+$/i.test(header)) return unauthorized(res, "bearer_required");
  const bearer = header.replace(/^Bearer\s+/i, "");
  const api = new TallyApi(baseUrl, bearer);
  try {
    const token = (await api.get<TokenInfo>("/auth/token-info")).data;
    const payload = await body(req);
    await requestStore.run({ api, token }, async () => {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const server = createMcpServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, payload);
    });
  } catch (error) {
    if (error instanceof TallyApiError && error.status === 401) return unauthorized(res, "invalid_token");
    if (error instanceof SyntaxError) return respond(res, 400, { error: "invalid_json" });
    if (error instanceof Error && error.message === "request_too_large") return respond(res, 413, { error: "request_too_large" });
    console.error("[mcp] request failed", error);
    if (!res.headersSent) respond(res, 500, { error: "internal_error" });
  }
}).listen(port, () => console.log(`Tally MCP listening on :${port}`));
