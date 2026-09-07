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
 *
 * A GUARD THAT CANNOT READ SOMETHING SAYS SO
 *
 * The first version of this file had three ways to pass while checking
 * nothing, all of them silent: a call written `post<Record<string, X>>(...)`
 * did not match its opener regex, a path built by concatenation did not match
 * any route, and a call inside a comment counted as a real one. Every one of
 * those is a false pass on the check whose entire job is to notice a missing
 * key, which is the same failure the guard exists to prevent, one level up.
 *
 * So the parsing is deliberate rather than regex-shaped: comments are removed
 * first, generic arguments are walked rather than matched, and a call whose
 * path this file cannot read statically fails the suite with a message saying
 * so. A guard is allowed to be defeated by a hard case. It is not allowed to
 * be defeated quietly.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const API_ROOT = join(process.cwd(), "src/app/api/v1");
const CLIENT = join(process.cwd(), "src/lib/api.ts");

/** The client helpers that issue a request. Only `post` can carry a key. */
const HELPERS = ["post", "put", "patch", "patch_", "del"] as const;

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
    .map((file) => relative(API_ROOT, file).split(sep).slice(0, -1).join("/"));
}

/**
 * The source with comments blanked out, offsets preserved.
 *
 * Blanked rather than removed so every index below still lines up with the
 * real file, which is what makes a failure message point at the right place.
 * The scan tracks string and template state as it goes, because `"// not a
 * comment"` inside a path is exactly the kind of thing this file handles.
 */
function withoutComments(source: string): string {
  const out = source.split("");
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let j = from; j < to; j++) if (out[j] !== "\n") out[j] = " ";
  };

  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];

    if (c === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      blank(i, end === -1 ? source.length : end);
      i = end === -1 ? source.length : end;
    } else if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < source.length) {
        if (source[i] === "\\") { i += 2; continue; }
        if (source[i] === quote) { i++; break; }
        i++;
      }
    } else {
      i++;
    }
  }

  return out.join("");
}

/** Walk a balanced `<...>` starting at `open`, or -1 if it does not close. */
function skipGenerics(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "<") depth++;
    else if (source[i] === ">") {
      depth--;
      if (depth === 0) return i + 1;
    } else if (source[i] === "(" || source[i] === ")" || source[i] === ";") {
      // A type argument list does not contain these at this level. Hitting one
      // means the `<` was a comparison, not a generic.
      return -1;
    }
  }
  return -1;
}

interface Call {
  helper: string;
  /** The first argument's source text, trimmed. */
  path: string;
  /** Where the argument list starts, for resolving a binding declared above it. */
  index: number;
  /** The whole argument list, which is where a key would be. */
  text: string;
  line: number;
}

/**
 * Every request-helper call in the client, as its full source text.
 *
 * Balanced on parentheses rather than split on commas, because the payloads
 * contain both, and generic arguments are walked rather than pattern-matched,
 * because `post<Record<string, string>>(` defeats any regex written for
 * `post<T>(`.
 */
function helperCalls(source: string): Call[] {
  const code = withoutComments(source);
  const calls: Call[] = [];
  const opener = new RegExp(`\\b(${HELPERS.join("|")})\\s*[<(]`, "g");

  for (let match = opener.exec(code); match; match = opener.exec(code)) {
    const helper = match[1]!;
    let cursor = match.index + match[0].length - 1;

    if (code[cursor] === "<") {
      cursor = skipGenerics(code, cursor);
      if (cursor === -1) continue; // a comparison, not a call
      while (cursor < code.length && /\s/.test(code[cursor]!)) cursor++;
      if (code[cursor] !== "(") continue;
    }

    const start = cursor + 1;
    let depth = 1;
    let i = start;
    for (; i < code.length && depth > 0; i++) {
      const c = code[i];
      if (c === "(") depth++;
      else if (c === ")") depth--;
    }

    // The first argument up to the first top-level comma is the path. Read it
    // from the real source, not the comment-blanked copy.
    const args = source.slice(start, i - 1);
    const argsCode = code.slice(start, i - 1);
    let commaDepth = 0;
    let cut = argsCode.length;
    for (let j = 0; j < argsCode.length; j++) {
      const c = argsCode[j];
      if (c === "(" || c === "{" || c === "[") commaDepth++;
      else if (c === ")" || c === "}" || c === "]") commaDepth--;
      else if (c === "," && commaDepth === 0) { cut = j; break; }
    }

    calls.push({
      helper,
      path: args.slice(0, cut).trim(),
      text: args,
      index: start,
      line: source.slice(0, start).split("\n").length,
    });
  }

  return calls;
}

/** A path this file can compare against a route: one whole string or template literal. */
const LITERAL = /^(["'`])(?:[^\\]|\\.)*?\1$/s;

/** The same text with string and template contents blanked, so operators can be found. */
function maskStrings(expr: string): string {
  const out = expr.split("");
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < expr.length) {
        if (expr[i] === "\\") { out[i] = " "; out[i + 1] = " "; i += 2; continue; }
        if (expr[i] === quote) { i++; break; }
        out[i] = " ";
        i++;
      }
    } else {
      i++;
    }
  }
  return out.join("");
}

