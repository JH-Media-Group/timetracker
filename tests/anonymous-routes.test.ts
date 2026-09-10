/**
 * The pages a person reaches before signing in.
 *
 * There were four independent lists of these: the middleware's, the data
 * provider's, the shell's and the timer's. Adding `/set-password` meant
 * remembering all four, and the change that added it had to touch three files
 * to finish what the fourth had started. They now read one array.
 *
 * The previous version of this file asserted that each of those three files
 * contained the string `"/set-password"`. That passes when the code is
 * commented out, and it fails when the literal is replaced by the shared
 * constant, which is the fix. It was checking spelling rather than behaviour.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ANONYMOUS_PAGES, isAnonymousPage, shouldLoadBugWidget } from "@/lib/anonymous-pages";

describe("the anonymous page list", () => {
  /*
    Named one by one on purpose.

    A page on this list runs before there is a session, is exempt from the
    middleware's session check, and does not load the bug-reporting widget.
    Adding one should be a decision somebody made, not something that arrives
    with a feature, so this fails until the new page is written down here.

    `/forgot-password` was added when the reset-request screen was built: the
    endpoint had existed since auth shipped and nothing called it, so the only
    way back into an account was to ask an administrator.
  */
  it("holds exactly the pages somebody can reach without a session", () => {
    expect([...ANONYMOUS_PAGES]).toEqual(["/signin", "/set-password", "/forgot-password"]);
  });

  it("matches exactly, so a lookalike path is not anonymous", () => {
    // `/signin` was once matched with `startsWith`, which made every path
    // beginning with those seven characters public.
    expect(isAnonymousPage("/signin")).toBe(true);
    expect(isAnonymousPage("/set-password")).toBe(true);
    expect(isAnonymousPage("/forgot-password")).toBe(true);
    expect(isAnonymousPage("/signin-evil")).toBe(false);
    expect(isAnonymousPage("/set-password-trap")).toBe(false);
    expect(isAnonymousPage("/forgot-password-trap")).toBe(false);
    expect(isAnonymousPage("/timesheet")).toBe(false);
  });
});

describe("the bug-reporting widget", () => {
  it("never loads on a page where a credential is typed", () => {
    for (const page of ANONYMOUS_PAGES) {
      expect(isAnonymousPage(page)).toBe(true);
      expect(
        shouldLoadBugWidget({ enabled: true, anonymousPage: true }),
        `the widget must stay off ${page} even when it is switched on`
      ).toBe(false);
    }
  });

  it("loads elsewhere when it is switched on, and not when it is off", () => {
    expect(shouldLoadBugWidget({ enabled: true, anonymousPage: false })).toBe(true);
    expect(shouldLoadBugWidget({ enabled: false, anonymousPage: false })).toBe(false);
  });
});

describe("every consumer reads the shared list", () => {
  it.each([
    ["src/middleware.ts", "ANONYMOUS_PAGES"],
    ["src/app/layout.tsx", "ANONYMOUS_PAGE_HEADER"],
    ["src/components/app/providers.tsx", "ANONYMOUS_PAGES"],
    ["src/components/app/shell.tsx", "ANONYMOUS_PAGES"],
    ["src/components/app/timer.tsx", "isAnonymousPage"],
  ])("%s imports from lib/anonymous-pages", (file, symbol) => {
    const text = readFileSync(file, "utf8");
    expect(text, `${file} should import ${symbol} rather than keep its own list`).toContain(
      "@/lib/anonymous-pages"
    );
    expect(text).toContain(symbol);
    expect(
      text.includes('"/set-password"'),
      `${file} still hard-codes an anonymous path instead of using the shared list`
    ).toBe(false);
  });
});
