import { route } from "@/server/http";
import { unauthenticated } from "@/server/errors";
import { isReadOnlyToken } from "@/lib/api-token-scopes";

export const GET = route(async (ctx) => {
  if (!ctx.actor.tokenPrefix) throw unauthenticated();
  const scopes = [...(ctx.actor.tokenScopes ?? [])];
  return {
    userId: ctx.actor.userId,
    scopes,
    readOnly: isReadOnlyToken(scopes),
    expiresAt: ctx.actor.tokenExpiresAt?.toISOString() ?? null,
  };
}, { rateLimit: "token" });
