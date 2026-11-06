import { createServer, type Server } from "node:http";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";
import { GET as tokenInfo } from "@/app/api/v1/auth/token-info/route";
import { GET as projects } from "@/app/api/v1/projects/route";
import { GET as tasks } from "@/app/api/v1/tasks/route";
import { GET as clients } from "@/app/api/v1/clients/route";
import { GET as timer } from "@/app/api/v1/time-entries/running/route";
import { POST as register } from "@/app/oauth/register/route";
import { POST as exchange } from "@/app/oauth/token/route";
import { GET as request } from "@/app/api/v1/oauth/request/route";
import { POST as consent } from "@/app/api/v1/oauth/authorize/route";
import { POST as createToken } from "@/app/api/v1/api-tokens/route";

const routes: Record<string, (req: NextRequest, context: { params: Promise<Record<string, string>> }) => Promise<Response>> = {
  "GET /api/v1/auth/token-info": tokenInfo,
  "GET /api/v1/projects": projects, "GET /api/v1/tasks": tasks, "GET /api/v1/clients": clients,
  "GET /api/v1/time-entries/running": timer,
  "POST /oauth/register": register, "POST /oauth/token": exchange,
  "GET /api/v1/oauth/request": request, "POST /api/v1/oauth/authorize": consent,
  "POST /api/v1/api-tokens": createToken,
};

/** Network bridge only. Middleware, route auth, services and DB are real. */
export function apiHttpServer() {
  return createServer(async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      }
      const req = new NextRequest(`http://${incoming.headers.host}${incoming.url}`, {
        method: incoming.method, headers, ...(bytes.length ? { body: bytes } : {}),
      });
      let response: Response = middleware(req);
      if (response.headers.get("x-middleware-next") === "1") {
        const handler = routes[`${req.method} ${req.nextUrl.pathname}`];
        response = handler ? await handler(req, { params: Promise.resolve({}) }) : new Response(null, { status: 404 });
      }
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      outgoing.writeHead(500); outgoing.end("test_bridge_failed");
    }
  });
}

export async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  return `http://127.0.0.1:${address.port}`;
}

export async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
