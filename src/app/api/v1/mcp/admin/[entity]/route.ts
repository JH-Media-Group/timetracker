import { z } from "zod";
import { body, route } from "@/server/http";
import { mcpAdminAction } from "@/server/services/mcp-actions";
import { validationFailed } from "@/server/errors";
const schema = z.object({ confirmationToken: z.string().optional() }).loose();
const entities: Record<string, string> = { clients: "client", projects: "project", tasks: "task", people: "person", "expense-categories": "expense_category", "invoice-config": "invoice_config" };
export const POST = route(async (ctx, req, params) => { const entity = entities[params.entity!]; if (!entity || entity === "invoice_config") throw validationFailed({ entity: ["Unsupported administrative entity."] }); return mcpAdminAction(ctx, entity, "create", undefined, await body(req, schema)); }, { rateLimit: "write" });
export const PATCH = route(async (ctx, req, params) => { const entity = entities[params.entity!]; if (entity !== "invoice_config") throw validationFailed({ entity: ["Unsupported administrative entity."] }); return mcpAdminAction(ctx, entity, "update", undefined, await body(req, schema)); }, { rateLimit: "write" });
