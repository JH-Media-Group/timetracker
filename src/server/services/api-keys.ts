/**
 * API token management.
 *
 * Self-service tokens for MCP and future API access. Every person can create
 * tokens for themselves (never for another person), revoke them, and list their
 * own. The raw token is shown once at creation and never again: only a SHA-256
 * digest is stored.
 *
 * SHA-256 rather than argon2 is deliberate here, for the same reason as sessions:
 * the secret is 32 bytes of randomness, so there is nothing to brute force, and
 * token resolution happens on every MCP request.
 *
 * Token format: `tally_<prefix>_<secret>`
 *   - prefix: 8 hex chars (randomBytes(4)), stored in clear for identification
 *   - secret: 32 random bytes, base64url-encoded
 *
 * Scopes intersect with the owner's capabilities; they never widen them. An
 * empty scopes array means no capabilities.
 */

import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull, gt } from "drizzle-orm";
import type { Actor, Ctx } from "@/server/ctx";
import { db } from "@/server/db/client";
import * as s from "@/server/db/schema";
import { newId } from "@/server/db/ids";
import { AppError, notFound } from "@/server/errors";
import type { Capability } from "@/server/auth/capabilities";

/* ---------------------------------------------------------------- constants */

const MAX_EXPIRY_DAYS = 365;
const DEFAULT_EXPIRY_DAYS = 90;

/** Minimum interval between `lastUsedAt` writes, in milliseconds. */
const TOUCH_INTERVAL_MS = 60 * 1000;

const digest = (token: string) =>
  createHash("sha256").update(token).digest("hex");

/**
 * Scope groups map a short name to the capabilities it covers.
 *
 * When a token carries scopes, its Actor gets only the intersection of the
 * owner's capabilities and the capabilities named by those scopes. An empty
 * scopes array means "everything the owner can do".
 */
export const TOKEN_SCOPES = ["tally.read", "tally.financial.read", "tally.time.write", "tally.expenses", "tally.approvals", "tally.admin"] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

export const SCOPE_LABELS: Record<TokenScope, { title: string; description: string }> = {
  "tally.read": { title: "Read only", description: "View the Tally records you can already see." },
  "tally.financial.read": { title: "Sensitive financial data", description: "View invoices, financial reports, billable and payroll cost rates, and audit history allowed by your Tally permissions." },
  "tally.time.write": { title: "Log time", description: "Start timers and create, edit, or remove time within your reach." },
  "tally.expenses": { title: "Manage expenses", description: "Create and update expenses within your reach." },
  "tally.approvals": { title: "Review time", description: "Submit and review timesheets within your reach." },
  "tally.admin": { title: "Administer Tally", description: "Change account setup, limited by your Tally permissions and confirmation." },
};

export const SCOPE_GROUPS: Record<TokenScope, readonly Capability[]> = {
  "tally.read": [
    "time:view_others", "expense:view_others", "project:view", "client:view", "people:view",
    "report:view_own", "report:view_team", "report:view_all",
  ],
  "tally.financial.read": ["invoice:view", "report:view_financial", "rates:view_billable", "rates:view_cost", "audit:view"],
  "tally.time.write": [
    "time:create_own",
    "time:edit_own",
    "time:delete_own",
    "time:view_others",
    "time:edit_others",
    "time:delete_others",
  ],
  "tally.expenses": [
    "expense:create_own",
    "expense:edit_own",
    "expense:delete_own",
    "expense:view_others",
    "expense:edit_others",
    "expense:delete_others",
    "expense:manage",
  ],
  "tally.approvals": ["approval:submit", "approval:review", "approval:review_all"],
  "tally.admin": [
    "project:view",
    "project:manage",
    "project:manage_own",
    "project:archive",
    "client:view",
    "client:manage",
    "task:manage",
    "people:view",
    "people:manage",
    "people:invite",
    "rates:view_billable",
    "rates:view_cost",
    "rates:manage",
    "invoice:view",
    "invoice:manage",
    "invoice:send",
    "invoice:delete",
    "report:view_own",
    "report:view_team",
    "report:view_all",
    "report:view_financial",
    "settings:manage",
    "integrations:manage",
    "audit:view",
    "bulk:execute",
  ],
} as const;

const VALID_SCOPES = new Set<string>(TOKEN_SCOPES);

/* --------------------------------------------------------- scope resolution */

