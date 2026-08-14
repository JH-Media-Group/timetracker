/**
 * The HTTP layer.
 *
 * One helper turns a service call into a response, so no route handler ever
 * writes its own try/catch, its own status code, or its own error shape. A
 * route that forgets to handle an error is not possible, because the route
 * never handles errors at all.
 *
 * Route handlers are thin by construction: resolve the session, parse the
 * input, call the service, return what it returns.
 *
 * Specification: docs/BACKEND_PRD.md section 6.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { AppError, fromDatabaseError, toProblem, unauthenticated, validationFailed } from "./errors";
import { createCtx, type Ctx } from "./ctx";
import { resolveSession } from "./auth/session";
import { db } from "./db/client";
import * as s from "./db/schema";
import { newId } from "./db/ids";

export interface Meta {
  total?: number;
  page?: number;
  perPage?: number;
  hasMore?: boolean;
  totals?: Record<string, number>;
  [key: string]: unknown;
}

export interface Envelope<T> {
  data: T;
  meta?: Meta;
}

type Handler<T> = (ctx: Ctx, req: NextRequest, params: Record<string, string>) => Promise<T | Envelope<T>>;

interface RouteOptions {
  /** Skips session resolution. Only for sign-in and health checks. */
  public?: boolean;
  /** Mutating routes that create money-moving records require a key. */
  requireIdempotencyKey?: boolean;
  /** Cache-Control for the response. Reports set a private max-age; nothing else caches. */
  cacheControl?: string;
}

/**
 * Wraps a handler.
 *
 * Everything that is the same for every route lives here: the request id, the
 * session, the error translation, the envelope, and the no-store header. If it
 * belongs on every response, it belongs in this function and nowhere else.
 */
export function route<T>(handler: Handler<T>, options: RouteOptions = {}) {
  return async (req: NextRequest, context: { params: Promise<Record<string, string>> }): Promise<NextResponse> => {
    const requestId = newId();
    const params = context?.params ? await context.params : {};

    try {
      const ctx = options.public ? publicCtx(req, requestId) : await authenticatedCtx(req, requestId);

      // Idempotency: replay the stored response when the same key arrives twice.
      const idempotencyKey = req.headers.get("idempotency-key");
      if (options.requireIdempotencyKey && !idempotencyKey) {
        throw validationFailed(
          { "Idempotency-Key": ["required for this request"] },
          "This request creates a money-moving record and needs an Idempotency-Key header."
        );
      }

      if (idempotencyKey) {
        const replayed = await replayIfSeen(ctx, req, idempotencyKey);
        if (replayed) return replayed;
      }

      const result = await handler(ctx, req, params);
      const body = isEnvelope(result) ? result : ({ data: result } as Envelope<T>);
      const response = NextResponse.json(body, {
        headers: {
          "Cache-Control": options.cacheControl ?? "private, no-store",
          "X-Request-Id": requestId,
        },
      });

      if (idempotencyKey) await recordIdempotent(ctx, req, idempotencyKey, 200, body);
      return response;
    } catch (error) {
      return problemResponse(error, requestId);
    }
  };
}

export function problemResponse(error: unknown, requestId: string): NextResponse {
  const translated = error instanceof AppError ? error : (fromDatabaseError(error) ?? error);
  const problem = toProblem(translated, requestId);

  if (problem.status >= 500) {
    // The detail sent to the client says nothing; the log gets everything.
    console.error(`[${requestId}] unhandled error`, error);
  }

  return NextResponse.json(problem, {
    status: problem.status,
    headers: {
      "Content-Type": "application/problem+json",
      "Cache-Control": "private, no-store",
      "X-Request-Id": requestId,
    },
  });
}

const isEnvelope = <T,>(v: unknown): v is Envelope<T> =>
  typeof v === "object" && v !== null && "data" in (v as object);

/* ------------------------------------------------------------- session */

async function authenticatedCtx(req: NextRequest, requestId: string): Promise<Ctx> {
  const actor = await resolveSession(req);
  if (!actor) throw unauthenticated();
  return createCtx({
    actor,
    request: { requestId, ip: clientIp(req), userAgent: req.headers.get("user-agent") },
  });
}

function publicCtx(req: NextRequest, requestId: string): Ctx {
  return createCtx({
    actor: {
      userId: "00000000-0000-0000-0000-000000000000",
      profileId: "00000000-0000-0000-0000-000000000000",
      baseKey: null,
      capabilities: new Set(),
      kind: "api",
      timezone: "UTC",
      isOwner: false,
    },
    request: { requestId, ip: clientIp(req), userAgent: req.headers.get("user-agent") },
  });
}

export function clientIp(req: NextRequest): string | null {
  // Behind Caddy the real address is the first entry in X-Forwarded-For.
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return req.headers.get("x-real-ip");
}

