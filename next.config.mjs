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

/*
 * The Content Security Policy is NOT here.
 *
 * It carries a per-request nonce, which a static header cannot, so it is built
 * in `src/middleware.ts`. Everything below is genuinely constant.
 */
const securityHeaders = [
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

  /*
   * Emit `.next/standalone`: server.js plus only the node_modules actually
   * reached, traced from the entry points.
   *
   * Required by the Dockerfile. Without it the runtime image has to carry the
   * whole dependency tree, dev dependencies and all, which is both large and a
   * larger attack surface than the thing needs.
   *
   * BACKEND_PRD §17.1 describes the multi-stage build that depends on this and
   * the setting was never added, so the Dockerfile it describes could not have
   * worked as written.
   */
  output: "standalone",

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