/**
 * Intersects the owner's capabilities with the scope groups named by the token.
 *
 * Empty scopes = no restriction (the full set is returned unchanged).
 * Non-empty scopes = only capabilities covered by those groups, and only if
 * the owner already holds them.
 */
export function capabilitiesForScopes(
  ownerCaps: ReadonlySet<Capability>,
  scopes: string[]
): ReadonlySet<Capability> {
  if (scopes.length === 0) return new Set<Capability>();

  const allowed = new Set<Capability>();
  for (const scope of scopes) {
    const group = VALID_SCOPES.has(scope) ? SCOPE_GROUPS[scope as TokenScope] : undefined;
    if (!group) continue;
    for (const cap of group) {
      if (ownerCaps.has(cap)) allowed.add(cap);
    }
  }
  return allowed;
}

/* --------------------------------------------------------------- mutations */

export interface CreateApiTokenInput {
  label: string;
  scopes?: string[];
  expiresInDays?: number;
}

export interface CreatedApiToken {
  id: string;
  prefix: string;
  token: string;
  label: string;
  scopes: string[];
  expiresAt: Date;
}

/**
 * Create an API token for the calling user.
 *
 * Self-service only: the token is always created for `ctx.actor.userId`.
 * The raw token string is returned exactly once, here, and never stored.
 */
export async function createApiToken(
  ctx: Ctx,
  input: CreateApiTokenInput
): Promise<CreatedApiToken> {
  const label = input.label.trim();
  if (!label) {
    throw new AppError("validation_failed", "A label is required.", {
      fieldErrors: { label: ["Required"] },
    });
  }

  // Validate scopes
  const scopes = input.scopes ?? [];
  for (const scope of scopes) {
    if (!VALID_SCOPES.has(scope)) {
      throw new AppError("validation_failed", `Unknown scope: ${scope}.`, {
        fieldErrors: { scopes: [`Unknown scope: ${scope}`] },
      });
    }
  }

  // Validate and compute expiry
  const days = input.expiresInDays ?? DEFAULT_EXPIRY_DAYS;
  if (days < 1 || days > MAX_EXPIRY_DAYS) {
    throw new AppError(
      "validation_failed",
      `Expiry must be between 1 and ${MAX_EXPIRY_DAYS} days.`,
      { fieldErrors: { expiresInDays: [`Between 1 and ${MAX_EXPIRY_DAYS}`] } }
    );
  }
  const expiresAt = new Date(ctx.now().getTime() + days * 86_400_000);

  // Generate the token
  const prefix = randomBytes(4).toString("hex"); // 8 hex chars
  const secret = randomBytes(32).toString("base64url");
  const rawToken = `tally_${prefix}_${secret}`;
  const tokenHash = digest(rawToken);

  const id = newId();

  await ctx.db.insert(s.apiTokens).values({
    id,
    userId: ctx.actor.userId,
    label,
    tokenHash,
    prefix,
    scopes,
    expiresAt,
  });

  ctx.audit({
    action: "api_token.created",
    entityType: "api_token",
    entityId: id,
    entityLabel: label,
    after: { prefix, scopes, expiresAt: expiresAt.toISOString() },
  });

  return { id, prefix, token: rawToken, label, scopes, expiresAt };
}

/* ------------------------------------------------------------------- reads */

