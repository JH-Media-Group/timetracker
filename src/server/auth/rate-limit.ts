/**
 * Rate limiting.
 *
 * Redis token buckets when Redis is configured, an in-process fallback when it
 * is not. The fallback is honest about what it is: correct for one process,
 * which is exactly what this deployment is (one droplet, one Node process), and
 * documented as the thing to replace the day that stops being true.
 *
 * The limits that matter most are on authentication, where the fallback is
 * still worth having: ten sign-in attempts per fifteen minutes stops credential
 * stuffing whether or not Redis is up.
 *
 * Specification: docs/BACKEND_PRD.md section 6.4.
 */

import { env } from "@/server/env";
import { AppError } from "@/server/errors";

export type RouteClass = "read" | "write" | "report" | "export" | "email" | "auth";

interface Limit {
  points: number;
  windowMs: number;
}

const LIMITS: Record<RouteClass, Limit> = {
  read: { points: 600, windowMs: 60_000 },
  write: { points: 120, windowMs: 60_000 },
  report: { points: 30, windowMs: 60_000 },
  export: { points: 10, windowMs: 60_000 },
  email: { points: 30, windowMs: 3_600_000 },
  auth: { points: 10, windowMs: 900_000 },
};

export interface RateResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/* ------------------------------------------------------ in-process buckets */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/** Above this the map is treated as under attack rather than merely busy. */
const MAX_BUCKETS = 20_000;
/** How often the map is walked, whatever its size. */
const SWEEP_INTERVAL_MS = 60_000;
let lastSweep = 0;

/**
 * Keeps the map bounded in a long-lived process.
 *
 * The first version ran a full scan on every call once the map passed 2,000
 * entries, and deleted nothing while the entries were still fresh. Sign-in
 * buckets are keyed by email address, and an anonymous caller can name any
 * address they like, so a flood creates a fresh key per request: the map grows
 * without bound and every insertion walks all of it. That is quadratic, and the
 * event loop stops long before memory does.
 *
 * Two changes. The scan is time-based, so its cost is amortised rather than
 * paid per request. And when the map is still over the ceiling after expiring
 * everything it can, entries are dropped, because a limiter that takes the
 * process down with it has stopped being a defence.
 *
 * **Never drop a bucket that is currently limiting somebody.** The first
 * version evicted oldest-first, and a reviewer pointed out that this hands an
 * attacker the eviction as a tool: create twenty thousand fresh buckets with
 * invented email addresses and the bucket that is refusing your guesses against
 * a real address falls out of the front of the map. Buckets at or over their
 * limit are the only ones doing any work, so they are the last thing to throw
 * away. What gets evicted instead is the attacker's own flood, which costs them
 * nothing and gains them nothing.
 *
 * If every bucket is at its limit and we are still over the ceiling, the map
 * stays over the ceiling. That is the right way round: memory pressure is
 * visible and recoverable, and quietly unlocking accounts under load is not.
 *
 * This is the fallback path. With Redis, expiry is the server's problem.
 */
function sweep(now: number) {
  // Time, and only time. The first two versions gated on `buckets.size`, which
  // meant that once the map sat at the ceiling the condition was true on every
  // call: a full scan and a log line per request, which is the per-request cost
  // the rewrite claimed to have removed, on ten times as many entries as
  // before. A reviewer measured 292x. Size cannot gate a sweep whose own
  // outcome is that the size stays high.
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;

  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }

  if (buckets.size <= MAX_BUCKETS) return;

  // Insertion order, so the front is the oldest, but skip anything that is
  // actively refusing requests. `Map.set` on an existing key does not reorder
  // it, so "oldest" here is first-created rather than least-recently-used, and
  // a long-lived bucket that is doing its job sits at the front where a naive
  // eviction would reach it first.
  const limit = LIMITS.auth.points;
  let excess = buckets.size - MAX_BUCKETS;
  let dropped = 0;
  for (const [key, bucket] of buckets) {
    if (excess <= 0) break;
    if (bucket.count >= limit) continue;
    buckets.delete(key);
    dropped++;
    excess--;
  }

  console.warn(
    `[rate-limit] in-process buckets exceeded ${MAX_BUCKETS}; dropped ${dropped} idle ones` +
      (excess > 0 ? `, and ${excess} still limiting were kept` : "") +
      `. This is the no-Redis fallback under load, and it is logged at most once every ` +
      `${SWEEP_INTERVAL_MS / 1000}s.`
  );
}

function consumeLocal(key: string, limit: Limit): RateResult {
  const now = Date.now();
  sweep(now);

  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + limit.windowMs });
    return { allowed: true, remaining: limit.points - 1, retryAfterSeconds: 0 };
  }

  existing.count += 1;
  const remaining = limit.points - existing.count;
  return {
    allowed: remaining >= 0,
    remaining: Math.max(0, remaining),
    retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
  };
}

