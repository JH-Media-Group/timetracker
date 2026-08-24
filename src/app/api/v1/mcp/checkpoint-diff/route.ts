import { z } from "zod";
import { query, route } from "@/server/http";
import { mcpCheckpointDiff } from "@/server/services/mcp-actions";
const schema = z.object({ since: z.string().datetime(), limit: z.coerce.number().int().min(1).max(200).default(50) });
export const GET = route(async (ctx, req) => { const q = query(req, schema); return mcpCheckpointDiff(ctx, q.since, q.limit); }, { rateLimit: "read", capability: "audit:view" });
