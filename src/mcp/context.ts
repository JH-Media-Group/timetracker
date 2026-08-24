import { AsyncLocalStorage } from "node:async_hooks";
import type { TallyApi } from "./api-client.js";

export interface TokenInfo { userId: string; scopes: string[]; readOnly: boolean; expiresAt: string | null; }
export interface McpRequestContext { api: TallyApi; token: TokenInfo; }
export const requestStore = new AsyncLocalStorage<McpRequestContext>();
export function requestContext(): McpRequestContext {
  const value = requestStore.getStore();
  if (!value) throw new Error("MCP tool called outside a request context");
  return value;
}
