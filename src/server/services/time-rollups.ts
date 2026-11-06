import { and, eq, isNull, sql } from "drizzle-orm";
import type { Ctx } from "@/server/ctx";
import * as s from "@/server/db/schema";
import { timeEntryScope } from "@/server/auth/scope";
import { canSeeBillable, canSeeCost } from "@/server/serialize";
import type { TimeRollup, TimeRollupGroup } from "@/lib/time-rollups";

/** The same row scope and rate visibility as listTimeEntries, without its cap. */
export async function timeRollups(ctx: Ctx, group: TimeRollupGroup): Promise<TimeRollup[]> {
  const id = { project: s.timeEntries.projectId, client: s.projects.clientId, task: s.projectTasks.taskId }[group];
  const rateVisible = canSeeBillable(ctx) ? sql`true` : eq(s.timeEntries.userId, ctx.actor.userId);
  const product = sql`CASE WHEN ${rateVisible} THEN ${s.timeEntries.durationSeconds}::numeric * ${s.timeEntries.billableRateCents} ELSE 0 END`;
  const costAllowed = canSeeCost(ctx);
  return ctx.db.select({
    id,
    seconds: sql<number>`COALESCE(SUM(${s.timeEntries.durationSeconds}), 0)`.mapWith(Number),
    billableCents: sql<number>`ROUND(COALESCE(SUM(${product}), 0) / 3600)`.mapWith(Number),
    uninvoicedCents: sql<number>`ROUND(COALESCE(SUM(CASE WHEN ${s.timeEntries.isBillable} AND ${s.timeEntries.invoiceId} IS NULL AND NOT ${s.timeEntries.billedExternally} THEN ${product} ELSE 0 END), 0) / 3600)`.mapWith(Number),
    ...(costAllowed ? { costCents: sql<number>`ROUND(COALESCE(SUM(${s.timeEntries.durationSeconds}::numeric * ${s.timeEntries.costRateCents}), 0) / 3600)`.mapWith(Number) } : {}),
  }).from(s.timeEntries)
    .innerJoin(s.projectTasks, eq(s.projectTasks.id, s.timeEntries.projectTaskId))
    .innerJoin(s.projects, eq(s.projects.id, s.timeEntries.projectId))
    .where(and(isNull(s.timeEntries.deletedAt), timeEntryScope(ctx)))
    .groupBy(id)
    .orderBy(id);
}
