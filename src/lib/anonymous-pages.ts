/**
 * The pages a person can reach before they are signed in.
 *
 * One list, because there were four. The middleware decided which paths skip
 * the session check, `providers.tsx` decided which pages must not bootstrap,
 * `shell.tsx` decided which render without the app chrome, and `timer.tsx`
 * decided which must not poll. Adding `/set-password` meant remembering all
 * four, and the commit that added it had to touch three files to finish the
 * job the fourth had already started.
 *
 * Exact paths, never prefixes. `/signin` was once matched with `startsWith`,
 * which made `/signin-anything` public; the middleware carries the longer
 * version of that story.
 *
 * Plain data in `lib/` so the edge middleware, a server component and three
 * client components can all read the same array.
 */
export const ANONYMOUS_PAGES = ["/signin", "/set-password", "/forgot-password"] as const;

export type AnonymousPage = (typeof ANONYMOUS_PAGES)[number];

/** Exact match, for the same reason the list is exact. */
export function isAnonymousPage(pathname: string): boolean {
  return (ANONYMOUS_PAGES as readonly string[]).includes(pathname);
}

/**
 * The header the middleware sets so a server component can ask the question.
 *
 * A root layout cannot read the pathname on the server, and the bug-reporting
 * widget must not load where somebody is typing a password. The middleware
 * already knows, and already passes the CSP nonce down this way.
 */
export const ANONYMOUS_PAGE_HEADER = "x-anonymous-page";

/**
 * Whether the third-party bug-reporting widget may load on this render.
 *
 * A function rather than an inline `&&` in the layout so the rule can be
 * asserted directly. The rule is the interesting part: **off on any page a
 * person reaches before signing in**, whatever the setting says, because those
 * are the pages where a credential is being typed and the widget runs with
 * `strict-dynamic` trust in this origin.
 */
export function shouldLoadBugWidget(opts: { enabled: boolean; anonymousPage: boolean }): boolean {
  return opts.enabled && !opts.anonymousPage;
}
