import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { TallyApi, TallyApiUnavailable } from "@/mcp/api-client";
import { createMcpHttpServer } from "@/mcp/http";
import { listen, close } from "./support/mcp-http-harness";

let url: string, committedWrites = 0;
const apiServer = createServer((req, res) => {
  if (req.url?.endsWith("/stall")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"data":');
  } else if (req.url?.endsWith("/write")) {
    committedWrites++;
    // The write completed; losing its response does not make retry safe.
  } else {
    res.writeHead(200, { "content-type": "application/json" }); res.end("{}");
  }
});
beforeAll(async () => { url = await listen(apiServer); });
afterAll(async () => { await close(apiServer); });

describe("MCP network failures", () => {
  it("does not turn an interrupted successful body into empty success", async () => {
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const short = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => timeout(100));
    try { await expect(new TallyApi(url, "test").get("/stall")).rejects.toMatchObject({ outcomeUnknown: false }); }
    finally { short.mockRestore(); }
  });
  it("reports a lost write response as unknown outcome without retry advice", async () => {
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const short = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => timeout(100));
    try {
      const result = new TallyApi(url, "test").post("/write", { value: 1 });
      await expect(result).rejects.toMatchObject({ outcomeUnknown: true });
      expect(committedWrites).toBe(1);
    } finally { short.mockRestore(); }
  });
  it("rejects a malformed successful read envelope", async () => {
    await expect(new TallyApi(url, "test").get("/malformed")).rejects.toBeInstanceOf(TallyApiUnavailable);
  });
  it("reports unavailable introspection as 503 rather than authentication failure", async () => {
    const dead = createServer();
    const deadUrl = await listen(dead); await close(dead);
    const server = createMcpHttpServer({ baseUrl: deadUrl, publicUrl: "https://tally.example" });
    const mcp = await listen(server);
    try {
      const response = await fetch(`${mcp}/mcp`, { method: "POST", headers: { authorization: "Bearer test" }, body: "{}" });
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("5");
      expect((await response.json()).error).toBe("api_unavailable");
    } finally { await close(server); }
  });
});
