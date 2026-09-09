/**
 * Reading the two halves of the HTTP seam, so tests can compare them.
 *
 * `src/app/api/v1/**` declares what the server answers. `src/lib/api.ts` is the
 * only file in the application that speaks HTTP, so it declares what the client
 * ever asks for. Nothing in the type system connects the two, and the gap
 * between them has been the defining defect of this codebase: a route and a
 * service, both correct and both tested, that no screen could reach.
 *
 * Found that way so far: both recurring-invoice writes, sign-out, expense
 * editing, `rateMissing`, task delete, entry duplicate, the re-rate action and
 * `PATCH /me`. Every one shipped looking finished. Every one was found by a
 * person hitting it.
 *
 * This module is the shared parsing. It is deliberately conservative: when it
 * cannot read a call it says so rather than guessing, because a guard that
 * quietly approves what it does not understand is the same defect one level up.
 * Not a `.test.ts`, so Vitest does not collect it.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const API_ROOT = join(process.cwd(), "src/app/api/v1");
export const CLIENT = join(process.cwd(), "src/lib/api.ts");

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/**
 * The client's request helpers, and the method each one sends.
 *
 * `report` is not one of the five thin wrappers over `request`; it is a local
 * helper in `src/lib/api.ts` that takes a path and issues a GET, and the four
 * report functions go through it. It is listed because it exists, not because
 * the shape is special.
 *
 * A new wrapper that is not listed here makes every route behind it read as
 * unreached, so the reachability test fails and somebody adds it. That is the
 * right direction to fail in: the alternative is a scanner that silently
 * approves paths it cannot see, which is the defect this whole file exists to
 * catch, one level up.
 */
const HELPER_METHOD: Record<string, HttpMethod> = {
  get: "GET",
  post: "POST",
  patch: "PATCH",
  patch_: "PATCH",
  put: "PUT",
  del: "DELETE",
  report: "GET",
};

/* --------------------------------------------------------------- scanning */

/**
 * The source with comments blanked out, offsets preserved.
 *
 * Blanked rather than removed so every index still lines up with the real file,
 * which is what makes a failure message point at the right line. The scan
 * tracks string and template state as it goes, because `"// not a comment"`
 * inside a path is exactly the kind of thing this handles.
 */
export function withoutComments(source: string): string {
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

/**
 * Walk a balanced `<...>` starting at `open`, or -1 if it is not a generic.
 *
 * Every bracket kind is tracked, not just the angles. A first version gave up
 * on the first `(`, `)` or `;` it saw, which is true of a simple `<T>` and
 * false of most real type arguments here: `get<{ password: boolean; google:
 * boolean }>` contains a semicolon, so the walker skipped the call entirely and
 * nine routes read as unreachable that were being called all along. That is
 * exactly the false pass this file exists to prevent, one level up.
 *
 * `=>` inside a type argument is an arrow, not a closing angle.
 */
function skipGenerics(source: string, open: number): number {
  let angle = 0;
  let curly = 0;
  let paren = 0;
  let square = 0;

  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (c === "{") curly++;
    else if (c === "}") curly--;
    else if (c === "[") square++;
    else if (c === "]") square--;
    else if (c === "(") paren++;
    else if (c === ")") {
      if (paren === 0) return -1; // closed past our own start: a comparison
      paren--;
    } else if (c === "<") angle++;
    else if (c === ">") {
      if (source[i - 1] === "=") continue; // an arrow, not an angle
      angle--;
      if (angle === 0 && curly === 0 && paren === 0 && square === 0) return i + 1;
    } else if (c === ";" && curly === 0 && paren === 0) {
      return -1;
    }
  }
  return -1;
}