/* ---------------------------------------------------------- idempotency */

const hashBody = (route: string, body: string) => createHash("sha256").update(`${route}\n${body}`).digest("hex");

async function replayIfSeen(ctx: Ctx, req: NextRequest, key: string): Promise<NextResponse | null> {
  const routeKey = `${req.method} ${new URL(req.url).pathname}`;
  const raw = await peekBody(req);
  const hash = hashBody(routeKey, raw);

  const [existing] = await db
    .select({
      requestHash: s.idempotencyKeys.requestHash,
      status: s.idempotencyKeys.responseStatus,
      body: s.idempotencyKeys.responseBody,
    })
    .from(s.idempotencyKeys)
    .where(eq(s.idempotencyKeys.key, key))
    .limit(1);

  if (!existing) return null;

  if (existing.requestHash !== hash) {
    throw new AppError(
      "idempotency_key_reused",
      "That Idempotency-Key was already used for a different request."
    );
  }

  return NextResponse.json(existing.body ?? { data: null }, {
    status: existing.status ?? 200,
    headers: {
      "Idempotency-Replayed": "true",
      "Cache-Control": "private, no-store",
      "X-Request-Id": ctx.request.requestId,
    },
  });
}

async function recordIdempotent(ctx: Ctx, req: NextRequest, key: string, status: number, body: unknown) {
  const routeKey = `${req.method} ${new URL(req.url).pathname}`;
  const raw = await peekBody(req);
  await db
    .insert(s.idempotencyKeys)
    .values({
      key,
      actorId: ctx.actor.kind === "system" ? null : ctx.actor.userId,
      route: routeKey,
      requestHash: hashBody(routeKey, raw),
      responseStatus: status,
      responseBody: body as never,
    })
    .onConflictDoNothing();
}

/**
 * Reads the body without consuming it for the handler.
 *
 * `req.clone()` is the supported way; caching the text on the request object
 * means the handler's own `json()` call still works.
 */
const bodyCache = new WeakMap<NextRequest, string>();

async function peekBody(req: NextRequest): Promise<string> {
  const cached = bodyCache.get(req);
  if (cached != null) return cached;
  let text = "";
  try {
    text = await req.clone().text();
  } catch {
    text = "";
  }
  bodyCache.set(req, text);
  return text;
}

/* ------------------------------------------------------------ validation */

/** Parses and validates a JSON body, turning Zod issues into field errors. */
export async function body<T extends z.ZodType>(req: NextRequest, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw validationFailed({ _: ["The request body was not valid JSON."] });
  }
  return parseOrThrow(schema, raw);
}

/** Parses and validates query parameters. */
export function query<T extends z.ZodType>(req: NextRequest, schema: T): z.infer<T> {
  const params: Record<string, string | string[]> = {};
  const url = new URL(req.url);
  for (const key of new Set(url.searchParams.keys())) {
    const all = url.searchParams.getAll(key);
    params[key] = all.length > 1 ? all : all[0]!;
  }
  return parseOrThrow(schema, params);
}

export function parseOrThrow<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;

  const fieldErrors: Record<string, string[]> = {};
  for (const issue of result.error.issues) {
    const path = issue.path.length ? issue.path.join(".") : "_";
    (fieldErrors[path] ??= []).push(issue.message);
  }
  throw validationFailed(fieldErrors);
}

/* ------------------------------------------------------------ pagination */

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(200).default(50),
});

export interface Page {
  page: number;
  perPage: number;
  offset: number;
}

export function pagination(req: NextRequest): Page {
  const { page, per_page } = query(req, paginationSchema.partial().transform((v) => ({
    page: v.page ?? 1,
    per_page: v.per_page ?? 50,
  })));
  return { page, perPage: per_page, offset: (page - 1) * per_page };
}

/** Builds the collection meta block from a page and a total. */
export const pageMeta = (p: Page, total: number, extra: Partial<Meta> = {}): Meta => ({
  total,
  page: p.page,
  perPage: p.perPage,
  hasMore: p.offset + p.perPage < total,
  ...extra,
});

/* --------------------------------------------------------------- shared */

/** A comma-separated `?include=` list, checked against an allowlist. */
export function includes(req: NextRequest, allowed: readonly string[]): Set<string> {
  const raw = new URL(req.url).searchParams.get("include");
  if (!raw) return new Set();
  const requested = raw.split(",").map((r) => r.trim()).filter(Boolean);
  const bad = requested.filter((r) => !allowed.includes(r));
  if (bad.length) {
    throw validationFailed({ include: [`unknown: ${bad.join(", ")}`] }, "Unknown include.");
  }
  return new Set(requested);
}

export { z };
