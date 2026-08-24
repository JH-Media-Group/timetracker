import { z } from "zod";
import { body, route } from "@/server/http";
import { mcpAdminAction } from "@/server/services/mcp-actions";
const schema = z.object({ memberIds: z.array(z.string().uuid()).max(200), managerIds: z.array(z.string().uuid()).max(200), confirmationToken: z.string().optional() });
export const PATCH = route(async (ctx, req, params) => mcpAdminAction(ctx, "project", "members", params.id!, await body(req, schema)), { rateLimit: "write" });
