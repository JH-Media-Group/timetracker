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
import {
  clearBucket,
  consume,
  enforce,
  enforceAvailable,
  signInEmailKey,
  signInIpKey,
} from "@/server/auth/rate-limit";
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
    // The per-email bucket counts FAILURES, not attempts, and a success clears
    // it. That distinction is the difference between a limiter and a weapon.
    // Counting attempts meant anybody who knew an address could spend ten
    // requests on it, right or wrong, and lock the owner out for fifteen
    // minutes; the owner could not clear it by typing the correct password,
    // because the correct password also counted. Eleven staff on one guessable
    // domain, one of whose addresses is committed in this repository, made that
    // 110 requests to lock out the entire company, repeatable forever.
    //
    // What this still leaves, stated plainly rather than argued away: ten wrong
    // guesses against one address still locks that address for fifteen minutes.
    // That is inherent to per-account limiting and it is the accepted trade. It
    // is bounded, it is per-account rather than company-wide, and a legitimate
    // user is never the one who trips it.
    //
    // The brute-force ceiling is 40 guesses an hour against a named account.
    // Too slow for a decent password, too fast to be relaxed about a weak one,
    // and it is the whole defence whenever the address is unknown. Which is why
    // TRUST_PROXY is a required answer in production (src/instrumentation.ts)
    // rather than a default: behind Caddy the address is known, the branch below
    // runs, and the per-address limit does the real work.
    if (ip) await enforce("auth", signInIpKey(ip));
    await enforceAvailable("auth", signInEmailKey(email));

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
      // Now, and only now, is a point spent. See the note above the check.
      await consume("auth", signInEmailKey(email));
      throw new AppError("unauthenticated", "That email and password do not match.");
    }

    // Succeeding clears the failures that came before, so a handful of typos
    // followed by the right password leaves nothing behind.
    await clearBucket("auth", signInEmailKey(email));

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
