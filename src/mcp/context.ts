/**
 * Per-request auth context for the MCP server.
 *
 * Each HTTP request resolves a Bearer token to an actor and stores it in
 * AsyncLocalStorage so that tool handlers can retrieve it without threading
 * the auth through the MCP protocol layer.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { Actor } from "@/server/ctx";
import { createCtx, type Ctx } from "@/server/ctx";
import { newId } from "@/server/db/ids";

export interface McpAuth {
  actor: Actor;
  prefix: string;
}

export const authStore = new AsyncLocalStorage<McpAuth>();

/**
 * Retrieve the auth context for the current request, or throw.
 *
 * Every tool handler calls this. A missing store means the tool was called
 * outside the auth middleware, which is a bug in the server setup.
 */
export function requireAuth(): McpAuth {
  const auth = authStore.getStore();
  if (!auth) throw new Error("MCP tool called outside auth context");
  return auth;
}

/**
 * Build a Ctx for a tool call from the stored auth context.
 *
 * Each tool call gets its own requestId and Ctx. The token prefix goes into
 * the userAgent slot so the audit row records which token made the change.
 */
export function toolCtx(): Ctx {
  const { actor, prefix } = requireAuth();
  return createCtx({
    actor,
    request: {
      requestId: newId(),
      userAgent: `api-token/${prefix}`,
    },
  });
}
