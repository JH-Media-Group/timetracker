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
import { isIP } from "node:net";
import { and, eq, isNull } from "drizzle-orm";
import { AppError, forbidden, fromDatabaseError, toProblem, unauthenticated, validationFailed } from "./errors";
import {
  assertCan,
  createCtx,
  flush,
  runAfterCommitCallbacks,
  type AuditInput,
  type Ctx,
  type DomainEvent,
} from "./ctx";
import { resolveSession } from "./auth/session";
import { resolveBearer } from "./auth/api-key";
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
  /**
   * Ignored while `next.config.mjs` applies `private, no-store` to `/api/*`,
   * which it does deliberately: every response here is scoped to one person's
   * permissions and must not sit in a shared cache. Kept because a per-route
   * value is the right shape if that ever changes.
   */
  cacheControl?: string;
  /** Ends the caller's own session by clearing the cookie on the way out. */
  clearSessionCookie?: boolean;
  /** Return the handler's value without the Tally envelope for standard protocol endpoints such as OAuth. */
  rawResponse?: boolean;
  oauthErrors?: boolean;
}

const MUTATING = new Set(["POST", "PATCH", "PUT", "DELETE"]);

export function route<T>(handler: Handler<T>, options: RouteOptions = {}) {
  return async (req: NextRequest, context: { params: Promise<Record<string, string>> }): Promise<NextResponse> => {
    const requestId = newId();
    const params = context?.params ? await context.params : {};
    const mutating = MUTATING.has(req.method);

    // Declared outside the try so the catch can release it. A claim taken and
    // then abandoned answers every later attempt with "still being processed".
    let claim: IdempotencyClaim | null = null;

    try {
      const ctx = options.public ? publicCtx(req, requestId) : await authenticatedCtx(req, requestId);

      const writeScopes = new Set(["tally.time.write", "tally.expenses", "tally.approvals", "tally.admin"]);
      const tokenReadOnly = ctx.actor.tokenScopes !== undefined && !ctx.actor.tokenScopes.some((scope) => writeScopes.has(scope));
      if (mutating && tokenReadOnly) throw forbidden("This token is read only.");

      // Cross-site write protection.
      //
      // The session cookie is SameSite=Lax, so a cross-site form POST does not
      // carry it, and a JSON content type forces a preflight that this app
      // never answers for another origin. That is already two locks. This is
      // the third, and it is the only one that does not depend on a browser
      // getting the first two right.
      // API tokens are not cookies. CSRF is a browser concern and does not
      // apply to bearer-authenticated requests from an MCP client.
      if (mutating && !options.public && ctx.actor.kind !== "api") assertSameOrigin(req);

      // Rate limit before anything expensive happens.
      const bucket = options.rateLimit ?? (mutating ? "write" : "read");
      // Authenticated API tokens key on the user. The publicCtx "api" actor
      // (no real user) still keys on IP.
      const actorKey = ctx.actor.tokenPrefix
        ? `token:${ctx.actor.tokenPrefix}`
        : ctx.actor.kind === "api" && ctx.actor.userId === "00000000-0000-0000-0000-000000000000"
          ? `ip:${clientIp(req) ?? "unknown"}`
          : `user:${ctx.actor.userId}`;
      await enforce(bucket, actorKey);

      if (options.capability) assertCan(ctx, options.capability);

      const idempotencyKey = req.headers.get("idempotency-key");
      if (options.requireIdempotencyKey && !idempotencyKey) {
        throw validationFailed(
          { "Idempotency-Key": ["required for this request"] },
          "This request creates a money-moving record and needs an Idempotency-Key header."
        );
      }

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
      let body: Envelope<T>;
      if (shouldTransact) {
        // Buffers belong to the transaction, not to the Ctx, and `audit`/`emit`
        // are rebound to them. See withTransaction in ctx.ts for why both halves
        // are needed: rebinding is what keeps `ctx.audit(...)` and `flush` from
        // reading different arrays. A failed transaction takes them out of
        // scope, so there is nothing to discard.
        // Anything buffered before the transaction opened comes with it, rather
        // than being stranded on the Ctx. See withTransaction in ctx.ts.
        const buffers = {
          audits: ctx._buffers.audits.splice(0),
          events: ctx._buffers.events.splice(0),
          afterCommit: [] as (() => void)[],
          settingsWritten: false,
        };

        body = await db.transaction(async (tx) => {
          const inner: Ctx = {
            ...ctx,
            db: tx,
            _buffers: buffers,
            audit: (entry) => buffers.audits.push(entry),
            emit: (event) => buffers.events.push(event),
          };
          const result = await runHandler(inner);
          await flush(inner);
          return result;
        });

        // A throw skips this and the array is discarded unrun.
        runAfterCommitCallbacks(buffers.afterCommit);
      } else {
        body = await runHandler(ctx);
      }

      const response = NextResponse.json(options.rawResponse ? body.data : body, {
        headers: {
          "Cache-Control": options.cacheControl ?? "private, no-store",
          "X-Request-Id": requestId,
        },
      });

      if (options.clearSessionCookie) {
        const { clearedCookieOptions } = await import("./auth/session");
        response.cookies.set(clearedCookieOptions());
      } else if (ctx.actor.renewedUntil) {
        // The session rolled forward on this request, so the cookie does too.
        const { sessionCookieOptions } = await import("./auth/session");
        const token = req.cookies.get("tally_session")?.value;
        if (token) response.cookies.set({ ...sessionCookieOptions(ctx.actor.renewedUntil), value: token });
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
      // Release the claim. It was taken before the handler ran so that two
      // copies of a retried request could not both execute, but the handler
      // failed, so nothing happened and the retry should be allowed to. Left
      // in place with a null status, the row answers every later attempt with
      // "still being processed", forever.
      if (claim) {
        await releaseIdempotencyClaim(claim).catch((e) =>
          console.error(`[${requestId}] could not release the idempotency claim`, e)
        );
      }
      if (options.oauthErrors) {
        const detail = error instanceof Error ? error.message : "The OAuth request is invalid.";
        const code = /authorization code|PKCE|already been used/i.test(detail) ? "invalid_grant" : /scope/i.test(detail) ? "invalid_scope" : "invalid_request";
        return NextResponse.json({ error: code, error_description: detail }, { status: code === "invalid_grant" ? 400 : 400, headers: { "Cache-Control": "no-store", "X-Request-Id": requestId } });
      }
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
  // Bearer token takes precedence: if the header is present and valid, use it.
  // If it is present and invalid, refuse it. Falling through to a cookie would
  // let a broken or revoked bearer silently act with the browser session.
  const authHeader = req.headers.get("authorization");
  if (authHeader) {
    const resolved = await resolveBearer(authHeader);
    if (resolved) {
      return createCtx({
        actor: resolved.actor,
        request: {
          requestId,
          ip: clientIp(req),
          // The token prefix in the user-agent slot, so audit rows record which
          // token made the change without a schema migration.
          userAgent: `api-token/${resolved.prefix}`,
        },
      });
    }
    throw unauthenticated();
  }

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
 * The client address, or null when there is nothing honest to report.
 *
 * `X-Forwarded-For` is only believed when the deployment says it is behind a
 * proxy that sets it. Trusting it unconditionally lets any caller pick their
 * own address and walk straight through a per-IP rate limit, and puts a value
 * of their choosing into `sessions.ip` and the audit log.
 *
 * **Read the last hop, not the first.** The header is a trail, and where a proxy
 * appends to it (nginx's `$proxy_add_x_forwarded_for`, or Caddy once
 * `trusted_proxies` is configured) the entries on the left are whatever the
 * caller sent and the one on the right is the address the proxy actually saw.
 * Taking the first element would hand an attacker a fresh rate-limit bucket per
 * request and let them write any address they like into the audit log, which is
 * worse than no address at all: a gap in the record reads as a gap, an invented
 * address reads as evidence.
 *
 * Be accurate about our own deployment, because the first version of this
 * comment was not. Caddy 2.7 and later trust no proxy by default, and *replace*
 * an untrusted caller's `X-Forwarded-For` rather than appending to it. Our
 * Caddyfile sets no `trusted_proxies`, so today the header carries exactly one
 * address and first and last are the same value: the safety here comes from
 * Caddy, and this function is choosing the same element either way.
 *
 * It stops being the same the moment a second proxy is added and Caddy is told
 * to trust it, because then the trail is real. With N trusted hops the client is
 * the (N+1)th from the right, so this needs a hop count rather than `.at(-1)`.
 * Written down because the change that breaks it is a Caddyfile edit, not a code
 * edit, and nothing here would notice.
 *
 * The value is validated before it leaves, because it goes into two `inet`
 * columns. An unparseable address would throw at insert, and audit rows are
 * written inside the same transaction as the mutation they describe, so a bad
 * header would roll back somebody's saved work at commit time.
 */
export function clientIp(req: NextRequest): string | null {
  if (!env.TRUST_PROXY) return null;

  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded
      .split(",")
      .map((hop) => hop.trim())
      .filter(Boolean);
    const nearest = hops.at(-1);
    if (nearest) return asAddress(nearest);
  }

  // Single-valued and set by the proxy itself, so there is no trail to walk.
  const real = req.headers.get("x-real-ip");
  if (real) return asAddress(real.trim());

  return null;
}

/**
 * The value if it is an IP address, otherwise null.
 *
 * `net.isIP` rather than a regex. The first attempt at this was a hand-written
 * pattern, and a reviewer fed it `:::`, `1::2::3`, and a nine-group IPv6
 * address: all three passed, and all three are rejected by Postgres as `inet`.
 * That combination is the dangerous one, because audit rows are written inside
 * the same transaction as the mutation they describe, so a bad value does not
 * merely lose the address, it throws at commit and rolls back the work the user
 * just saved. Writing an IPv6 grammar correctly is a known-hard exercise and
 * the standard library has already done it.
 *
 * A zone identifier is stripped (`fe80::1%eth0`); Postgres will not take one and
 * the scope is meaningless to us anyway. A bracketed form is unwrapped, since
 * that is how an address with a port is usually written.
 *
 * What this deliberately does not accept: CIDR suffixes and leading-zero octets,
 * both of which `inet` would take. No proxy sends either, and accepting them
 * would mean carrying a parser again.
 */
function asAddress(value: string): string | null {
  if (!value) return null;

  let candidate = value.trim();
  if (candidate.startsWith("[") && candidate.endsWith("]")) candidate = candidate.slice(1, -1);

  const zone = candidate.indexOf("%");
  if (zone !== -1) candidate = candidate.slice(0, zone);

  return isIP(candidate) === 0 ? null : candidate;
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

/**
 * Lets a failed request be retried with the same key.
 *
 * Only the actor's own unfinished claim is removed: a completed one has a
 * stored response and is the whole point of the mechanism, and another actor's
 * is none of our business.
 */
async function releaseIdempotencyClaim(claim: IdempotencyClaim) {
  await db
    .delete(s.idempotencyKeys)
    .where(and(eq(s.idempotencyKeys.key, claim.key), isNull(s.idempotencyKeys.responseStatus)));
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
