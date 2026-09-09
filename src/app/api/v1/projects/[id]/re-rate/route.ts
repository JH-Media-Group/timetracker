import { z } from "zod";
import { body, route } from "@/server/http";
import { isoDate } from "@/server/schemas";
import { reRateProject } from "@/server/services/rates";

/**
 * POST /api/v1/projects/:id/re-rate
 *
 * Re-resolves the rate snapshots on a project's unbilled hours. This is the
 * "explicit re-rate action" the schema comment and the PRD have both referred
 * to since the beginning, and which nothing implemented.
 *
 * `dryRun` answers what it would do without writing, so the screen can show the
 * money before anybody commits to it.
 *
 * No `requireIdempotencyKey`. Its neighbours create records, so a retry makes a
 * second one; this recomputes a value from inputs that have not moved, so
 * running it twice resolves the same rates and the second pass reports every
 * entry unchanged. It is idempotent by construction rather than by ledger, the
 * same argument as `/invoices/billed-externally`.
 */
const schema = z
  .object({
    from: isoDate.optional(),
    to: isoDate.optional(),
    dryRun: z.boolean().default(false),
  })
  .strict();

export const POST = route(
  async (ctx, req, params) => reRateProject(ctx, { projectId: params.id!, ...(await body(req, schema)) }),
  { rateLimit: "write", capability: "rates:manage" }
);
