/**
 * Rates.
 *
 * Dated ranges, with the overlap rule enforced by the database. This module
 * reads them, resolves them onto a time entry, and manages the CRUD.
 *
 * Specification: docs/BACKEND_PRD.md section 4.5.
 */

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { assertCan, type Ctx } from "@/server/ctx";
import * as s from "@/server/db/schema";
import { newId } from "@/server/db/ids";
import { notFound, validationFailed } from "@/server/errors";
import { resolveRates, type DatedRate, type ResolvedRates } from "@/domain/rates";
import type { IsoDate } from "@/domain/calendar";

/** Every dated rate for a person, newest first. */
export async function ratesFor(ctx: Ctx, userId: string): Promise<DatedRate[]> {
  const rows = await ctx.db
    .select({
      kind: s.userRates.kind,
      amountCents: s.userRates.amountCents,
      startsOn: s.userRates.startsOn,
      endsOn: s.userRates.endsOn,
    })
    .from(s.userRates)
    .where(eq(s.userRates.userId, userId))
    .orderBy(desc(s.userRates.startsOn));

  return rows as DatedRate[];
}

/** The rate in force today, for display. Null when there is none. */
export async function rateFor(
  ctx: Ctx,
  userId: string,
  kind: "billable" | "cost",
  on?: IsoDate
): Promise<number | null> {
  // `ctx.now()`, not `new Date()`. The context carries an injectable clock for
  // exactly this: reading the wall clock here makes the rate shown on a person's
  // page depend on what time the test suite runs, which is the same defect that
  // made `tests/time.test.ts` pass every morning and fail every afternoon. It
  // is latent rather than live only because the seeded rates have open-ended
  // ranges that match any day.
  const day = on ?? (ctx.now().toISOString().slice(0, 10) as IsoDate);
  const [row] = await ctx.db
    .select({ amountCents: s.userRates.amountCents })
    .from(s.userRates)
    .where(
      and(
        eq(s.userRates.userId, userId),
        eq(s.userRates.kind, kind),
        sql`(${s.userRates.startsOn} IS NULL OR ${s.userRates.startsOn} <= ${day})`,
        sql`(${s.userRates.endsOn} IS NULL OR ${s.userRates.endsOn} >= ${day})`
      )
    )
    .limit(1);
  return row?.amountCents ?? null;
}

/** Bulk lookup for reports: the rate in force on a day, for many people at once. */
export async function ratesForMany(
  ctx: Ctx,
  userIds: readonly string[],
  kind: "billable" | "cost",
  on: IsoDate
): Promise<Map<string, number>> {
  if (userIds.length === 0) return new Map();
  const rows = await ctx.db
    .select({ userId: s.userRates.userId, amountCents: s.userRates.amountCents })
    .from(s.userRates)
    .where(
      and(
        // Parameterised. The array-literal-by-concatenation version worked only
        // for as long as every caller happened to pass uuids from the database
        // rather than from a query string.
        inArray(s.userRates.userId, [...userIds]),
        eq(s.userRates.kind, kind),
        sql`(${s.userRates.startsOn} IS NULL OR ${s.userRates.startsOn} <= ${on})`,
        sql`(${s.userRates.endsOn} IS NULL OR ${s.userRates.endsOn} >= ${on})`
      )
    );
  return new Map(rows.map((r) => [r.userId, r.amountCents]));
}

/* ------------------------------------------------------------- resolution */

export interface ResolveContext {
  userId: string;
  projectId: string;
  projectTaskId: string;
  spentOn: IsoDate;
  overrideBillableCents?: number | null;
}

/**
 * Resolves the rate snapshot for an entry.
 *
 * One query assembles everything the ladder needs: the project's billing
 * configuration, the project task, the underlying task's default, the member
 * override, and the person's dated rates. Doing it in five queries would be
 * five round trips on the hot write path.
 */
