/**
 * Signing in from the security scripts.
 *
 * Shared by `authz-sweep` and `scope-probe`, which between them sign in seven
 * times per run. The limit is ten attempts per fifteen minutes per address, so
 * running the two back to back, or either of them twice, hits it. That is the
 * limiter working exactly as intended, and it makes the tools unusable.
 *
 * So these scripts clear the buckets they are about to fill. That is only
 * defensible because they are development tools: they create their own
 * accounts, they run against a development database, and the accounts they use
 * exist for the length of one run. Nothing here is reachable from the app.
 */

import { env } from "../../src/server/env";

/** Removes the sign-in buckets for this run, so the tool can be run twice. */
export async function clearSignInLimits(emails: string[]): Promise<void> {
  if (!env.REDIS_URL) return;  // in-process buckets die with the process anyway

  try {
    const { default: Redis } = await import("ioredis");
    const client = new Redis(env.REDIS_URL, {
      connectTimeout: 500,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });

    // Only the sign-in buckets, and only the ones this run will use. A blanket
    // flush would clear the limits protecting everything else.
    const keys = ["rl:auth:signin:ip:unknown", ...emails.map((e) => `rl:auth:signin:email:${e}`)];
    await client.del(...keys);
    await client.quit();
  } catch {
    // Redis unreachable means the in-process buckets are in use, and those are
    // gone the moment this process starts. Nothing to clear.
  }
}

/**
 * Signs in and returns the cookie, or explains why it could not.
 *
 * Reading `set-cookie` off a 429 gives a TypeError about null, which reads as a
 * broken script rather than as a working defence.
 */
export async function signIn(base: string, email: string, password: string): Promise<string> {
  const res = await fetch(`${base}/api/v1/auth/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base },
    body: JSON.stringify({ email, password }),
  });

  const cookie = res.headers.get("set-cookie");
  if (res.ok && cookie) return cookie.split(";")[0]!;

  if (res.status === 429) {
    const retry = res.headers.get("retry-after");
    throw new Error(
      `Sign-in is rate limited${retry ? `, retry in ${retry}s` : ""}. ` +
        "Ten attempts per fifteen minutes per address, which is the limiter working. " +
        "This script clears its own buckets first, so seeing this means Redis is " +
        "unreachable and the in-process buckets are in use: restart the app server."
    );
  }

  throw new Error(`Could not sign in as ${email}: ${res.status} ${await res.text()}`);
}
