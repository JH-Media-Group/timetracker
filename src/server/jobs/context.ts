/**
 * The context a scheduled job runs in.
 *
 * A job has no session and no request, but every service still wants a `Ctx`:
 * that is the point of the seam, and a job that bypassed it would also bypass
 * the audit rows and the outbox events, which is exactly the sort of quiet
 * exception that makes an audit trail worthless.
 *
 * WHO A JOB IS
 *
 * Two things pull in opposite directions. `invoices.createInvoice` writes
 * `createdBy`, which is a real foreign key into `users`, so the actor cannot be
 * invented. The audit trail, meanwhile, should not claim a person pressed a
 * button at 06:00 when nobody did.
 *
 * So a job runs as the **owner** with `kind: "system"`, and gets both:
 *
 *   - `createdBy` is the owner, so "who does this invoice belong to" has an
 *     answer and the foreign key holds.
 *   - `ctx.flush` writes `actor_id = NULL, actor_kind = 'system'`, because that
 *     branch already exists in `ctx.ts`. The audit row says a machine did it.
 *
 * Capabilities are the full set. A job is not a lesser user to be sandboxed; it
 * is the account acting on itself, and narrowing the set here would only mean
 * discovering at 06:00 which capability was missed.
 */

import { eq } from "drizzle-orm";
import { createCtx, type Actor, type Ctx } from "@/server/ctx";
import { CAPABILITIES } from "@/server/auth/capabilities";
import { db } from "@/server/db/client";
import * as s from "@/server/db/schema";

/**
 * Build a job context.
 *
 * Throws when there is no owner, which is a database that has not been seeded
 * rather than a condition worth handling: a job with nobody to act as should
 * stop loudly, not raise invoices attributed to nobody.
 */
export async function systemCtx(): Promise<Ctx> {
  const [owner] = await db
    .select({ id: s.users.id, profileId: s.users.profileId, timezone: s.users.timezone })
    .from(s.users)
    .where(eq(s.users.isOwner, true))
    .limit(1);

  if (!owner) {
    throw new Error(
      "No owner account, so a scheduled job has nobody to act as. Seed the database first."
    );
  }

  const actor: Actor = {
    userId: owner.id,
    profileId: owner.profileId,
    baseKey: null,
    capabilities: new Set(CAPABILITIES),
    kind: "system",
    timezone: owner.timezone ?? "America/New_York",
    isOwner: true,
  };

  return createCtx({ actor, request: { requestId: "job", ip: null, userAgent: "tally-job" } });
}
