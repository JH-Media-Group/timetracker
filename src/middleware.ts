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

const isProduction = process.env.NODE_ENV === "production";

/**
 * The Content Security Policy, built per request around a fresh nonce.
 *
 * It lives here rather than in `next.config.mjs` because a nonce has to change
 * every time, and a static header cannot. Next finds the nonce in this header
 * and stamps it on its own bootstrap scripts; the one inline script this app
 * writes reads it from `x-nonce` in the root layout.
 *
 * `'strict-dynamic'` means a script that carries the nonce may load others,
 * which is how Next's chunk loading keeps working without allowing anything
 * else. Styles keep `'unsafe-inline'`, which is unavoidable: Tailwind v4 emits
 * inline styles and AG Grid sets them on every cell.
 */
function policy(nonce: string): string {
  return [
    "default-src 'self'",
    isProduction
      ? `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`
      : // The dev server's refresh runtime evaluates code, and its scripts are
        // injected without a nonce.
        `script-src 'self' 'unsafe-inline' 'unsafe-eval'`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob:",
    "connect-src 'self'" + (isProduction ? "" : " ws: wss:"),
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    ...(isProduction ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

/** Attaches the nonce to the request Next renders with, and to the response. */
function withPolicy(req: NextRequest, response?: NextResponse): NextResponse {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const headers = new Headers(req.headers);
  headers.set("x-nonce", nonce);

  const out = response ?? NextResponse.next({ request: { headers } });
  out.headers.set("Content-Security-Policy", policy(nonce));
  out.headers.set("x-nonce", nonce);
  return out;
}

/** Paths that never need a session. */
const PUBLIC_PREFIXES = ["/api/v1/auth/"];

/**
 * The health probes, matched exactly rather than by prefix.
 *
 * `/api/health` used to sit in the prefix list, which exempted every path
 * beginning with those eleven characters. `/api/health-admin` would have been
 * unauthenticated, and so would `/api/healthcheck-internal`, and nothing would
 * have said so. Found by an adversarial review; the same trap is why
 * `/api/v1/auth/` carries a trailing slash.
 *
 * `/icon` came out of the prefix list for the same reason and is matched here.
 */
const PUBLIC_EXACT = new Set([
  "/signin",
  "/set-password",
  "/api/health",
  "/api/health/live",
  "/api/health/ready",
  "/icon.svg",
]);

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC_EXACT.has(pathname) || PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) {
    // Somebody already signed in has no use for the sign-in page.
    if (pathname === "/signin" && req.cookies.has(SESSION_COOKIE)) {
      return withPolicy(req, NextResponse.redirect(new URL("/timesheet", req.url)));
    }
    return withPolicy(req);
  }

  if (req.cookies.has(SESSION_COOKIE)) return withPolicy(req);

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
  return withPolicy(req, NextResponse.redirect(signin));
}

export const config = {
  matcher: [
    // Everything except Next's own static output and the public files.
    // The backslashes have to survive the TypeScript string as well as the
    // regex, so each escape is doubled. Written singly, a lone backslash-dot is
    // not a recognised string escape and collapses to a bare dot, which matches
    // any character: every path whose last three characters were "png" would
    // then skip middleware entirely. That is what this comment used to describe
    // while the line below it did the wrong thing.
    "/((?!_next/static|_next/image|favicon\\.ico|.*\\.svg|.*\\.png|.*\\.ico).*)",
  ],
};
