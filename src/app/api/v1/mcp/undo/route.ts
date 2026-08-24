import { z } from "zod";
import { body, route } from "@/server/http";
import { mcpUndo } from "@/server/services/mcp-actions";
export const POST = route<unknown>(async (ctx, req) => { const { undoToken } = await body(req, z.object({ undoToken: z.string() })); return mcpUndo(ctx, undoToken); }, { rateLimit: "write" });
