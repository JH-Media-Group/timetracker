import { z } from "zod";
import { query, route } from "@/server/http";
import { isoDate } from "@/server/schemas";
import { timeReport } from "@/server/services/reports";

const schema = z.object({
  from: isoDate,
  to: isoDate,
  group_by: z.enum(["client", "project", "task", "user", "day"]).default("client"),
  user_id: z.string().uuid().optional(),
  project_id: z.string().uuid().optional(),
  client_id: z.string().uuid().optional(),
});

/**
 * Group rows and totals are computed server-side, because the client grid has
 * no aggregation and a client-side total could not honour permission scoping
 * or the account rounding rules. `meta.totals` covers the whole set.
 */
export const GET = route(
  async (ctx, req) => {
    const q = query(req, schema);
    const report = await timeReport(ctx, {
      from: q.from,
      to: q.to,
      groupBy: q.group_by,
      userId: q.user_id,
      projectId: q.project_id,
      clientId: q.client_id,
    });
    if (ctx.actor.kind === "api" && !ctx.actor.capabilities.has("rates:view_billable")) {
      return {
        data: report.rows.map(({ billableCents: _money, ...row }) => row),
        meta: { totals: Object.fromEntries(Object.entries(report.totals).filter(([key]) => key !== "billableCents")), series: report.series, rounding: report.rounding },
      };
    }
    return { data: report.rows, meta: { totals: report.totals, series: report.series, rounding: report.rounding } };
  },
  { rateLimit: "report", transactional: false, cacheControl: "private, max-age=15" }
);
