/**
 * GET /api/v1/api-tokens      list the caller's API tokens
 * POST /api/v1/api-tokens     create a new API token (self-service only)
 */

import { z } from "zod";
import { body, route } from "@/server/http";
import { createApiToken, listApiTokens } from "@/server/services/api-keys";

export const GET = route(async (ctx) => {
  return listApiTokens(ctx);
}, { rateLimit: "read" });

const createSchema = z.object({
  label: z.string().min(1).max(100),
  scopes: z.array(z.string()).optional(),
  expiresInDays: z.number().int().min(1).max(365).optional(),
});

export const POST = route(async (ctx, req) => {
  const input = await body(req, createSchema);
  return createApiToken(ctx, input);
}, { rateLimit: "write" });
