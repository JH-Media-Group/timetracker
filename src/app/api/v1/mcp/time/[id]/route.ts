import { z } from "zod";
import { body, route } from "@/server/http";
import { isoDate } from "@/server/schemas";
import { mcpTimeEdit } from "@/server/services/mcp-actions";
const schema = z.object({ projectId: z.string().uuid().optional(), taskId: z.string().uuid().optional(), spentOn: isoDate.optional(), durationSeconds: z.number().int().min(0).max(86400).optional(), startedAt: z.string().optional(), endedAt: z.string().optional(), notes: z.string().max(2000).nullable().optional(), isBillable: z.boolean().optional(), confirmationToken: z.string().optional() });
export const PATCH = route<unknown>(async (ctx, req, params) => mcpTimeEdit(ctx, params.id!, await body(req, schema)), { rateLimit: "write" });
