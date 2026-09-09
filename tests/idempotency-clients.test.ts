/**
 * A route that demands an Idempotency-Key has a client that sends one.
 *
 * `requireIdempotencyKey: true` is the strongest guard in this codebase: it
 * refuses a money-moving request outright rather than risk billing a client
 * twice. It is also, from the outside, indistinguishable from a broken feature.
 *
 * Both recurring-invoice writes shipped without a key on the client side, so
 * "New recurring invoice" and "Issue now" answered
 *
 *   Could not save. This request creates a money-moving record and needs an
 *   Idempotency-Key header
 *
 * every single time, for anybody, from the day they shipped. Person02 reported it
 * from production (t-wjV2jO). Nothing failed: the route was right, the client
 * was wrong, and no test connected the two.
 *
 * This is that connection. The reading of both halves now lives in
 * `tests/support/client-surface.ts`, shared with
 * `tests/route-reachability.test.ts`, which asks the broader question of
 * whether anything calls a route at all. This file asks the narrower one: when
 * something does call it, does it carry the header.
 */


import { describe, expect, it } from "vitest";
import {
  clientCalls,
  expandLiteral,
  matchRoute,
  routeMethods,
} from "./support/client-surface";

describe("money-moving routes and the client that calls them", () => {
  const routes = routeMethods();
  const calls = clientCalls();

  /**
   * One exported method's own declaration, not the whole file.
   *
   * A route file often exports several methods, and the option belongs to one
   * of them. Reading the file as a whole made `GET /invoices` inherit the
   * requirement from the `POST` beside it and demand a key on a read, which no
   * `get` call can send and no server ever asked for.
   */
  const declarationFor = (source: string, method: string): string => {
    const start = source.search(
      new RegExp(`export\\s+(?:const\\s+${method}\\s*=|(?:async\\s+)?function\\s+${method}\\s*\\()`)
    );
    if (start === -1) return "";
    const rest = source.slice(start + 1);
    const next = rest.search(/\bexport\s+(?:const|(?:async\s+)?function)\s+(?:GET|POST|PATCH|PUT|DELETE)\b/);
    return next === -1 ? rest : rest.slice(0, next);
  };

  /**
   * Routes that refuse a request without an Idempotency-Key.
   *
   * Matches the option being SET, not the word appearing. An earlier version
   * matched anywhere in the file and immediately caught a route whose comment
   * explained why it deliberately does not use the option, which would have
   * made the guard demand a key the server never asks for.
   */
  const required = routes.filter((r) =>
    /requireIdempotencyKey\s*:\s*true/.test(declarationFor(r.source, r.method))
  );

  it("finds the routes and the calls, so the checks below are not vacuous", () => {
    expect(required.length, "no route declares requireIdempotencyKey").toBeGreaterThanOrEqual(5);
    expect(calls.length, "no client calls found").toBeGreaterThanOrEqual(90);
  });

  for (const route of required) {
    it(`${route.method} /${route.route} is never called without a key`, () => {
      const reaching = calls.filter((call) =>
        (call.paths ?? []).some((raw) =>
          expandLiteral(raw).some((path) => {
            const hit = matchRoute(path, routes.filter((r) => r.method === call.method));
            return hit?.route === route.route && hit.method === route.method;
          })
        )
      );

      // `post` is the only helper that can carry a key. Reaching a
      // key-requiring route through any other one is refused every time.
      const wrongHelper = reaching
        .filter((c) => c.helper !== "post")
        .map((c) => `${c.helper} at src/lib/api.ts:${c.line}`);
      expect(
        wrongHelper,
        `${route.method} /${route.route} requires an Idempotency-Key, and only \`post\` can send one.`
      ).toEqual([]);

      const offenders = reaching
        .filter((c) => c.helper === "post")
        .filter((c) => !c.text.includes("idempotencyKey"))
        .map((c) => `src/lib/api.ts:${c.line}`);

      expect(
        offenders,
        `${route.method} /${route.route} requires an Idempotency-Key. These client calls send none, ` +
          "so the request is refused every time it is made."
      ).toEqual([]);
    });
  }
});
