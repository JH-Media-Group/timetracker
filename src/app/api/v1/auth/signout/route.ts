/**
 * POST /api/v1/auth/signout
 *
 * Revokes the session row as well as clearing the cookie. Clearing only the
 * cookie would leave a working credential in anybody's hands who copied it.
 */

import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, clearedCookieOptions, revokeSession } from "@/server/auth/session";

export async function POST(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (token) await revokeSession(token);

  const response = NextResponse.json({ data: { ok: true } }, { headers: { "Cache-Control": "private, no-store" } });
  response.cookies.set(clearedCookieOptions());
  return response;
}
