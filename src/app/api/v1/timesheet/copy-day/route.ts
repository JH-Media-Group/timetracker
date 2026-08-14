import { z } from "zod";
import { body, route } from "@/server/http";
import { isoDate } from "@/server/schemas";
import { copyDay } from "@/server/services/time";

const schema = z.object({
  from: isoDate,
  to: isoDate,
  includeDurations: z.boolean().default(false),
  userId: z.string().uuid().optional(),
});

export const POST = route(async (ctx, req) => copyDay(ctx, await body(req, schema)), { rateLimit: "write", capability: "time:create_own" });
