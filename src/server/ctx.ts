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
  /**
   * Set when this request rolled the session forward, so the response can send
   * the browser a cookie with the new expiry. Null on every other request.
   */
  renewedUntil?: Date | null;
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
  readonly _buffers: {
    audits: AuditInput[];
    events: DomainEvent[];
    /** Side effects outside the database, run only if the transaction commits. */
    afterCommit: (() => void)[];
  };
}

/* ------------------------------------------------------------ construction */

export function createCtx(opts: {
  actor: Actor;
  db?: Db;
  now?: () => Date;
  request?: Partial<RequestInfo>;
}): Ctx {
  const buffers = {
    audits: [] as AuditInput[],
    events: [] as DomainEvent[],
    afterCommit: [] as (() => void)[],
  };
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

/**
 * Any one of several capabilities is enough.
 *
 * Needed because the capability set is a lattice rather than a ladder:
 * `report:view_all` is strictly wider than `report:view_team`, but an
 * Executive Manager holds the first and not the second, so a check for the
 * narrower one alone locks out the person with more authority.
 */
export function assertCanAny(ctx: Ctx, capabilities: Capability[], detail?: string): void {
  if (ctx.actor.kind === "system") return;
  if (capabilities.some((c) => ctx.actor.capabilities.has(c))) return;
  throw forbidden(detail ?? `This action needs one of: ${capabilities.join(", ")}.`);
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

  /*
    The queue belongs to this transaction, not to the Ctx.

    It used to live on `ctx._buffers`, which a Ctx keeps for its whole life. A
    job that reuses one Ctx across a loop, or two overlapping
    `withTransaction(ctx, ...)` calls on the same Ctx, therefore shared one
    array: whichever transaction finished first drained or discarded the other
    one's callbacks. A rollback in B could throw away A's committed effect, and
    a commit in A could fire B's effect while B was still open and might yet
    roll back. A reviewer found it, and it is the same class of mistake as the
    settings cache this machinery exists to fix.

    A local array, captured by the `inner` Ctx, is scoped to exactly the work
    that can commit. Joined calls receive `inner` and so push into the same
    scope, which is what nesting should mean. `audits` and `events` are still
    shared by reference, because those are flushed inside the transaction and
    the outermost caller owns them.
  */
  const scope: (() => void)[] = [];

  let result: T;
  try {
    result = await (pool as typeof pool).transaction(async (tx) => {
      const inner: Ctx = { ...ctx, db: tx, _buffers: { ...ctx._buffers, afterCommit: scope } };
      const out = await fn(inner);
      await flush(inner);
      return out;
    });
  } catch (e) {
    /*
      Empty the audit and event buffers, because nothing committed.

      `flush` clears them on its way out, so they survive only when something
      threw before it ran. They live on the Ctx, which outlives any one
      transaction, so a job looping over a reused Ctx carried them into the
      *next* iteration and committed them there. `runDueRecurring` and
      `sendDueReminders` both have that shape, with a try/catch per item so one
      bad row does not stop the run: schedule one throws after buffering an
      `invoice.create` audit, schedule two commits, and the log now records the
      creation of an invoice that was rolled back and does not exist. The outbox
      event goes with it, and an outbox event is a trigger.

      This file's header says the buffers are "flushed inside the transaction,
      so nothing escapes a rollback. An audit log that records changes which
      were then rolled back is worse than no audit log, because it is
      confidently wrong." That was the intent, not the behaviour. The previous
      round named this exact hazard beside the after-commit queue and then fixed
      it for that queue alone, which is one buffer out of three.
    */
    discardBuffers(ctx);
    throw e;
  }

  // Only on the way out of a successful commit. A throw skips this, and the
  // array goes out of scope unrun, which is the whole point of scoping it.
  runAfterCommitCallbacks(scope);
  return result;
}

/**
 * Register a side effect that must not happen until the transaction commits.
 *
 * For anything outside the database, where a rollback cannot undo it. The case
 * that drove it is the settings cache: `updateSettings` invalidated inline,
 * which is one or two round trips before COMMIT, so a concurrent reader could
 * miss the cache, read the pre-write row on another connection, and store it
 * *after* the invalidation. The write then committed into a cache holding the
 * value it replaced, and every reader in the process saw the old settings for
 * the full five second TTL. That is the symptom of an admin saving a setting
 * and watching the old value come back.
 *
 * Outside a transaction there is nothing to wait for, so the effect runs now.
 */
export function runAfterCommit(ctx: Ctx, fn: () => void): void {
  if (!isTransaction(ctx.db)) {
    fn();
    return;
  }
  ctx._buffers.afterCommit.push(fn);
}

/**
 * Run the registered effects. Call only after a successful commit.
 *
 * **Every callback runs, and a throw never reaches the caller.** The database
 * has already committed by the time this is called, so a failure here must not
 * turn a successful mutation into an error response, and it must not stop the
 * callbacks after it. The earlier version spliced the array and let the first
 * throw escape, which silently skipped the rest and could fail a request whose
 * write had landed. Nothing registered today can throw, which is exactly why
 * it was worth fixing before something does.
 */
export function runAfterCommitCallbacks(callbacks: (() => void)[]): void {
  const pending = callbacks.splice(0);
  for (const fn of pending) {
    try {
      fn();
    } catch (e) {
      console.error("after-commit effect failed; the transaction had already committed", e);
    }
  }
}

function isTransaction(handle: Db): boolean {
  // Drizzle's transaction handle carries a rollback method; the pool does not.
  return typeof (handle as { rollback?: unknown }).rollback === "function";
}

/**
 * Throw away everything buffered but not written. Call when nothing committed.
 *
 * Exported only for `http.ts`, which owns the other transaction in this
 * application. The only correct moment to call it is the failure path of the
 * code that owns a transaction.
 */
export function discardBuffers(ctx: Ctx): void {
  ctx._buffers.audits.length = 0;
  ctx._buffers.events.length = 0;
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
