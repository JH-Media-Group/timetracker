/**
 * The HTTP layer.
 *
 * One helper turns a service call into a response. It exists so that the things
 * which must happen on every request happen whether or not the author of a new
 * route remembers them.
 *
 * That principle was learned the hard way. An earlier version left the
 * transaction, the audit flush, the rate limit, and the pagination as *available*
 * helpers a route could call, and the result was exactly what you would predict:
 * the audit rows for permission changes were silently dropped because those
 * services never opened a transaction, and rate limiting existed on precisely
 * one endpoint. So now:
 *
 *   - every mutating request runs inside a transaction, and the audit and event
 *     buffers flush inside it. A service cannot opt out of being audited.
 *   - every route declares a rate-limit class, and it is consumed here.
 *   - a route may declare a capability, checked before the handler runs, in
 *     addition to the service-level `assertCan`.
 *   - idempotency claims the key **before** the handler runs, not after.
 *
 * Specification: docs/BACKEND_PRD.md section 6.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { AppError, forbidden, fromDatabaseError, toProblem, unauthenticated, validationFailed } from "./errors";
import { assertCan, createCtx, flush, type Ctx } from "./ctx";
import { resolveSession } from "./auth/session";
import { enforce, type RouteClass } from "./auth/rate-limit";
import { db } from "./db/client";
import * as s from "./db/schema";
import { newId } from "./db/ids";
import { env } from "./env";
import type { Capability } from "./auth/capabilities";

export interface Meta {
  total?: number;
  page?: number;
  perPage?: number;
  hasMore?: boolean;
  /** Money and duration totals. Null is meaningful: a margin on no revenue is
   *  undefined, not zero. */
  totals?: Record<string, number | null>;
  [key: string]: unknown;
}

export interface Envelope<T> {
  data: T;
  meta?: Meta;
}

type Handler<T> = (ctx: Ctx, req: NextRequest, params: Record<string, string>) => Promise<T | Envelope<T>>;

export interface RouteOptions {
  /** Skips session resolution. Only for sign-in, providers, and health checks. */
  public?: boolean;
  /**
   * Which bucket this route draws from. Defaults by method: reads are `read`,
   * writes are `write`. Reports and exports declare their own.
   */
  rateLimit?: RouteClass;
  /** Checked before the handler runs. The service still does its own check. */
  capability?: Capability;
  /** Money-moving creates must carry an Idempotency-Key. */
  requireIdempotencyKey?: boolean;
  /**
   * Force the transaction on or off. The default is on for any method that can
   * write, which is what makes the audit flush automatic.
   */
  transactional?: boolean;
  cacheControl?: string;
  /** Ends the caller's own session by clearing the cookie on the way out. */
  clearSessionCookie?: boolean;
}

const MUTATING = new Set(["POST", "PATCH", "PUT", "DELETE"]);

export function route<T>(handler: Handler<T>, options: RouteOptions = {}) {
  return async (req: NextRequest, context: { params: Promise<Record<string, string>> }): Promise<NextResponse> => {
    const requestId = newId();
    const params = context?.params ? await context.params : {};
    const mutating = MUTATING.has(req.method);

    try {
      const ctx = options.public ? publicCtx(req, requestId) : await authenticatedCtx(req, requestId);

      // Cross-site write protection.
      //
      // The session cookie is SameSite=Lax, so a cross-site form POST does not
      // carry it, and a JSON content type forces a preflight that this app
      // never answers for another origin. That is already two locks. This is
      // the third, and it is the only one that does not depend on a browser
      // getting the first two right.
      if (mutating && !options.public) assertSameOrigin(req);

      // Rate limit before anything expensive happens.
      const bucket = options.rateLimit ?? (mutating ? "write" : "read");
      const actorKey = ctx.actor.kind === "api" ? `ip:${clientIp(req) ?? "unknown"}` : `user:${ctx.actor.userId}`;
      await enforce(bucket, actorKey);

      if (options.capability) assertCan(ctx, options.capability);

      const idempotencyKey = req.headers.get("idempotency-key");
      if (options.requireIdempotencyKey && !idempotencyKey) {
        throw validationFailed(
          { "Idempotency-Key": ["required for this request"] },
          "This request creates a money-moving record and needs an Idempotency-Key header."
        );
      }

      let claim: IdempotencyClaim | null = null;
      if (idempotencyKey && mutating) {
        claim = await claimIdempotencyKey(ctx, req, idempotencyKey);
        if (claim.replay) return claim.replay;
      }

      const runHandler = async (inner: Ctx) => {
        const result = await handler(inner, req, params);
        return (isEnvelope(result) ? result : ({ data: result } as Envelope<T>));
      };

      // Every mutation runs in a transaction whose commit also writes the audit
      // rows and outbox events. A service that forgets to open one is still
      // audited, and nothing it buffered can survive a rollback.
      const shouldTransact = options.transactional ?? mutating;
      const body = shouldTransact
        ? await db.transaction(async (tx) => {
            const inner: Ctx = { ...ctx, db: tx };
            const result = await runHandler(inner);
            await flush(inner);
            return result;
          })
        : await runHandler(ctx);

      const response = NextResponse.json(body, {
        headers: {
          "Cache-Control": options.cacheControl ?? "private, no-store",
          "X-Request-Id": requestId,
        },
      });

      if (options.clearSessionCookie) {
        const { clearedCookieOptions } = await import("./auth/session");
        response.cookies.set(clearedCookieOptions());
      }

      // Recording the response must never turn a committed mutation into a
      // failure: the write already happened, and a 500 here would have the
      // offline client replay it.
      if (claim) {
        await completeIdempotencyClaim(claim, 200, body).catch((e) =>
          console.error(`[${requestId}] could not store idempotent response`, e)
        );
      }

      return response;
    } catch (error) {
      return problemResponse(error, requestId);
    }
  };
}

