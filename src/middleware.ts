/**
 * Edge middleware.
 *
 * Two jobs, both cheap enough to do on every request: keep unauthenticated
 * people off the app, and keep authenticated people off the sign-in page.
 *
 * It checks only for the *presence* of the session cookie. Validating it would
 * mean a database round trip in the edge runtime, which cannot reach Postgres;
 * the API routes validate properly on every call, so the worst a forged cookie
 * buys is a rendered shell whose every request then returns 401. That is the
 * right split: middleware is a redirect, not a security boundary.
 */

import { NextResponse, type NextRequest } from "next/server";

const SESSION_COOKIE = "tally_session";

/** Paths that never need a session. */
const PUBLIC_PREFIXES = ["/signin", "/api/v1/auth/", "/api/health", "/_next", "/favicon", "/icon", "/tally-"];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) {
    // Somebody already signed in has no use for the sign-in page.
    if (pathname.startsWith("/signin") && req.cookies.has(SESSION_COOKIE)) {
      return NextResponse.redirect(new URL("/timesheet", req.url));
    }
    return NextResponse.next();
  }

  if (req.cookies.has(SESSION_COOKIE)) return NextResponse.next();

  // API calls get a problem document; a redirect to HTML would be parsed as
  // JSON by the client and produce a confusing error.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      {
        type: "https://tally.jhmg/errors/unauthenticated",
        title: "Sign in required",
        status: 401,
        detail: "Sign in to continue.",
        code: "unauthenticated",
        request_id: "middleware",
      },
      { status: 401, headers: { "Content-Type": "application/problem+json" } }
    );
  }

  const signin = new URL("/signin", req.url);
  // Round-trip where they were going, so signing in lands them there.
  if (pathname !== "/") signin.searchParams.set("next", pathname + req.nextUrl.search);
  return NextResponse.redirect(signin);
}

export const config = {
  matcher: [
    // Everything except Next's own static output and the public files.
    // The backslashes have to survive the TypeScript string as well as the
    // regex, so each escape is doubled. Written singly, a lone backslash-dot is
    // not a recognised string escape and collapses to a bare dot, which matches
    // any character: every path whose last three characters were "png" would
    // then skip middleware entirely.
    "/((?!_next/static|_next/image|favicon\.ico|.*\.svg|.*\.png|.*\.ico).*)",
  ],
};
