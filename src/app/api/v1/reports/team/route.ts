import { z } from "zod";
import { query, route } from "@/server/http";
import { isoDate } from "@/server/schemas";
import { teamReport } from "@/server/services/reports";

const schema = z.object({
  from: isoDate,
  to: isoDate,
  employment_type: z.enum(["employee", "contractor"]).optional(),
});

export const GET = route(
  async (ctx, req) => {
    const q = query(req, schema);
    const report = await teamReport(ctx, { from: q.from, to: q.to, employmentType: q.employment_type });
    return { data: report.rows, meta: { totals: report.totals } };
  },
  // No route-level capability: the service accepts either report:view_team or
  // the wider report:view_all, which a route option cannot express.
  { rateLimit: "report", transactional: false, cacheControl: "private, max-age=15" }
);
