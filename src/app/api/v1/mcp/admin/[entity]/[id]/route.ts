import { z } from "zod";
import { body, route } from "@/server/http";
import { mcpAdminAction } from "@/server/services/mcp-actions";
import { validationFailed } from "@/server/errors";
const confirm = { confirmationToken: z.string().optional() };
const schemas: Record<string, z.ZodType> = {
  clients: z.object({ name: z.string().min(1).optional(), currency: z.string().optional(), archived: z.boolean().optional(), ...confirm }).strict(),
  projects: z.object({ name: z.string().min(1).optional(), billingType: z.enum(["time_and_materials", "fixed_fee", "non_billable"]).optional(), archived: z.boolean().optional(), ...confirm }).strict(),
  tasks: z.object({ name: z.string().min(1).optional(), defaultBillable: z.boolean().optional(), archived: z.boolean().optional(), ...confirm }).strict(),
  people: z.object({ firstName: z.string().min(1).optional(), lastName: z.string().min(1).optional(), timezone: z.string().min(1).optional(), profileId: z.string().uuid().optional(), archived: z.boolean().optional(), ...confirm }).strict(),
};
const entities: Record<string, string> = { clients: "client", projects: "project", tasks: "task", people: "person" };
export const PATCH = route(async (ctx, req, params) => { const entity = entities[params.entity!], schema = schemas[params.entity!]; if (!entity || !schema) throw validationFailed({ entity: ["Unsupported administrative entity."] }); return mcpAdminAction(ctx, entity, "update", params.id!, await body(req, schema) as Record<string, unknown>); }, { rateLimit: "write" });
