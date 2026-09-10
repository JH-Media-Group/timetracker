/**
 * Calling a real route handler, as a real signed-in person.
 *
 * THE SEAM THIS EXISTS FOR
 *
 * Almost every test in this suite calls a service directly. That is the right
 * default: services hold the rules, and driving HTTP to assert a rule is slow
 * and tells you less. What it cannot see is the strip of code between the two,
 * where a handler unpacks a request and calls the service, and that strip is
 * where a defect hides best because nothing on either side of it looks wrong.
 *
 * `POST /time-entries/:id/stop` proved it. `stopTimer` has always taken an
 * optional user id, the client has always sent one, and the handler called
 * `stopTimer(ctx)` and dropped it. The service tests passed. The client was
 * correct. Stopping a teammate's timer silently stopped your own, and the fix
 * for t-DVQ2qW reached the client and died there, deployed and believed for a
 * day (t-DVQ2qW again).
 *
 * `tests/route-reachability.test.ts` catches "nothing calls this route". It
 * cannot catch "this route is called and ignores what it was sent". This can.
 *
 * WHAT IT DOES NOT DO
 *
 * It does not start a server. The handler is an exported function and this
 * builds the request it expects: a session cookie the real `resolveSession`
 * resolves, an Origin the real `assertSameOrigin` accepts, and the params Next
 * would have parsed out of the path. Everything inside the handler, including
 * capability checks, rate limits and the audit transaction, is the production
 * code path.
 *
 * Not a `.test.ts`, so Vitest does not collect it.
 */

import { createSession, SESSION_COOKIE } from "@/server/auth/session";
import { env } from "@/server/env";

/** The origin `assertSameOrigin` accepts, so mutations are not refused. */
const ORIGIN = env.APP_URL.replace(/\/$/, "");

export interface RouteCallOptions {
  /** The path as the browser would request it, e.g. `/api/v1/time-entries/current/stop`. */
  path: string;
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** A user id. Their session cookie rides along, so `ctx.actor` is them. */
  as?: string;
  body?: unknown;
  /** What Next would have parsed from the dynamic segments, e.g. `{ id }`. */
  params?: Record<string, string>;
  headers?: Record<string, string>;
}

/**
 * A signed-in session for a person, as a cookie header value.
 *
 * Goes through `createSession`, so the row, the hashing and the expiry are the
 * real ones. A hand-written cookie would prove only that the test can write a
 * string.
 */
export async function sessionCookie(userId: string): Promise<string> {
  const { token } = await createSession(userId, { userAgent: "vitest", ip: null });
  return `${SESSION_COOKIE}=${token}`;
}

/**
 * Invoke a route handler and hand back its response.
 *
 * The handler is typed against `NextRequest`, and a plain `Request` carries
 * every field the wrapper actually reads: method, url, headers, cookies and
 * body. Building a genuine `NextRequest` would need a server, which is the
 * thing this avoids. The cast is narrow and deliberate, and it is the same one
 * `tests/signin-limits.test.ts` already makes.
 */
export async function callRoute(
  handler: (req: never, context: never) => Promise<Response>,
  options: RouteCallOptions
): Promise<Response> {
  const method = options.method ?? (options.body === undefined ? "GET" : "POST");

  const headers: Record<string, string> = {
    origin: ORIGIN,
    ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    ...options.headers,
  };

  if (options.as) headers.cookie = await sessionCookie(options.as);

  const request = new Request(new URL(options.path, ORIGIN).toString(), {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });

  /*
    The one place a plain Request is not enough.

    `readCookie` in `src/server/auth/session.ts` uses `req.cookies.get(name)`,
    which is a NextRequest API and simply absent here, so every authenticated
    call threw before reaching the handler. Rather than reach for a real
    NextRequest, which wants a server, this adds the accessor the wrapper
    actually calls, reading the Cookie header the request already carries.

    Deliberately minimal. Shimming more of NextRequest would start replacing the
    thing under test with a model of it, and the value of this harness is that
    everything past this line is production code.
  */
  Object.defineProperty(request, "cookies", {
    value: {
      get(name: string) {
        const jar = request.headers.get("cookie") ?? "";
        for (const pair of jar.split(";")) {
          const [key, ...rest] = pair.trim().split("=");
          if (key === name) return { name, value: rest.join("=") };
        }
        return undefined;
      },
    },
  });

  /*
    Next hands the second argument as `{ params: Promise<...> }`, and the
    wrapper awaits it. A resolved promise is exactly what it would receive.
  */
  const context = { params: Promise.resolve(options.params ?? {}) };

  return handler(request as never, context as never);
}

/** The `data` out of the `{ data, meta }` envelope, or throws with the problem. */
export async function jsonData<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as { data?: T; detail?: string };
  if (!response.ok) {
    throw new Error(`${response.status}: ${payload.detail ?? "request failed"}`);
  }
  return payload.data as T;
}
