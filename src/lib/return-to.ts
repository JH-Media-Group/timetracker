/**
 * The `?next=` hop, used when a form sends you off to create something it needs.
 *
 * "Add new client" from the project form is the case: you leave a half-filled
 * form, make a client, and should come back to the form with that client
 * chosen rather than to the client's own page.
 *
 * **Only a path on this site.** An unchecked `next` is an open redirect, and
 * this one is written into a link somebody could be handed. A value that is
 * not a plain absolute path is dropped rather than sanitised, because half
 * understanding a redirect target is how the interesting bypasses work.
 *
 * Two clauses, and both are reachable. The leading "//" has to be named,
 * because a protocol-relative URL is built only from characters a path may
 * contain. Everything else falls to the character class, backslash included,
 * which is what rejects "/\evil.example" (read as protocol-relative by
 * several browsers). A third clause tested for that backslash by hand; no
 * mutation of it could be made to fail, so it is gone rather than standing
 * there implying it does something.
 */
export function safeReturnPath(next: string | null | undefined): string | null {
  if (!next) return null;
  if (!next.startsWith("/")) return null;
  if (next.startsWith("//")) return null;
  // No scheme, no host, no control characters. A path, a query, a hash.
  if (!/^\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/?#[\]]*$/.test(next)) return null;
  return next;
}

/** Add or replace one query parameter on a path produced by `safeReturnPath`. */
export function withParam(path: string, key: string, value: string): string {
  const [base, hash] = path.split("#");
  const [pathname, query = ""] = base!.split("?");
  const params = new URLSearchParams(query);
  params.set(key, value);
  return `${pathname}?${params.toString()}${hash ? `#${hash}` : ""}`;
}
