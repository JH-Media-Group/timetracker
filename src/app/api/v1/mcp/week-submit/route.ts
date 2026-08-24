import { z } from "zod";
import { body, route } from "@/server/http";
import { isoDate } from "@/server/schemas";
import { mcpWeekSubmit } from "@/server/services/mcp-actions";
const schema = z.object({ periodStart: isoDate, userId: z.string().uuid().optional(), confirmationToken: z.string().optional() });
export const POST = route<unknown>(async (ctx, req) => mcpWeekSubmit(ctx, await body(req, schema)), { rateLimit: "write", capability: "approval:submit" });
