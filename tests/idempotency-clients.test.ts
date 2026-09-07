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
 * This is that connection. It reads the route files for the requirement and the
 * client for the call, and fails if a required route is reachable from
 * `src/lib/api.ts` without a key.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const API_ROOT = join(process.cwd(), "src/app/api/v1");
const CLIENT = join(process.cwd(), "src/lib/api.ts");

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) routeFiles(full, out);
    else if (name === "route.ts") out.push(full);
  }
  return out;
}

/**
 * Routes that refuse a request without an Idempotency-Key, as path segments.
 *
 * Matches the option being SET, not the word appearing. The first version
 * matched anywhere in the file and immediately caught a route whose comment
 * explained why it deliberately does not use the option, which would have made
 * the guard demand a key that the server never asks for.
 */
function requiredRoutes(): string[] {
  return routeFiles(API_ROOT)
    .filter((file) => /requireIdempotencyKey\s*:\s*true/.test(readFileSync(file, "utf8")))
    .map((file) =>
      relative(API_ROOT, file).split(sep).slice(0, -1).join("/")
    );
}

/**
 * A route path as a matcher for the client's template literal.
 *
 * `retainers/[id]/adjust` has to match `` `/retainers/${id}/adjust` ``, and the
 * client names its variables differently in different functions, so a dynamic
 * segment matches any interpolation.
 */
function pathMatcher(route: string): RegExp {
  const body = route
    .split("/")
    .map((seg) => (seg.startsWith("[") ? "\\$\\{[^}]+\\}" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return new RegExp("^[\"'`]/" + body + "[\"'`]$");
}

/**
 * Every `post(...)` call in the client, as its full source text.
 *
 * Balanced on parentheses rather than split on commas, because the payloads
 * contain both.
 */
function postCalls(source: string): { path: string; text: string }[] {
  const calls: { path: string; text: string }[] = [];
  const opener = /\bpost\s*<[^>]*>\s*\(|\bpost\s*\(/g;

  for (let match = opener.exec(source); match; match = opener.exec(source)) {
    const start = match.index + match[0].length;
    let depth = 1;
    let i = start;
    for (; i < source.length && depth > 0; i++) {
      const c = source[i];
      if (c === "(") depth++;
      else if (c === ")") depth--;
    }
    const text = source.slice(start, i - 1);
    // The first argument up to the first top-level comma is the path.
    let commaDepth = 0;
    let cut = text.length;
    for (let j = 0; j < text.length; j++) {
      const c = text[j];
      if (c === "(" || c === "{" || c === "[") commaDepth++;
      else if (c === ")" || c === "}" || c === "]") commaDepth--;
      else if (c === "," && commaDepth === 0) { cut = j; break; }
    }
    calls.push({ path: text.slice(0, cut).trim(), text });
  }
  return calls;
}

describe("money-moving routes and the client that calls them", () => {
  const routes = requiredRoutes();
  const source = readFileSync(CLIENT, "utf8");
  const calls = postCalls(source);

  it("finds the routes and the calls, so the checks below are not vacuous", () => {
    // Without this, renaming the option or the client's `post` helper would
    // leave every assertion below passing over an empty list.
    expect(routes.length, "no route declares requireIdempotencyKey").toBeGreaterThanOrEqual(5);
    expect(calls.length, "no post() calls found in src/lib/api.ts").toBeGreaterThanOrEqual(20);
  });

  for (const route of requiredRoutes()) {
    it(`/${route} is never called without a key`, () => {
      const matcher = pathMatcher(route);
      const offenders = calls
        .filter((call) => matcher.test(call.path))
        .filter((call) => !call.text.includes("idempotencyKey"));

      expect(
        offenders.map((o) => o.path),
        `POST /${route} requires an Idempotency-Key. These client calls send none, ` +
          "so the request is refused every time it is made."
      ).toEqual([]);
    });
  }
});
