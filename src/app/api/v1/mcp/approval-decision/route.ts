import { z } from "zod";
import { body, route } from "@/server/http";
import { mcpApprovalDecision } from "@/server/services/mcp-actions";
const schema = z.object({ submission_id: z.string().uuid(), decision: z.enum(["approve", "request_changes"]), note: z.string().max(2000).optional(), confirmationToken: z.string().optional() });
export const POST = route<unknown>(async (ctx, req) => mcpApprovalDecision(ctx, await body(req, schema)), { rateLimit: "write", capability: "approval:review" });
