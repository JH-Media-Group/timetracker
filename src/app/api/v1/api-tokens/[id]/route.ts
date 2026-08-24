/**
 * DELETE /api/v1/api-tokens/:id     revoke an API token
 */

import { route } from "@/server/http";
import { revokeApiToken } from "@/server/services/api-keys";

export const DELETE = route(async (ctx, _req, params) => {
  await revokeApiToken(ctx, params.id);
  return { revoked: true };
}, { rateLimit: "write" });