/** A path this file can compare against a route: one whole string or template. */
const LITERAL = /^(["'`])(?:[^\\]|\\.)*?\1$/s;

/** The same text with string contents blanked, so operators can be found. */
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
 * Several client functions name the path before passing it, because they choose
 * between two endpoints on a boolean and a named const reads better than a
 * ternary wedged into an argument list. Resolving one binding covers all of
 * them, and anything deeper still fails loudly rather than quietly.
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
 * Every path an expression could evaluate to, or null if it cannot be read.
 *
 * A literal is itself. A ternary between two literals is both branches. A bare
 * identifier resolves through one `const` binding. Anything else is unreadable,
 * and unreadable fails rather than passes.
 */
export function literalPaths(
  expr: string,
  resolve?: (name: string) => string | null
): string[] | null {
  const text = expr.trim();
  if (LITERAL.test(text)) return [text];

  if (resolve && /^[A-Za-z_$][\w$]*$/.test(text)) {
    const bound = resolve(text);
    // One hop only: a binding that resolves to another name is a shape this
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

/* ------------------------------------------------------------ client calls */

export interface ClientCall {
  /** The helper used: `get`, `post`, `del`, or `request` for the raw form. */
  helper: string;
  method: HttpMethod;
  /** Every path this call could reach, or null when it cannot be read. */
  paths: string[] | null;
  /** The whole argument list, for checks that look for a header or option. */
  text: string;
  line: number;
}

/** Split an argument list into its top-level arguments. */
function splitArgs(args: string, argsCode: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < argsCode.length; i++) {
    const c = argsCode[i];
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") depth--;
    else if (c === "," && depth === 0) {
      parts.push(args.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(args.slice(start));
  return parts.map((p) => p.trim());
}

/**
 * Every request the client can make.
 *
 * Balanced on parentheses rather than split on commas, because payloads contain
 * both, and generic arguments are walked rather than pattern-matched, because
 * `post<Record<string, string>>(` defeats any regex written for `post<T>(`.
 */
export function clientCalls(): ClientCall[] {
  const source = readFileSync(CLIENT, "utf8");
  const code = withoutComments(source);
  const calls: ClientCall[] = [];

  const names = [...Object.keys(HELPER_METHOD), "request"];
  const opener = new RegExp(`\\b(${names.join("|")})\\s*[<(]`, "g");

  for (let match = opener.exec(code); match; match = opener.exec(code)) {
    const helper = match[1]!;
    // `profileById.get(id)` is a Map read, not a request. Only the bare helpers
    // count, so anything reached through a dot is skipped.
    if (code[match.index - 1] === ".") continue;
    let cursor = match.index + match[0].length - 1;

    if (code[cursor] === "<") {
      cursor = skipGenerics(code, cursor);
      if (cursor === -1) continue;
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

    const args = source.slice(start, i - 1);
    const parts = splitArgs(args, code.slice(start, i - 1));
    const line = source.slice(0, start).split("\n").length;
    const resolve = (name: string) => bindingAbove(name, start, code, source);

    /*
      A helper's own declaration is not a call to it.

      `const get = async <T,>(path: string, ...)` and `function report<Row>(path:
      string, ...)` both match the opener, and their "path argument" is the
      parameter list. Recognised by shape rather than by name so a new wrapper
      is handled too.
    */
    const first = helper === "request" ? parts[1] : parts[0];
    // `path: string` is a parameter; a bare `path` is a variable being passed,
    // which several functions do after choosing between two endpoints. Only the
    // typed form is a declaration.
    if (first !== undefined && /^path\s*:/.test(first)) continue;

    if (helper === "request") {
      /*
        The raw form names its own method: `request("POST", path, ...)`. The
        four helpers above are thin wrappers over it, so their own definitions
        show up here too; those are the calls whose path argument is the
        parameter `path`, which resolves to nothing and would otherwise be
        reported as unreadable. They are recognised and skipped by shape.
      */
      const literalMethod = parts[0]?.replace(/^["'`]|["'`]$/g, "");
      if (!literalMethod || !(literalMethod in Object.fromEntries(
        (["GET", "POST", "PATCH", "PUT", "DELETE"] as const).map((m) => [m, true])
      ))) continue;
      if (parts[1] === "path") continue; // a wrapper definition, not a call site
      calls.push({
        helper,
        method: literalMethod as HttpMethod,
        paths: literalPaths(parts[1] ?? "", resolve),
        text: args,
        line,
      });
      continue;
    }

    calls.push({
      helper,
      method: HELPER_METHOD[helper]!,
      paths: literalPaths(parts[0] ?? "", resolve),
      text: args,
      line,
    });
  }

  return calls;
}

/* ------------------------------------------------------------ route surface */

export interface RouteMethod {
  /** Path segments under /api/v1, e.g. `retainers/[id]/adjust`. */
  route: string;
  method: HttpMethod;
  /** Repo-relative file, for failure messages. */
  file: string;
  /** The route file's full source, for checks that read its options. */
  source: string;
}

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) routeFiles(full, out);
    else if (name === "route.ts") out.push(full);
  }
  return out;
}

/** Every HTTP method every route file exports. */
export function routeMethods(): RouteMethod[] {
  const found: RouteMethod[] = [];

  for (const file of routeFiles(API_ROOT)) {
    const source = readFileSync(file, "utf8");
    const code = withoutComments(source);
    const route = relative(API_ROOT, file).split(sep).slice(0, -1).join("/");

    // Both shapes appear: `export const POST = route(...)` and
    // `export async function POST(req)`, the latter where a handler needs the
    // raw request rather than the wrapper.
    const declared = new Set<HttpMethod>();
    const pattern = /export\s+(?:const\s+(GET|POST|PATCH|PUT|DELETE)\s*=|(?:async\s+)?function\s+(GET|POST|PATCH|PUT|DELETE)\s*\()/g;
    for (let m = pattern.exec(code); m; m = pattern.exec(code)) {
      declared.add((m[1] ?? m[2]) as HttpMethod);
    }

    for (const method of declared) found.push({ route, method, file: relative(process.cwd(), file), source });
  }

  return found;
}

/* -------------------------------------------------------------- resolution */

interface Segment {
  dynamic: boolean;
  value: string;
}

const routeSegments = (route: string): Segment[] =>
  route.split("/").filter(Boolean).map((s) => ({ dynamic: s.startsWith("["), value: s }));

/**
 * A path literal expanded over any interpolated choice between two literals.
 *
 * `` `/projects/${id}/${pinned ? "pin" : "unpin"}` `` is two endpoints written
 * as one string, and treating that last segment as an opaque interpolation made
 * both of them read as unreachable. Expanding gives the two concrete paths the
 * call can actually produce.
 */
export function expandLiteral(literal: string): string[] {
  const quote = literal[0]!;
  let inner = literal.slice(1, -1);

  for (let guard = 0; guard < 8; guard++) {
    const match = /\$\{([^{}]*)\}/g;
    let found: { start: number; end: number; branches: string[] } | null = null;

    for (let m = match.exec(inner); m; m = match.exec(inner)) {
      const branches = literalPaths(m[1]!.trim());
      // Two string literals, i.e. a ternary between them. A plain `${id}` reads
      // as unresolvable here, which is right: it stays an opaque segment.
      if (branches && branches.length > 1) {
        found = {
          start: m.index,
          end: m.index + m[0].length,
          branches: branches.map((b) => b.slice(1, -1)),
        };
        break;
      }
    }

    if (!found) break;
    const head = inner.slice(0, found.start);
    const tail = inner.slice(found.end);
    // One choice at a time, so nested ones resolve on the next pass.
    return found.branches.flatMap((b) => expandLiteral(`${quote}${head}${b}${tail}${quote}`));
  }

  return [`${quote}${inner}${quote}`];
}

/** A client path literal as segments. `${id}` is dynamic, anything else is not. */
function clientSegments(literal: string): Segment[] | null {
  const inner = literal.slice(1, -1);
  if (!inner.startsWith("/")) return null;
  return inner
    .split("/")
    .filter(Boolean)
    // `${id}` in the web client, `:id` in the MCP server's admin helper.
    .map((s) => ({ dynamic: s.includes("${") || s.startsWith(":"), value: s }));
}

/**
 * Which route a client path actually reaches, the way Next resolves it.
 *
 * Not a regex per route, because a literal segment can legitimately land on a
 * dynamic one. `POST /time-entries/current/stop` has no `current` directory, so
 * it resolves to `[id]/stop` with the id ignored, and a matcher that insisted
 * on `${...}` reported that route unreached while the client had been calling
 * it since the beginning.
 *
 * Static beats dynamic, so `/time-entries/running` prefers its own directory
 * over `[id]`. Score is the count of literal-to-literal matches; the highest
 * wins, which is that rule.
 */
export function matchRoute(literal: string, routes: RouteMethod[]): RouteMethod | null {
  const want = clientSegments(literal);
  if (!want) return null;
  return matchSegments(want, routes);
}

function matchSegments(want: Segment[], routes: RouteMethod[]): RouteMethod | null {

  let best: RouteMethod | null = null;
  let bestScore = -1;

  for (const candidate of routes) {
    const have = routeSegments(candidate.route);
    if (have.length !== want.length) continue;

    let score = 0;
    let ok = true;
    for (let i = 0; i < have.length; i++) {
      const h = have[i]!;
      const w = want[i]!;
      if (h.dynamic) continue;                    // a dynamic route takes anything
      if (w.dynamic || h.value !== w.value) { ok = false; break; }
      score++;
    }
    if (!ok) continue;

    if (score > bestScore) { best = candidate; bestScore = score; }
  }

  return best;
}

/* ------------------------------------------------------- the MCP surface */

const MCP_DIR = join(process.cwd(), "src/mcp");

/**
 * The MCP server is the second thing that speaks to this API.
 *
 * It runs in its own container and reaches the same `/api/v1` over HTTP through
 * `src/mcp/api-client.ts`, so the `/mcp/*` routes are not dead just because the
 * web client never calls them. Counting them as reached here is the difference
 * between a guard that understands the system and an exemption list with twelve
 * entries and no reason on any of them.
 *
 * Two shapes carry a path: a method call on the client (`api.post("/mcp/undo")`)
 * and the local `admin` helper, whose fourth argument is a path written with
 * `:id` placeholders.
 */
export function mcpCalls(): ClientCall[] {
  const calls: ClientCall[] = [];

  const files = readdirSync(MCP_DIR)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(MCP_DIR, f));

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const code = withoutComments(source);

    // `api.post("/path", ...)`. The method is in the property name, and the
    // call may carry a type argument: `api.get<TokenInfo>("/auth/token-info")`
    // is how the MCP server reads its own token, and a pattern that demanded
    // `(` straight after the name missed it.
    const method = /\.(get|post|patch|put|del)\s*[<(]/g;
    for (let m = method.exec(code); m; m = method.exec(code)) {
      let start = m.index + m[0].length;
      if (code[start - 1] === "<") {
        const after = skipGenerics(code, start - 1);
        if (after === -1) continue;
        let j = after;
        while (j < code.length && /\s/.test(code[j]!)) j++;
        if (code[j] !== "(") continue;
        start = j + 1;
      }
      let depth = 1;
      let i = start;
      for (; i < code.length && depth > 0; i++) {
        const c = code[i];
        if (c === "(") depth++;
        else if (c === ")") depth--;
      }
      const args = source.slice(start, i - 1);
      const parts = splitArgs(args, code.slice(start, i - 1));
      calls.push({
        helper: "mcp",
        method: HELPER_METHOD[m[1]!]!,
        paths: literalPaths(parts[0] ?? ""),
        text: args,
        line: source.slice(0, start).split("\n").length,
      });
    }

    // `admin(name, description, schema, path, method?)`
    const admin = /\badmin\s*\(/g;
    for (let m = admin.exec(code); m; m = admin.exec(code)) {
      const start = m.index + m[0].length;
      let depth = 1;
      let i = start;
      for (; i < code.length && depth > 0; i++) {
        const c = code[i];
        if (c === "(") depth++;
        else if (c === ")") depth--;
      }
      const args = source.slice(start, i - 1);
      const parts = splitArgs(args, code.slice(start, i - 1));
      if (parts.length < 4) continue;
      const verb = (parts[4] ?? '"post"').replace(/["'`]/g, "").toLowerCase();
      calls.push({
        helper: "mcp-admin",
        method: verb === "patch" ? "PATCH" : "POST",
        paths: literalPaths(parts[3]!),
        text: args,
        line: source.slice(0, start).split("\n").length,
      });
    }
  }

  // `headers.get("etag")` is not a request. A path starts with a slash.
  return calls.filter((c) => c.paths !== null && c.paths.every((p) => p.slice(1).startsWith("/")));
}