export interface ApiTokenRow {
  id: string;
  label: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

/**
 * List the caller's own API tokens. Never returns another person's tokens.
 */
export async function listApiTokens(ctx: Ctx): Promise<ApiTokenRow[]> {
  const rows = await ctx.db
    .select({
      id: s.apiTokens.id,
      label: s.apiTokens.label,
      prefix: s.apiTokens.prefix,
      scopes: s.apiTokens.scopes,
      lastUsedAt: s.apiTokens.lastUsedAt,
      expiresAt: s.apiTokens.expiresAt,
      revokedAt: s.apiTokens.revokedAt,
      createdAt: s.apiTokens.createdAt,
    })
    .from(s.apiTokens)
    .where(eq(s.apiTokens.userId, ctx.actor.userId))
    .orderBy(s.apiTokens.createdAt);

  return rows;
}

/* ---------------------------------------------------------------- revoke */

/**
 * Revoke a token. Must be the caller's own. Effective immediately.
 */
export async function revokeApiToken(
  ctx: Ctx,
  tokenId: string
): Promise<void> {
  const [row] = await ctx.db
    .select({
      id: s.apiTokens.id,
      userId: s.apiTokens.userId,
      label: s.apiTokens.label,
      prefix: s.apiTokens.prefix,
      revokedAt: s.apiTokens.revokedAt,
    })
    .from(s.apiTokens)
    .where(eq(s.apiTokens.id, tokenId))
    .limit(1);

  // 404, not 403, for a token that belongs to somebody else or does not exist.
  if (!row || row.userId !== ctx.actor.userId) {
    throw notFound("That API token");
  }

  if (row.revokedAt) {
    throw new AppError("conflict", "That token has already been revoked.");
  }

  await ctx.db
    .update(s.apiTokens)
    .set({ revokedAt: ctx.now() })
    .where(eq(s.apiTokens.id, tokenId));

  ctx.audit({
    action: "api_token.revoked",
    entityType: "api_token",
    entityId: row.id,
    entityLabel: row.label,
    after: { prefix: row.prefix },
  });
}

/* ------------------------------------------------------------ resolution */

export interface ResolvedApiToken {
  actor: Actor;
  prefix: string;
  scopes: string[];
  expiresAt: Date | null;
}

/**
 * Resolve a raw `tally_<prefix>_<secret>` token to an Actor.
 *
 * Called on every MCP request, before a Ctx exists, so it uses the raw db pool
 * directly (same pattern as `actorForToken` in session.ts).
 *
 * Returns `{ actor, prefix }` or null. The caller stores the prefix in
 * `requestInfo.userAgent` as `api-token/<prefix>` so it appears in audit rows
 * without requiring a schema change.
 *
 * Touches `lastUsedAt` at most once per minute per token.
 */
export async function resolveApiToken(
  rawToken: string
): Promise<ResolvedApiToken | null> {
  // The secret is base64url, which includes underscores, so a naive split
  // would break on any secret that contains one. Match the prefix only.
  if (!rawToken.startsWith("tally_") || rawToken.length < 16) return null;

  const tokenHash = digest(rawToken);
  const now = new Date();

  const rows = await db
    .select({
      tokenId: s.apiTokens.id,
      prefix: s.apiTokens.prefix,
      scopes: s.apiTokens.scopes,
      lastUsedAt: s.apiTokens.lastUsedAt,
      expiresAt: s.apiTokens.expiresAt,
      userId: s.users.id,
      timezone: s.users.timezone,
      isOwner: s.users.isOwner,
      archivedAt: s.users.archivedAt,
      profileId: s.permissionProfiles.id,
      baseKey: s.permissionProfiles.baseKey,
      capabilities: s.permissionProfiles.capabilities,
    })
    .from(s.apiTokens)
    .innerJoin(s.users, eq(s.users.id, s.apiTokens.userId))
    .innerJoin(
      s.permissionProfiles,
      eq(s.permissionProfiles.id, s.users.profileId)
    )
    .where(
      and(
        eq(s.apiTokens.tokenHash, tokenHash),
        isNull(s.apiTokens.revokedAt),
        gt(s.apiTokens.expiresAt, now)
      )
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  // An archived person's tokens are dead, same as their sessions.
  if (row.archivedAt) return null;

  // Touch lastUsedAt at most once per minute
  if (
    !row.lastUsedAt ||
    now.getTime() - row.lastUsedAt.getTime() > TOUCH_INTERVAL_MS
  ) {
    // Fire and forget: a failed touch must not block or fail the request.
    db.update(s.apiTokens)
      .set({ lastUsedAt: now })
      .where(eq(s.apiTokens.id, row.tokenId))
      .catch(() => {
        // Swallow. A missed touch is cosmetic, not a security problem.
      });
  }

  const ownerCaps = new Set(row.capabilities as Capability[]);
  const effectiveCaps = capabilitiesForScopes(ownerCaps, row.scopes);

  const actor: Actor = {
    userId: row.userId,
    profileId: row.profileId,
    baseKey: row.baseKey,
    capabilities: effectiveCaps,
    kind: "api",
    timezone: row.timezone,
    isOwner: row.isOwner,
    tokenPrefix: row.prefix,
    tokenScopes: row.scopes,
    tokenExpiresAt: row.expiresAt,
  };

  return { actor, prefix: row.prefix, scopes: row.scopes, expiresAt: row.expiresAt };
}
