/**
 * POST /api/v1/users/:id/invite
 *
 * Send somebody a link to choose their password. With Google SSO dropped in
 * favour of password-only, this is how an account becomes usable at all.
 *
 * The `email` rate-limit class rather than `write`, because the cost of abusing
 * it is somebody else's inbox and this domain's sending reputation, not our CPU.
 */

import { route } from "@/server/http";
import { inviteUser } from "@/server/services/auth-tokens";

export const POST = route(
  async (ctx, _req, params) => inviteUser(ctx, params.id!),
  { capability: "people:manage", rateLimit: "email" }
);