/**
 * Refuses a state-changing request that came from somewhere else.
 *
 * `Origin` is set by every browser on a cross-origin request and on every
 * same-origin request that is not a plain navigation, which covers all of ours.
 * A request with no Origin at all is a non-browser caller (curl, a job, a
 * health check) and is allowed: there is no ambient cookie to abuse there,
 * because a script that has a session cookie already had to be given one.
 */
function assertSameOrigin(req: NextRequest): void {
  const origin = req.headers.get("origin");
  if (!origin) return;

  const host = req.headers.get("host");
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw forbidden("That request did not come from Tally.");
  }

  if (host && originHost === host) return;
  if (originHost === new URL(env.APP_URL).host) return;

  throw forbidden("That request did not come from Tally.");
}

export function problemResponse(error: unknown, requestId: string): NextResponse {
  const translated = error instanceof AppError ? error : (fromDatabaseError(error) ?? error);
  const problem = toProblem(translated, requestId);

  if (problem.status >= 500) {
    console.error(`[${requestId}] unhandled error`, error);
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/problem+json",
    "Cache-Control": "private, no-store",
    "X-Request-Id": requestId,
  };
  if (problem.code === "rate_limited") {
    headers["Retry-After"] = String((problem.meta?.retry_after_seconds as number) ?? 60);
  }

  return NextResponse.json(problem, { status: problem.status, headers });
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

/**
 * The client address.
 *
 * `X-Forwarded-For` is only believed when the deployment says it is behind a
 * proxy that sets it. Trusting it unconditionally lets any caller pick their
 * own address and walk straight through a per-IP rate limit, and puts a value
 * of their choosing into `sessions.ip` and the audit log.
 */
export function clientIp(req: NextRequest): string | null {
  if (env.TRUST_PROXY) {
    const forwarded = req.headers.get("x-forwarded-for");
    if (forwarded) return forwarded.split(",")[0]!.trim() || null;
    const real = req.headers.get("x-real-ip");
    if (real) return real.trim() || null;
  }
  // Next does not expose the socket address in the edge runtime, so without a
  // trusted proxy header there is nothing honest to report.
  return null;
}

/* ---------------------------------------------------------- idempotency */

interface IdempotencyClaim {
  key: string;
  actorId: string | null;
  replay: NextResponse | null;
}

const hashBody = (routeKey: string, body: string) =>
  createHash("sha256").update(`${routeKey}\n${body}`).digest("hex");

/**
 * Claims the key before the handler runs.
 *
 * INSERT first, then act. The reverse (look, run, then record) is a
 * check-then-act race: two copies of a retried request both find no row, both
 * execute, and the guarantee that a replayed payment creates one payment is
 * gone.
 *
 * The row is also matched on `(key, actor)`. Matching on the key alone would
 * hand one actor another actor's stored response body whenever they happened to
 * send the same key.
 */
async function claimIdempotencyKey(ctx: Ctx, req: NextRequest, key: string): Promise<IdempotencyClaim> {
  const routeKey = `${req.method} ${new URL(req.url).pathname}`;
  const raw = await peekBody(req);
  const hash = hashBody(routeKey, raw);
  const actorId = ctx.actor.kind === "api" ? null : ctx.actor.userId;

  const inserted = await db
    .insert(s.idempotencyKeys)
    .values({ key, actorId, route: routeKey, requestHash: hash })
    .onConflictDoNothing()
    .returning({ key: s.idempotencyKeys.key });

  if (inserted.length > 0) return { key, actorId, replay: null };

  // Somebody already claimed it. Only the same actor may see the stored result.
  const [existing] = await db
    .select({
      actorId: s.idempotencyKeys.actorId,
      requestHash: s.idempotencyKeys.requestHash,
      status: s.idempotencyKeys.responseStatus,
      body: s.idempotencyKeys.responseBody,
    })
    .from(s.idempotencyKeys)
    .where(eq(s.idempotencyKeys.key, key))
    .limit(1);

  if (!existing) return { key, actorId, replay: null };

  if (existing.actorId !== actorId || existing.requestHash !== hash) {
    throw new AppError(
      "idempotency_key_reused",
      "That Idempotency-Key was already used for a different request."
    );
  }

  if (existing.status == null) {
    // The original is still in flight. Replaying half a result is worse than
    // asking the client to try again in a moment.
    throw new AppError("conflict", "That request is still being processed. Try again in a moment.");
  }

  return {
    key,
    actorId,
    replay: NextResponse.json(existing.body ?? { data: null }, {
      status: existing.status,
      headers: {
        "Idempotency-Replayed": "true",
        "Cache-Control": "private, no-store",
        "X-Request-Id": ctx.request.requestId,
      },
    }),
  };
}

async function completeIdempotencyClaim(claim: IdempotencyClaim, status: number, body: unknown) {
  await db
    .update(s.idempotencyKeys)
    .set({ responseStatus: status, responseBody: body as never })
    .where(and(eq(s.idempotencyKeys.key, claim.key)));
}

/**
 * Reads the body without consuming it for the handler.
 *
 * A clone failure is not swallowed: an empty string would hash the same for two
 * different bodies, so two genuinely different requests could replay each
 * other's response.
 */
const bodyCache = new WeakMap<NextRequest, string>();

async function peekBody(req: NextRequest): Promise<string> {
  const cached = bodyCache.get(req);
  if (cached != null) return cached;
  let text: string;
  try {
    text = await req.clone().text();
  } catch (e) {
    throw new AppError(
      "internal_error",
      "Could not read the request body for idempotency. Retry without the Idempotency-Key header.",
      { meta: { cause: String(e) } }
    );
  }
  bodyCache.set(req, text);
  return text;
}

/* ------------------------------------------------------------ validation */

export async function body<T extends z.ZodType>(req: NextRequest, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw validationFailed({ _: ["The request body was not valid JSON."] });
  }
  return parseOrThrow(schema, raw);
}

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
  limit: number;
}

export function pagination(req: NextRequest, defaultPerPage = 50): Page {
  const url = new URL(req.url);
  const parsed = paginationSchema.safeParse({
    page: url.searchParams.get("page") ?? undefined,
    per_page: url.searchParams.get("per_page") ?? undefined,
  });
  if (!parsed.success) throw validationFailed({ page: ["Invalid pagination."] });

  const page = parsed.data.page;
  const perPage = url.searchParams.get("per_page") ? parsed.data.per_page : defaultPerPage;
  return { page, perPage, offset: (page - 1) * perPage, limit: perPage };
}

/** The collection meta block. `total` always covers the whole set, not the page. */
export const pageMeta = (p: Page, total: number, extra: Partial<Meta> = {}): Meta => ({
  total,
  page: p.page,
  perPage: p.perPage,
  hasMore: p.offset + p.perPage < total,
  ...extra,
});

/** Applies a page to an already-materialised list, for endpoints that must
 *  compute the whole set anyway (grouped reports, permission-filtered rollups). */
export function paginate<T>(rows: T[], p: Page): { data: T[]; meta: Meta } {
  return { data: rows.slice(p.offset, p.offset + p.perPage), meta: pageMeta(p, rows.length) };
}

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
