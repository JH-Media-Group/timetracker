import { z } from "zod";
import { query, route } from "@/server/http";
import { isoDate } from "@/server/schemas";
import { timesheetSummary } from "@/server/services/time";

const schema = z.object({
  from: isoDate,
  to: isoDate,
  user_id: z.string().uuid().optional(),
});

export const GET = route(async (ctx, req) => {
  const { from, to, user_id } = query(req, schema);
  return timesheetSummary(ctx, { from, to, userId: user_id });
});
