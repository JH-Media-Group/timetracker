import { body, route } from "@/server/http";
import { recurringStateSchema } from "@/server/schemas";
import { setRecurringState } from "@/server/services/recurring";

/**
 * Pause and resume, as one endpoint taking the state it should end in rather
 * than two verbs. Resuming picks the cadence back up; it does not backfill the
 * periods that were missed. See the service.
 */
export const POST = route(
  async (ctx, req, params) => {
    const { state } = await body(req, recurringStateSchema);
    return setRecurringState(ctx, params.id!, state);
  },
  { rateLimit: "write", capability: "invoice:manage" }
);
