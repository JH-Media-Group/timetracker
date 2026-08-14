import { z } from "zod";
import { query, route } from "@/server/http";
import { search } from "@/server/services/search";

const schema = z.object({ q: z.string().default("") });

export const GET = route(async (ctx, req) => {
  const { q } = query(req, schema);
  const result = await search(ctx, q);
  return { data: result.hits, meta: { totals: result.totals } };
}, { rateLimit: "read" });
