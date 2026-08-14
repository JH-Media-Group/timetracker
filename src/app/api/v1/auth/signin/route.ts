/**
 * POST /api/v1/auth/signin
 *
 * Email and password. Google Workspace SSO is the intended route in for staff;
 * this exists for external contractors and for the period before the Google
 * credentials are configured.
 *
 * Rate limited per IP and per email, because those are the two axes credential
 * stuffing moves along.
 */

import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/server/db/client";
import * as s from "@/server/db/schema";
import { verifyPassword } from "@/server/auth/password";
import { createSession, sessionCookieOptions } from "@/server/auth/session";
import { clearBucket, enforce, signInEmailKey, signInIpKey } from "@/server/auth/rate-limit";
import { AppError, toProblem } from "@/server/errors";
import { clientIp, parseOrThrow } from "@/server/http";
import { newId } from "@/server/db/ids";

const schema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address."),
  password: z.string().min(1, "Enter your password."),
});

export async function POST(req: NextRequest) {
  const requestId = newId();

  try {
    const ip = clientIp(req);
    const raw = await req.json().catch(() => ({}));
    const { email, password } = parseOrThrow(schema, raw);

    // Per address, but only when we know the address.
    //
    // This used to fall back to the literal string "unknown", which put every
    // caller on earth into one bucket: without a trusted proxy `clientIp`
    // returns null for everybody. Ten anonymous POSTs to this route, needing no
    // account and no password because this runs before the user lookup, then
    // locked out all eleven staff for fifteen minutes. Repeated once every
    // ninety seconds it locked them out indefinitely, and password sign-in is
    // currently the only way in.
    //
    // A shared bucket is not a weaker limit, it is a different mechanism: it
    // rations the whole company by the behaviour of one stranger. So when the
    // address is unknown the per-address limit is skipped and the per-email
    // bucket carries the load alone.
    //
    // The per-email point is spent up front and given back on success.
    //
    // An earlier version read the count first and spent a point only if the
    // password turned out to be wrong, so that a correct password never
    // contributed to a lockout. The intent was right and the implementation was
    // not: read-then-act is not atomic, and a reviewer sent twenty simultaneous
    // wrong passwords against a bucket with one point left and got twenty 401s.
    // Every one of them read the same count before any of them wrote. That is a
    // rate limiter that stops sequential guessing and not concurrent guessing,
    // which is the only kind worth doing.
    //
    // Consuming first is atomic (Redis INCR, or a single-threaded map), so the
    // count cannot be raced. Clearing on success below recovers the property
    // that mattered: a person who mistypes nine times and then gets it right
    // walks away with an empty bucket rather than one failure from a lockout.
    //
    // What this still leaves, stated plainly rather than argued away: ten wrong
    // guesses against one address locks that address for fifteen minutes, and
    // somebody who knows an address can do that deliberately. It is inherent to
    // per-account limiting and it is the accepted trade, because it is bounded,
    // it is per-account rather than company-wide, and the owner clears it by
    // signing in once the window rolls.
    //
    // The brute-force ceiling is 40 guesses an hour against a named account.
    // Too slow for a decent password, too fast to be relaxed about a weak one,
    // and it is the whole defence whenever the address is unknown. Which is why
    // TRUST_PROXY is a required answer in production (src/instrumentation.ts)
    // rather than a default: behind Caddy the address is known, the branch below
    // runs, and the per-address limit does the real work.
    if (ip) await enforce("auth", signInIpKey(ip));
    await enforce("auth", signInEmailKey(email));

    const [user] = await db
      .select({
        id: s.users.id,
        passwordHash: s.users.passwordHash,
        archivedAt: s.users.archivedAt,
      })
      .from(s.users)
      .where(eq(s.users.email, email))
      .limit(1);

    // One message for every failure. "No such account" and "wrong password"
    // are separate facts, and telling them apart is how an attacker enumerates
    // who works here. verifyPassword burns comparable time either way.
    const ok = user && !user.archivedAt && (await verifyPassword(user.passwordHash, password));
    if (!ok) {
      throw new AppError("unauthenticated", "That email and password do not match.");
    }

    // Succeeding gives the point back on both dimensions.
    //
    // The address bucket matters more than it looks. Everybody signs in from
    // the office, so behind Caddy all eleven staff share one address, and
    // counting successes there rations the company: a reviewer signed twelve
    // people in with the correct password from one address and the twelfth got
    // a 429. That is the same shared-bucket outage the "unknown" key used to
    // cause, moved to the office IP and now triggered by ordinary Monday
    // morning use rather than by an attacker.
    //
    // Failures still accumulate per address, which is the part that stops
    // credential stuffing. Successes do not, because a correct password is
    // evidence the request was legitimate, and rate limiting legitimate traffic
    // is just an outage with extra steps.
    await clearBucket("auth", signInEmailKey(email));
    if (ip) await clearBucket("auth", signInIpKey(ip));

    const session = await createSession(user.id, {
      ip: clientIp(req),
      userAgent: req.headers.get("user-agent"),
    });

    const response = NextResponse.json(
      { data: { ok: true } },
      { headers: { "Cache-Control": "private, no-store", "X-Request-Id": requestId } }
    );
    response.cookies.set({ ...sessionCookieOptions(session.expiresAt), value: session.token });
    return response;
  } catch (error) {
    const problem = toProblem(error, requestId);
    if (problem.status >= 500) console.error(`[${requestId}] signin failed`, error);
    return NextResponse.json(problem, {
      status: problem.status,
      headers: { "Content-Type": "application/problem+json", "Cache-Control": "private, no-store" },
    });
  }
}
