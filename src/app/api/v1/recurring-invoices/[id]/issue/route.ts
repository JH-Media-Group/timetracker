import { route } from "@/server/http";
import { issueRecurringNow } from "@/server/services/recurring";

/**
 * Raise this schedule's next invoice now, and move the schedule on one period.
 *
 * Exists so the raising logic is usable and testable before the daily job in
 * TALLY-26 does it unattended. Requires an Idempotency-Key because a retry that
 * bills a client twice is the worst outcome this area has.
 */
export const POST = route(
  async (ctx, _req, params) => issueRecurringNow(ctx, params.id!),
  { rateLimit: "write", capability: "invoice:manage", requireIdempotencyKey: true }
);
