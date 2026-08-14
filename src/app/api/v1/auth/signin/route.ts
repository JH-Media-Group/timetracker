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
import { enforce } from "@/server/auth/rate-limit";
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
    const ip = clientIp(req) ?? "unknown";
    const raw = await req.json().catch(() => ({}));
    const { email, password } = parseOrThrow(schema, raw);

    await enforce("auth", `signin:ip:${ip}`);
    await enforce("auth", `signin:email:${email}`);

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
