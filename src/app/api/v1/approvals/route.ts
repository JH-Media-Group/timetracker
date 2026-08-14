import { z } from "zod";
import { query, route } from "@/server/http";
import { isoDate } from "@/server/schemas";
import { listSubmissions } from "@/server/services/approvals";

const schema = z.object({
  state: z.enum(["submitted", "approved", "changes_requested", "all"]).optional(),
  period_start: isoDate.optional(),
});

export const GET = route(
  async (ctx, req) => {
    const { state, period_start } = query(req, schema);
    return listSubmissions(ctx, { state, periodStart: period_start });
  },
  { rateLimit: "read" }
);
