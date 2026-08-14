import { z } from "zod";
import { query, route } from "@/server/http";
import { isoDate } from "@/server/schemas";
import { profitabilityReport } from "@/server/services/reports";

const schema = z.object({
  from: isoDate,
  to: isoDate,
  group_by: z.enum(["project", "client"]).default("project"),
});

export const GET = route(
  async (ctx, req) => {
    const q = query(req, schema);
    const report = await profitabilityReport(ctx, { from: q.from, to: q.to, groupBy: q.group_by });
    return {
      data: report.rows,
      meta: { totals: report.totals, flags: report.flags, invoicedCents: report.invoicedCents },
    };
  },
  { rateLimit: "report", capability: "report:view_financial", transactional: false, cacheControl: "private, max-age=15" }
);
