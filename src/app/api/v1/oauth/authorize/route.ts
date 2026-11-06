import { z } from "zod";
import { body, route } from "@/server/http";
import { approveOAuth } from "@/server/services/oauth";
const schema = z.object({ clientId: z.string(), redirectUri: z.string().url(), scope: z.string().default("tally.read"), responseType: z.literal("code"), codeChallengeMethod: z.literal("S256"), resource: z.string().url().optional(), expectedUserId: z.string().uuid(), codeChallenge: z.string(), state: z.string().optional(), approved: z.boolean(), selectedScopes: z.array(z.string()).max(6) });
export const POST = route(async (ctx, req) => approveOAuth(ctx, await body(req, schema)));
