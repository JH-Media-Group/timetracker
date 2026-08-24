import { route } from "@/server/http";
import { unauthenticated } from "@/server/errors";

export const GET = route(async (ctx) => {
  if (!ctx.actor.tokenPrefix) throw unauthenticated();
  const scopes = [...(ctx.actor.tokenScopes ?? [])];
  return {
    userId: ctx.actor.userId,
    scopes,
    readOnly: scopes.length === 1 && scopes[0] === "tally.read",
    expiresAt: ctx.actor.tokenExpiresAt?.toISOString() ?? null,
  };
}, { rateLimit: "auth" });