/* ------------------------------------------------------------ redis path */

type RedisLike = {
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<number>;
  pttl(key: string): Promise<number>;
  /** Reading without spending, for limits that count failures. */
  get(key: string): Promise<string | null>;
  /** Clearing a bucket when the thing it rations succeeded. */
  del(...keys: string[]): Promise<number>;
};

let redis: RedisLike | null = null;
let redisTried = false;

let announcedFallback = false;

async function getRedis(): Promise<RedisLike | null> {
  if (redisTried) return redis;
  redisTried = true;
  if (!env.REDIS_URL) return null;
  try {
    const { default: Redis } = await import("ioredis");
    const client = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      // A rate limiter that blocks the request path when Redis is slow is worse
      // than one that briefly falls back to the local bucket.
      connectTimeout: 500,
      lazyConnect: false,
      enableOfflineQueue: false,
      // One attempt, then the local bucket. Retrying forever turns a missing
      // Redis into a stream of unhandled error events and nothing else.
      retryStrategy: () => null,
    });

    // Say which limiter is running, once. Without this an unreachable Redis is
    // an ioredis stack trace in the log and a silent switch to per-process
    // buckets, which are correct on one droplet and wrong the moment there are
    // two.
    client.on("error", (error: Error) => {
      if (announcedFallback) return;
      announcedFallback = true;
      console.warn(
        `[rate-limit] Redis at ${env.REDIS_URL} is unreachable (${error.message}). ` +
          "Falling back to in-process buckets, which are correct for a single " +
          "process and not for more than one."
      );
      redis = null;
    });

    redis = client as unknown as RedisLike;
  } catch {
    redis = null;
  }
  return redis;
}

/**
 * The stored key for a bucket.
 *
 * Exported because the security scripts clear the buckets they are about to
 * fill, and they need the same string this builds. Two places composing the
 * same key by hand is two places to get it wrong: rename the prefix here and a
 * hand-built copy elsewhere silently stops matching, leaving a tool that
 * quietly clears nothing and a 429 whose message blames the wrong thing.
 */
export const bucketKey = (routeClass: RouteClass, key: string) => `rl:${routeClass}:${key}`;

/** The two dimensions sign-in is limited on. Same reason: one definition. */
export const signInIpKey = (ip: string) => `signin:ip:${ip}`;
export const signInEmailKey = (email: string) => `signin:email:${email}`;

/**
 * Consumes one point.
 *
 * `key` should identify the actor and the thing being limited, for example
 * `signin:ip:203.0.113.5` or `user:<id>`.
 */
export async function consume(routeClass: RouteClass, key: string): Promise<RateResult> {
  const limit = LIMITS[routeClass];
  const full = bucketKey(routeClass, key);

  const client = await getRedis();
  if (!client) return consumeLocal(full, limit);

  try {
    const count = await client.incr(full);

    // Set the expiry whenever the key has none, not only when the counter reads
    // 1. `INCR` then `PEXPIRE` is two round trips, and a process or a Redis that
    // dies between them leaves a key that counts up forever: at ten it refuses
    // before the password is even checked, so the account's owner can never
    // clear it by knowing their password, and nothing ever expires it. Asking
    // for the TTL and repairing a missing one costs the round trip we were
    // already making.
    const ttlBefore = await client.pttl(full);
    if (ttlBefore < 0) await client.pexpire(full, limit.windowMs);
    const ttl = ttlBefore < 0 ? limit.windowMs : ttlBefore;
    const remaining = limit.points - count;
    return {
      allowed: remaining >= 0,
      remaining: Math.max(0, remaining),
      retryAfterSeconds: Math.max(1, Math.ceil((ttl > 0 ? ttl : limit.windowMs) / 1000)),
    };
  } catch {
    // Redis is down. Falling back keeps the app serving rather than failing
    // every request, and the local bucket still stops the obvious abuse.
    return consumeLocal(full, limit);
  }
}

/** Consumes a point and throws a 429 when the bucket is empty. */
export async function enforce(routeClass: RouteClass, key: string): Promise<void> {
  const result = await consume(routeClass, key);
  if (!result.allowed) {
    throw new AppError("rate_limited", "Too many requests. Try again shortly.", {
      meta: { retry_after_seconds: result.retryAfterSeconds },
    });
  }
}

/**
 * Empties a bucket.
 *
 * Used when the thing being rationed succeeded, so the failures that came
 * before it stop counting. Without this, ten fat-fingered attempts followed by
 * a correct one still leaves the account locked.
 */
export async function clearBucket(routeClass: RouteClass, key: string): Promise<void> {
  const full = bucketKey(routeClass, key);
  buckets.delete(full);

  const client = await getRedis();
  if (!client) return;
  await client.del(full).catch(() => {
    // Redis went away mid-request. The bucket expires on its own.
  });
}

/** Test seam. */
export function resetLocalBuckets() {
  buckets.clear();
}
