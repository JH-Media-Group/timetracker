import { z } from "zod";
import { body, route } from "@/server/http";
import { stopTimer } from "@/server/services/time";

/**
 * POST /api/v1/time-entries/:id/stop
 *
 * Stops a running timer. The body names whose; omitted, it is your own.
 *
 * THE ID IN THE PATH IS NOT READ, AND THAT IS OLDER THAN IT LOOKS
 *
 * `src/lib/api.ts` posts to `/time-entries/current/stop`. There is no `current`
 * directory, so Next matches this dynamic segment with `id = "current"`, and
 * the handler has never looked at it: stopping is "the timer this person has
 * running", and a person has at most one, so there is nothing to identify.
 *
 * What the handler also never looked at was the body. `stopTimer` has always
 * taken an optional user id, and the client has always sent one, and this route
 * threw it away and stopped the actor's own timer instead. So the fix for
 * t-DVQ2qW, which made the timesheet pass the row owner's id, reached the
 * client and stopped here. The service tests passed throughout because they
 * call `stopTimer` directly; nothing exercised the seam.
 *
 * Found by `tests/route-reachability.test.ts` on its first run, which is the
 * argument for that test existing.
 */
const schema = z.object({ userId: z.string().uuid().nullable().optional() });

export const POST = route(
  async (ctx, req) => {
    const { userId } = await body(req, schema).catch(() => ({ userId: null }));
    return stopTimer(ctx, userId ?? undefined);
  },
  { rateLimit: "write" }
);
