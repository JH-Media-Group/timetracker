/**
 * GET /api/v1/me/capabilities
 *
 * The client's capability-driven UI reads this once at boot. Returning the set
 * rather than the profile name is deliberate: the UI asks the same question the
 * server does, so a button cannot appear for an action the API will refuse.
 */

import { route } from "@/server/http";
import { othersScopeFor } from "@/server/auth/capabilities";

export const GET = route(async (ctx) => ({
  capabilities: [...ctx.actor.capabilities].sort(),
  profileId: ctx.actor.profileId,
  baseKey: ctx.actor.baseKey,
  othersScope: othersScopeFor(ctx.actor.baseKey),
  isOwner: ctx.actor.isOwner,
}));
