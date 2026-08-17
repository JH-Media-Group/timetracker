/**
 * The nonce reaches the one inline script this app writes.
 *
 * There is no runtime symptom to notice if it stops. In production the CSP is
 * `script-src 'self' 'nonce-…' 'strict-dynamic'`, so a theme script without the
 * nonce is refused by the browser, and the only sign is the flash of the wrong
 * theme that the script exists to prevent: a cosmetic-looking glitch on first
 * paint, easy to blame on anything.
 *
 * React used to raise a hydration mismatch on that element, which was at least
 * a signal that something about the nonce was in play. It was not a useful one,
 * because it fires whether or not the nonce is correct: the HTML spec has the
 * browser move a nonce into an internal slot and blank the content attribute
 * once the script is parsed, so the client always reads "" and always
 * disagrees with the server. That warning is now suppressed on the element,
 * deliberately, which removes the last thing that would have said anything.
 *
 * So the plumbing is asserted here instead. It is a source-level check, in the
 * same spirit as `tests/routes.test.ts`: middleware runs in the edge runtime
 * and the layout is an async server component, and standing either one up would
 * test the harness rather than the wiring.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const middleware = read("src/middleware.ts");
const layout = read("src/app/layout.tsx");

describe("the content security policy", () => {
  it("uses a nonce in production and does not fall back to unsafe-inline there", () => {
    const production = middleware.match(/isProduction\s*\?\s*`([^`]*)`/);
    expect(production, "could not find the production script-src branch").not.toBeNull();

    const directive = production![1]!;
    expect(directive, "production must bind scripts to the nonce").toContain("'nonce-${nonce}'");
    expect(directive, "and let nonced scripts load the chunk loader").toContain("'strict-dynamic'");
    expect(
      directive,
      "'unsafe-inline' in production would make the nonce decorative, and every " +
        "inline script would run whether we meant it to or not"
    ).not.toContain("unsafe-inline");
  });

  it("passes the same nonce to the request and the response", () => {
    // The request header is what the layout reads; the response header is what
    // the browser enforces. A nonce generated twice would satisfy neither.
    expect(middleware).toMatch(/const nonce = [^\n]*\n/);
    expect(middleware, "the layout reads x-nonce off the request").toContain('headers.set("x-nonce", nonce)');
    expect(middleware, "and the policy has to carry the same value").toContain("policy(nonce)");

    const generations = middleware.match(/crypto\.randomUUID\(\)/g) ?? [];
    expect(
      generations.length,
      "more than one nonce generated per request means the header and the script can disagree"
    ).toBe(1);
  });

  it("authorizes the Toado widget endpoints", () => {
    expect(layout).toContain('src="https://app.toado.dev/widget/v1/loader.js"');
    expect(layout).toContain('data-toado-key="wgt_live_5cJDYjs5jzwD42SRs7BQqhBBwS6XwVXe"');
    expect(middleware).toContain("connect-src 'self' https://app.toado.dev");
    expect(middleware).toContain("frame-src https://challenges.cloudflare.com");
  });
});

describe("the theme script", () => {
  it("carries the nonce", () => {
    expect(layout, "the layout must read the nonce middleware set").toContain('get("x-nonce")');
    expect(layout, "and put it on the script, or the CSP refuses it in production").toMatch(
      /<script\s[^>]*nonce=\{nonce\}/s
    );
  });

  /**
   * The suppression is safe only while the script body is a constant.
   *
   * `suppressHydrationWarning` silences every attribute and content mismatch on
   * that element, not just the nonce. A theme script that started varying per
   * request would then differ between server and client with nothing to say so.
   */
  it("is a compile-time constant, which is what makes suppressing the warning safe", () => {
    const tokens = read("src/styles/tokens.ts");
    const declaration = tokens.match(/export const THEME_INIT_SCRIPT\s*=\s*([\s\S]*?);\n/);
    expect(declaration, "THEME_INIT_SCRIPT should be a single exported constant").not.toBeNull();

    const body = declaration![1]!;
    expect(
      body,
      "the script body must not interpolate anything. If it needs to vary, remove " +
        "suppressHydrationWarning from the script in layout.tsx at the same time, " +
        "because it is hiding every mismatch on that element and not only the nonce"
    ).not.toMatch(/\$\{/);
  });

  it("suppresses the hydration warning, and says why", () => {
    expect(layout).toContain("suppressHydrationWarning");
    expect(
      layout,
      "an unexplained suppressHydrationWarning reads as somebody silencing a real bug"
    ).toMatch(/nonce/i);
  });
});
