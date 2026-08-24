import { route } from "@/server/http";
import { mcpTimerStop } from "@/server/services/mcp-actions";
export const POST = route(async (ctx) => mcpTimerStop(ctx), { rateLimit: "write", capability: "time:edit_own" });
