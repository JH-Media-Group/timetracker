import { z } from "zod";
import { body, route } from "@/server/http";
import { mcpAdminAction } from "@/server/services/mcp-actions";
import { validationFailed } from "@/server/errors";
const confirm = { confirmationToken: z.string().optional() };
const createSchemas: Record<string, z.ZodType> = {
  clients: z.object({ name: z.string().min(1), currency: z.string().optional(), ...confirm }).strict(),
  projects: z.object({ name: z.string().min(1), clientId: z.string().uuid(), billingType: z.enum(["time_and_materials", "fixed_fee", "non_billable"]), memberIds: z.array(z.string().uuid()).optional(), managerIds: z.array(z.string().uuid()).optional(), ...confirm }).strict(),
  tasks: z.object({ name: z.string().min(1), defaultBillable: z.boolean().optional(), ...confirm }).strict(),
  people: z.object({ firstName: z.string().min(1), lastName: z.string().min(1), email: z.string().email(), timezone: z.string().min(1), weeklyCapacitySeconds: z.number().int().min(0).max(604800), employmentType: z.enum(["employee", "contractor"]), profileId: z.string().uuid(), ...confirm }).strict(),
  "expense-categories": z.object({ name: z.string().min(1), unitName: z.string().optional(), unitPriceCents: z.number().int().min(0).optional(), ...confirm }).strict(),
};
const invoiceSchema = z.object({ section: z.enum(["company", "defaults", "appearance", "messages", "labels", "numbering"]), values: z.record(z.string(), z.unknown()), ...confirm }).strict();
const entities: Record<string, string> = { clients: "client", projects: "project", tasks: "task", people: "person", "expense-categories": "expense_category", "invoice-config": "invoice_config" };
export const POST = route(async (ctx, req, params) => { const entity = entities[params.entity!], schema = createSchemas[params.entity!]; if (!entity || !schema) throw validationFailed({ entity: ["Unsupported administrative entity."] }); return mcpAdminAction(ctx, entity, "create", undefined, await body(req, schema) as Record<string, unknown>); }, { rateLimit: "write" });
export const PATCH = route(async (ctx, req, params) => { const entity = entities[params.entity!]; if (entity !== "invoice_config") throw validationFailed({ entity: ["Unsupported administrative entity."] }); return mcpAdminAction(ctx, entity, "update", undefined, await body(req, invoiceSchema) as Record<string, unknown>); }, { rateLimit: "write" });
