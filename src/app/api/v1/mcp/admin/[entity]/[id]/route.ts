import { z } from "zod";
import { body, route } from "@/server/http";
import { mcpAdminAction } from "@/server/services/mcp-actions";
import { validationFailed } from "@/server/errors";
const schema = z.object({ confirmationToken: z.string().optional() }).loose();
const entities: Record<string, string> = { clients: "client", projects: "project", tasks: "task", people: "person" };
export const PATCH = route(async (ctx, req, params) => { const entity = entities[params.entity!]; if (!entity) throw validationFailed({ entity: ["Unsupported administrative entity."] }); return mcpAdminAction(ctx, entity, "update", params.id!, await body(req, schema)); }, { rateLimit: "write" });
