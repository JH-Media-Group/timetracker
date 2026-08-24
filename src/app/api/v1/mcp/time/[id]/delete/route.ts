import { z } from "zod";
import { body, route } from "@/server/http";
import { mcpTimeDelete } from "@/server/services/mcp-actions";

const schema = z.object({ confirmationToken: z.string().optional() });

export const POST = route<unknown>(async (ctx, req, params) =>
  mcpTimeDelete(ctx, params.id!, await body(req, schema)), { rateLimit: "write" });
