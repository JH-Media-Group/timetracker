/**
 * Bearer token authentication via the api_tokens table.
 *
 * Tokens use the format `tally_<prefix>_<secret>`, where the prefix is an
 * eight-character identifier visible in the UI and the secret is a base64url
 * string. The prefix lets a person recognise which token fired without
 * exposing the secret, and it is what the audit log records.
 *
 * This module handles parsing and format validation only. The database lookup,
 * hash comparison, scope resolution, and last-used bookkeeping live in
 * @/server/services/api-keys so they can run inside a caller's transaction.
 *
 * Specification: docs/BACKEND_PRD.md section 7.
 */

import type { Actor } from "@/server/ctx";
import { resolveApiToken } from "@/server/services/api-keys";

/**
 * Token format: tally_XXXXXXXX_<base64url-secret>
 *
 * The prefix is exactly eight alphanumeric characters. The secret is one or
 * more base64url characters (letters, digits, hyphen, underscore).
 */
const TOKEN_RE = /^tally_([A-Za-z0-9]{8})_([A-Za-z0-9_-]+)$/;

/**
 * Resolves a Bearer token from an Authorization header to an actor.
 *
 * Returns null for any malformed, missing, or unrecognised token. The caller
 * (http.ts) falls through to session auth when this returns null, so a bad
 * token is not an error here, just "not this auth method".
 */
export async function resolveBearer(
  authHeader: string
): Promise<{ actor: Actor; prefix: string } | null> {
  // Case-insensitive check for the "Bearer " scheme.
  if (!/^Bearer /i.test(authHeader)) return null;

  const rawToken = authHeader.slice(7).trim();
  if (!TOKEN_RE.test(rawToken)) return null;

  return resolveApiToken(rawToken);
}
