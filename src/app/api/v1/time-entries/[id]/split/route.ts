import { z } from "zod";
import { body, route } from "@/server/http";
import { splitTimeEntry } from "@/server/services/time";

const schema = z.object({ atSeconds: z.number().int().positive() });

export const POST = route(async (ctx, req, params) => {
  const { atSeconds } = await body(req, schema);
  return splitTimeEntry(ctx, params.id!, atSeconds);
}, { rateLimit: "write" });