/**
 * The initialiser of the nearest `const <name> = ...` declared above `before`.
 *
 * Three functions in the client name the path before passing it, because they
 * choose between two endpoints on a boolean and a named const reads better
 * than a ternary wedged into an argument list. Resolving one binding covers
 * all three, and anything deeper still fails loudly rather than quietly.
 */
function bindingAbove(name: string, before: number, code: string, source: string): string | null {
  const decl = new RegExp(String.raw`\bconst\s+` + name + String.raw`\s*=`, "g");
  let start = -1;
  for (let m = decl.exec(code); m && m.index < before; m = decl.exec(code)) {
    start = m.index + m[0].length;
  }
  if (start === -1) return null;

  let depth = 0;
  for (let i = start; i < before; i++) {
    const c = code[i];
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") depth--;
    else if (c === ";" && depth === 0) return source.slice(start, i);
  }
  return null;
}

/**
 * Every path a call could reach, or null if this file cannot tell.
 *
 * A literal is itself. A ternary between two literals is both of its branches,
 * which is how `archiveProject`, `archiveUser` and `reviewSubmission` are
 * written: one call, two endpoints, chosen by a boolean. The first version of
 * this guard could not read any of the three and quietly approved all of them.
 * Anything it still cannot read fails rather than passes.
 */
function literalPaths(expr: string, resolve?: (name: string) => string | null): string[] | null {
  const text = expr.trim();
  if (LITERAL.test(text)) return [text];

  if (resolve && /^[A-Za-z_$][\w$]*$/.test(text)) {
    const bound = resolve(text);
    // One hop only. A binding that resolves to another name is a shape this
    // file has not been taught, and it says so rather than approving it.
    return bound === null ? null : literalPaths(bound);
  }

  const mask = maskStrings(text);
  let depth = 0;
  let question = -1;
  let colon = -1;
  for (let i = 0; i < mask.length; i++) {
    const c = mask[i];
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") depth--;
    else if (depth !== 0) continue;
    // `?.` and `??` are not the conditional operator.
    else if (c === "?" && question === -1 && mask[i + 1] !== "." && mask[i + 1] !== "?") question = i;
    else if (c === ":" && question !== -1 && colon === -1) colon = i;
  }
  if (question === -1 || colon === -1) return null;

  const left = literalPaths(text.slice(question + 1, colon), resolve);
  const right = literalPaths(text.slice(colon + 1), resolve);
  return left && right ? [...left, ...right] : null;
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

describe("money-moving routes and the client that calls them", () => {
  const routes = requiredRoutes();
  const source = readFileSync(CLIENT, "utf8");
  const calls = helperCalls(source);
  const code = withoutComments(source);
  const pathsOf = (call: Call) =>
    literalPaths(call.path, (name) => bindingAbove(name, call.index, code, source));

  it("finds the routes and the calls, so the checks below are not vacuous", () => {
    // Without this, renaming the option or a client helper would leave every
    // assertion below passing over an empty list.
    expect(routes.length, "no route declares requireIdempotencyKey").toBeGreaterThanOrEqual(5);
    expect(calls.length, "no request-helper calls found in src/lib/api.ts").toBeGreaterThanOrEqual(20);
  });

  it("can read the path of every call it found", () => {
    /*
      The check below can only speak about calls whose path is a literal. One
      built by concatenation, or handed in as a variable, silently matches no
      route and is silently approved. Rather than let that happen, the guard
      stops and asks to be taught the new shape.
    */
    const unreadable = calls
      .filter((c) => pathsOf(c) === null)
      .map((c) => `src/lib/api.ts:${c.line} ${c.helper}(${c.path.slice(0, 60)})`);

    expect(
      unreadable,
      "These calls do not pass a literal path, so this guard cannot tell which route they reach. " +
        "Write the path as one template literal, or teach this test to resolve the new shape."
    ).toEqual([]);
  });

  for (const route of requiredRoutes()) {
    it(`/${route} is never called without a key`, () => {
      const matcher = pathMatcher(route);
      const reaching = calls.filter((call) => (pathsOf(call) ?? []).some((p) => matcher.test(p)));

      // `post` is the only helper that takes a key. Reaching a key-requiring
      // route through any other one is refused by the server every time.
      const wrongHelper = reaching
        .filter((c) => c.helper !== "post")
        .map((c) => `${c.helper} at src/lib/api.ts:${c.line}`);
      expect(
        wrongHelper,
        `POST /${route} requires an Idempotency-Key, and only \`post\` can send one.`
      ).toEqual([]);

      const offenders = reaching
        .filter((call) => call.helper === "post")
        .filter((call) => !call.text.includes("idempotencyKey"))
        .map((c) => `src/lib/api.ts:${c.line}`);

      expect(
        offenders,
        `POST /${route} requires an Idempotency-Key. These client calls send none, ` +
          "so the request is refused every time it is made."
      ).toEqual([]);
    });
  }
});
