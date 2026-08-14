/**
 * Signing in from the security scripts.
 *
 * Shared by `authz-sweep` and `scope-probe`, which between them sign in seven
 * times per run. The limit is ten attempts per fifteen minutes per address, so
 * running the two back to back, or either of them twice, hits it. That is the
 * limiter working exactly as intended, and it makes the tools unusable.
 *
 * So these scripts clear the buckets they are about to fill, after
 * `assertLocalTarget` has established that the stack in question is this
 * machine's. Nothing in here is reachable from the app: these two `.mts` files
 * are the only importers.
 */

import { env } from "../../src/server/env";
import { bucketKey, signInEmailKey } from "../../src/server/auth/rate-limit";

/**
 * Removes the sign-in buckets this run will fill, so the tool can be run twice.
 *
 * Only the per-email buckets, and only for accounts this script created and
 * will delete. Nothing shared is touched.
 *
 * An earlier version also deleted the per-address bucket, which sounded
 * run-scoped and was not: without a trusted proxy the server cannot see a
 * client address, so every unauthenticated caller in the world shared one
 * bucket, and clearing it removed sign-in brute-force protection for the whole
 * instance. That bucket no longer exists. The sign-in route now skips the
 * per-address limit when it has no address rather than inventing a shared one,
 * so there is nothing left here to over-clear.
 *
 * The keys are built by the limiter's own functions rather than by hand. A
 * hand-built copy is a copy that stops matching the day somebody renames the
 * prefix, and the symptom of that is an intermittent 429 whose message blames
 * the wrong component.
 */
export async function clearSignInLimits(emails: string[]): Promise<void> {
  if (!env.REDIS_URL) {
    // Nothing to clear here, but nothing cleared either: the in-process buckets
    // live in the Next server's memory, not this process's, and that server has
    // been up for hours. The second run of the day will hit a 429 and there is
    // nothing this script can do about it from outside. `signIn` says so.
    return;
  }

  try {
    const { default: Redis } = await import("ioredis");
    const client = new Redis(env.REDIS_URL, {
      connectTimeout: 500,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });

    // ioredis emits `error` whether or not anybody is listening, and an
    // unhandled one prints a raw ECONNREFUSED stack. This whole file exists so
    // that a predictable failure reads as a sentence rather than as a crash, so
    // swallow it here and let the catch below do the explaining.
    client.on("error", () => {});

    const keys = emails.map((email) => bucketKey("auth", signInEmailKey(email)));
    await client.del(...keys);
    await client.quit();
  } catch {
    // Redis unreachable, so the server is using its in-process buckets and this
    // process cannot reach them. Same story as the early return above.
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

  if (res.ok) {
    // Reporting this as a failed sign-in would print the status 200 and the
    // body `{"ok":true}` under the words "could not sign in", which is a
    // message that argues with itself.
    throw new Error(
      `Signed in as ${email}, but the response carried no set-cookie header, so ` +
        "there is no session to make the next request with. Something between " +
        "this script and the app is stripping the header, or the token has " +
        "stopped being a cookie."
    );
  }

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
