import { z } from "zod";
import { query, route } from "@/server/http";
import { isoDate } from "@/server/schemas";
import { invoicingReport } from "@/server/services/reports";

const schema = z.object({ from: isoDate, to: isoDate });

export const GET = route(
  async (ctx, req) => {
    const q = query(req, schema);
    const report = await invoicingReport(ctx, { from: q.from, to: q.to });
    return {
      data: report.rows,
      meta: {
        totals: report.totals,
        aging: report.aging,
        monthly: report.monthly,
        averageDaysToPay: report.averageDaysToPay,
      },
    };
  },
  { rateLimit: "report", capability: "report:view_financial", transactional: false, cacheControl: "private, max-age=15" }
);