export async function resolveForEntry(ctx: Ctx, input: ResolveContext): Promise<ResolvedRates> {
  const [config] = await ctx.db
    .select({
      billingType: s.projects.billingType,
      billBy: s.projects.billBy,
      projectRateCents: s.projects.hourlyRateCents,
      taskIsBillable: s.projectTasks.isBillable,
      projectTaskRateCents: s.projectTasks.hourlyRateCents,
      taskDefaultRateCents: s.tasks.defaultHourlyRateCents,
      memberRateCents: s.projectMembers.hourlyRateCents,
    })
    .from(s.projectTasks)
    .innerJoin(s.projects, eq(s.projects.id, s.projectTasks.projectId))
    .innerJoin(s.tasks, eq(s.tasks.id, s.projectTasks.taskId))
    .leftJoin(
      s.projectMembers,
      and(eq(s.projectMembers.projectId, s.projects.id), eq(s.projectMembers.userId, input.userId))
    )
    .where(and(eq(s.projectTasks.id, input.projectTaskId), eq(s.projectTasks.projectId, input.projectId)))
    .limit(1);

  if (!config) throw notFound("That task on that project");

  const userRates = await ratesFor(ctx, input.userId);

  return resolveRates({
    project: {
      billingType: config.billingType as "time_and_materials" | "fixed_fee" | "non_billable",
      billBy: config.billBy as "project" | "tasks" | "people" | "none",
      hourlyRateCents: config.projectRateCents,
    },
    projectTask: { isBillable: config.taskIsBillable, hourlyRateCents: config.projectTaskRateCents },
    task: { defaultHourlyRateCents: config.taskDefaultRateCents },
    member: config.memberRateCents != null ? { hourlyRateCents: config.memberRateCents } : null,
    userRates,
    spentOn: input.spentOn,
    overrideBillableCents: input.overrideBillableCents,
  });
}

/* -------------------------------------------------------------------- CRUD */

export interface RateInput {
  kind: "billable" | "cost";
  amountCents: number;
  startsOn: IsoDate | null;
  endsOn: IsoDate | null;
}

export async function listRates(ctx: Ctx, userId: string) {
  // Cost rates are money about a person. Seeing your own is fine; seeing
  // everybody's needs the capability.
  if (userId !== ctx.actor.userId) assertCan(ctx, "rates:view_billable");

  const rows = await ctx.db
    .select()
    .from(s.userRates)
    .where(eq(s.userRates.userId, userId))
    .orderBy(desc(s.userRates.startsOn));

  const canSeeCost = ctx.actor.capabilities.has("rates:view_cost") || ctx.actor.kind === "system";
  return rows
    .filter((r) => canSeeCost || r.kind !== "cost")
    .map((r) => ({
      id: r.id,
      kind: r.kind,
      amountCents: r.amountCents,
      currency: r.currency,
      startsOn: r.startsOn,
      endsOn: r.endsOn,
    }));
}

export async function createRate(ctx: Ctx, userId: string, input: RateInput) {
  assertCan(ctx, "rates:manage");

  if (input.amountCents < 0) {
    throw validationFailed({ amountCents: ["A rate cannot be negative."] });
  }
  if (input.startsOn && input.endsOn && input.startsOn > input.endsOn) {
    throw validationFailed({ endsOn: ["The end date is before the start date."] });
  }

  const id = newId();
  await ctx.db.insert(s.userRates).values({
    id,
    userId,
    kind: input.kind,
    amountCents: input.amountCents,
    startsOn: input.startsOn,
    endsOn: input.endsOn,
    createdBy: ctx.actor.userId,
  });

  ctx.audit({
    action: "rate.create",
    entityType: "user_rate",
    entityId: id,
    after: input,
  });

  return { id, ...input };
}

/**
 * Deletes a rate belonging to a specific person.
 *
 * The user id is part of the lookup, not decoration: matching on the rate id
 * alone let `DELETE /users/{alice}/rates/{bob-rate}` delete Bob's rate and file
 * the audit row under a path naming Alice.
 */
export async function deleteRate(ctx: Ctx, userId: string, rateId: string) {
  assertCan(ctx, "rates:manage");

  const [existing] = await ctx.db
    .select()
    .from(s.userRates)
    .where(and(eq(s.userRates.id, rateId), eq(s.userRates.userId, userId)))
    .limit(1);
  if (!existing) throw notFound("That rate");

  await ctx.db.delete(s.userRates).where(eq(s.userRates.id, rateId));

  ctx.audit({
    action: "rate.delete",
    entityType: "user_rate",
    entityId: rateId,
    before: existing,
  });
}
