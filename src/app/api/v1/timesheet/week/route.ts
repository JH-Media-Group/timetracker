import { z } from "zod";
import { body, route } from "@/server/http";
import { isoDate } from "@/server/schemas";
import { upsertWeek } from "@/server/services/time";

const schema = z.object({
  userId: z.string().uuid().optional(),
  weekStart: isoDate,
  rows: z
    .array(
      z.object({
        projectId: z.string().uuid(),
        taskId: z.string().uuid(),
        notes: z.string().max(2000).nullable().optional(),
        days: z.record(isoDate, z.number().int().min(0).max(24 * 3600)),
      })
    )
    .max(200),
});

/**
 * The week grid in one round trip.
 *
 * Returns the whole resulting week so the client reconciles in one shot, plus
 * a `skipped` list for rows a lock refused: one approved day should not stop
 * somebody filling in the rest of the week.
 */
export const PUT = route(async (ctx, req) => {
  const result = await upsertWeek(ctx, await body(req, schema));
  return { data: result.entries, meta: { skipped: result.skipped } };
}, { rateLimit: "write", capability: "time:create_own" });
