import { z } from "zod";
import { query, route } from "@/server/http";
import { runningEntry } from "@/server/services/time";

const schema = z.object({ user_id: z.string().uuid().optional() });

/**
 * The running entry, or null.
 *
 * Never a running total: the response carries `durationSeconds` and
 * `timerStartedAt` and the client computes elapsed time from them, so a
 * sleeping laptop, a stale tab, and a clock-skewed device are all correct.
 */
export const GET = route(async (ctx, req) => {
  const { user_id } = query(req, schema);
  return runningEntry(ctx, user_id);
}, { rateLimit: "read" });
