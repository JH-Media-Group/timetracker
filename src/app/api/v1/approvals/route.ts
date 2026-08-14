import { z } from "zod";
import { query, route } from "@/server/http";
import { isoDate } from "@/server/schemas";
import { listSubmissions } from "@/server/services/approvals";

const schema = z.object({
  state: z.enum(["submitted", "approved", "changes_requested", "all"]).optional(),
  period_start: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(2000).default(500),
});

export const GET = route(
  async (ctx, req) => {
    const { state, period_start, limit } = query(req, schema);
    const rows = await listSubmissions(ctx, { state, periodStart: period_start, limit: limit + 1 });
    const hasMore = rows.length > limit;
    return { data: hasMore ? rows.slice(0, limit) : rows, meta: { hasMore, perPage: limit } };
  },
  { rateLimit: "read" }
);
