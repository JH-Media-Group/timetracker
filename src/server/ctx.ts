/**
 * The service context.
 *
 * Every service function takes a `Ctx` as its first argument. It carries who is
 * acting, the database handle (a pool or an open transaction), an injectable
 * clock so tests are deterministic, and two buffers.
 *
 * The buffers are the important part. Audit rows and domain events are
 * *collected* during a call and *flushed inside the transaction*, so nothing
 * escapes a rollback. An audit log that records changes which were then rolled
 * back is worse than no audit log, because it is confidently wrong.
 *
 * Specification: docs/BACKEND_PRD.md section 5.
 */

import { sql } from "drizzle-orm";
import { db as pool, type Db } from "./db/client";
import * as s from "./db/schema";
import { newId } from "./db/ids";
import type { Capability } from "./auth/capabilities";
import { forbidden } from "./errors";

export type ActorKind = "user" | "system" | "api" | "integration";

export interface Actor {
  userId: string;
  profileId: string;
  baseKey: string | null;
  capabilities: ReadonlySet<Capability>;
  kind: ActorKind;
  /** The person's timezone, used to resolve calendar days for their own records. */
  timezone: string;
  isOwner: boolean;
}

export interface AuditInput {
  action: string;
  entityType: string;
  entityId?: string | null;
  entityLabel?: string | null;
  before?: unknown;
  after?: unknown;
  /** Marks a change made by bypassing a lock, so amendments are findable. */
  override?: boolean;
}

export interface DomainEvent {
  topic: string;
  payload: Record<string, unknown>;
}

export interface RequestInfo {
  requestId: string;
  ip?: string | null;
  userAgent?: string | null;
}

export interface Ctx {
  actor: Actor;
  db: Db;
  now: () => Date;
  request: RequestInfo;
  audit: (entry: AuditInput) => void;
  emit: (event: DomainEvent) => void;
  /** Internal: what has been buffered so far. */
  readonly _buffers: { audits: AuditInput[]; events: DomainEvent[] };
}

/* ------------------------------------------------------------ construction */

export function createCtx(opts: {
  actor: Actor;
  db?: Db;
  now?: () => Date;
  request?: Partial<RequestInfo>;
}): Ctx {
  const buffers = { audits: [] as AuditInput[], events: [] as DomainEvent[] };
  return {
    actor: opts.actor,
    db: opts.db ?? pool,
    now: opts.now ?? (() => new Date()),
    request: {
      requestId: opts.request?.requestId ?? newId(),
      ip: opts.request?.ip ?? null,
      userAgent: opts.request?.userAgent ?? null,
    },
    audit: (entry) => buffers.audits.push(entry),
    emit: (event) => buffers.events.push(event),
    _buffers: buffers,
  };
}

/** The system actor, for jobs and migrations. Holds every capability. */
export function systemActor(userId = "00000000-0000-0000-0000-000000000000"): Actor {
  return {
    userId,
    profileId: userId,
    baseKey: "administrator",
    capabilities: new Set(["*"] as unknown as Capability[]),
    kind: "system",
    timezone: "UTC",
    isOwner: true,
  };
}

/* ------------------------------------------------------------ authorization */

export function can(ctx: Ctx, capability: Capability): boolean {
  if (ctx.actor.kind === "system") return true;
  return ctx.actor.capabilities.has(capability);
}

/**
 * The capability gate. Called at the top of every service function, before any
 * query runs. Route handlers never make this decision; they only surface the
 * error, so a new route cannot forget to authorize.
 */
export function assertCan(ctx: Ctx, capability: Capability, detail?: string): void {
  if (!can(ctx, capability)) {
    throw forbidden(detail ?? `This action needs the ${capability} permission.`);
  }
}

/** True when the actor may act on their own records for this capability family. */
export const isSelf = (ctx: Ctx, userId: string): boolean => ctx.actor.userId === userId;

/* ------------------------------------------------------------- transaction */

/**
 * Runs a service call in one transaction and flushes its buffers inside it.
 *
 * Nesting is safe: when `ctx.db` is already a transaction the callback joins it
 * rather than opening a second one, and the flush happens once, at the
 * outermost level. That is what lets one service call another without either of
 * them knowing whether it is the outer one.
 */
export async function withTransaction<T>(ctx: Ctx, fn: (tx: Ctx) => Promise<T>): Promise<T> {
  if (isTransaction(ctx.db)) {
    // Already inside one. Join it; the outermost caller owns the flush.
    return fn(ctx);
  }

  return (pool as typeof pool).transaction(async (tx) => {
    const inner: Ctx = { ...ctx, db: tx };
    const result = await fn(inner);
    await flush(inner);
    return result;
  });
}

function isTransaction(handle: Db): boolean {
  // Drizzle's transaction handle carries a rollback method; the pool does not.
  return typeof (handle as { rollback?: unknown }).rollback === "function";
}

/** Writes the buffered audit rows and outbox events. Call inside the transaction. */
export async function flush(ctx: Ctx): Promise<void> {
  const { audits, events } = ctx._buffers;
  if (audits.length === 0 && events.length === 0) return;

  const at = ctx.now();

  if (audits.length > 0) {
    await ctx.db.insert(s.auditLog).values(
      audits.map((a) => ({
        actorId: ctx.actor.kind === "system" ? null : ctx.actor.userId,
        actorKind: ctx.actor.kind,
        action: a.override ? `${a.action}.override` : a.action,
        entityType: a.entityType,
        entityId: a.entityId ?? null,
        entityLabel: a.entityLabel ?? null,
        before: (a.before ?? null) as never,
        after: (a.after ?? null) as never,
        diffKeys: diffKeys(a.before, a.after),
        requestId: ctx.request.requestId,
        ip: ctx.request.ip ?? null,
        userAgent: ctx.request.userAgent ?? null,
        createdAt: at,
      }))
    );
  }

  if (events.length > 0) {
    await ctx.db.insert(s.outbox).values(
      events.map((e) => ({
        topic: e.topic,
        payload: { ...e.payload, request_id: ctx.request.requestId } as never,
        createdAt: at,
      }))
    );
  }

  audits.length = 0;
  events.length = 0;
}

/** The field names that actually changed, so the audit log is skimmable. */
function diffKeys(before: unknown, after: unknown): string[] | null {
  if (!before || !after || typeof before !== "object" || typeof after !== "object") return null;
  const a = before as Record<string, unknown>;
  const b = after as Record<string, unknown>;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const changed: string[] = [];
  for (const k of keys) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) changed.push(k);
  }
  return changed.length ? changed : null;
}

/* ------------------------------------------------------------------ locks */

/**
 * Advisory lock for a named resource, held to the end of the transaction.
 *
 * Used for the invoice number sequence, where two concurrent creates must not
 * draw the same number. `pg_advisory_xact_lock` releases automatically on
 * commit or rollback, which a manually released lock would not.
 */
export async function lockNamed(ctx: Ctx, name: string): Promise<void> {
  await ctx.db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${name}))`);
}
