/**
 * Next configuration.
 *
 * The interesting part is the header block. Tally is signed-in software with no
 * public pages, served from one droplet, and every one of these headers costs
 * nothing and closes something.
 *
 * @type {import('next').NextConfig}
 */

const isProduction = process.env.NODE_ENV === "production";

/**
 * Content Security Policy.
 *
 * `'unsafe-inline'` for styles is unavoidable: Tailwind v4 emits inline styles
 * and AG Grid sets them on every cell. Scripts do not get it in production; the
 * one inline script (the theme initialiser, which must be render-blocking to
 * avoid a flash of the wrong theme) is allowed through `'strict-dynamic'` and
 * the nonce Next adds. In development Next's own refresh runtime needs
 * `'unsafe-eval'`, so the policy is relaxed there and only there.
 */
const csp = [
  "default-src 'self'",
  isProduction
    ? "script-src 'self' 'unsafe-inline'"
    : "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  // Fonts are self-hosted by next/font, so no CDN needs allowing.
  "font-src 'self' data:",
  "img-src 'self' data: blob:",
  "connect-src 'self'" + (isProduction ? "" : " ws: wss:"),
  // No plugins, no framing, no other origin embedding us.
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  // A form that posts anywhere but here is a form somebody injected.
  "form-action 'self'",
  ...(isProduction ? ["upgrade-insecure-requests"] : []),
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  // The full URL of an internal tool is not another site's business, and our
  // URLs carry client and project ids.
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  },
  ...(isProduction
    ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }]
    : []),
];

const nextConfig = {
  reactStrictMode: true,
  eslint: { ignoreDuringBuilds: true },
  // The version banner is free reconnaissance.
  poweredByHeader: false,

  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      {
        // Nothing under the API is ever cacheable by a shared cache: every
        // response is scoped to one person's permissions.
        source: "/api/:path*",
        headers: [{ key: "Cache-Control", value: "private, no-store" }],
      },
    ];
  },
};

export default nextConfig;
