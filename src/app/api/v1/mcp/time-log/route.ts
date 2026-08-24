import { z } from "zod";
import { body, route } from "@/server/http";
import { isoDate } from "@/server/schemas";
import { mcpTimeLog } from "@/server/services/mcp-actions";
const schema = z.object({ projectId: z.string().uuid(), taskId: z.string().uuid().optional(), spentOn: isoDate.optional(), durationSeconds: z.number().int().min(1).max(86400).optional(), startedAt: z.string().optional(), endedAt: z.string().optional(), notes: z.string().max(2000).optional(), isBillable: z.boolean().optional(), userId: z.string().uuid().optional(), confirmationToken: z.string().optional() }).refine((v) => v.durationSeconds !== undefined || (v.startedAt && v.endedAt), { message: "Provide durationSeconds or a start and end time." });
export const POST = route<unknown>(async (ctx, req) => mcpTimeLog(ctx, await body(req, schema)), { rateLimit: "write", capability: "time:create_own" });
