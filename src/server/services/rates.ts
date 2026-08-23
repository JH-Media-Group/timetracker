/**
 * Rates.
 *
 * Dated ranges, with the overlap rule enforced by the database. This module
 * reads them, resolves them onto a time entry, and manages the CRUD.
 *
 * Specification: docs/BACKEND_PRD.md section 4.5.
 */

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { assertCan, withTransaction, type Ctx } from "@/server/ctx";
import { visibleUserIds } from "@/server/auth/scope";
import * as s from "@/server/db/schema";
import { newId } from "@/server/db/ids";
import { notFound, validationFailed } from "@/server/errors";
import { resolveRates, type DatedRate, type ResolvedRates } from "@/domain/rates";
import { addDays } from "@/domain/calendar";
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

/**
 * Who may write a rate, and for whom.
 *
 * Three separate questions, and `createRate` used to ask only the first.
 *
 * **The capability.** `rates:manage` is the floor for touching rates at all.
 *
 * **The kind.** Setting what somebody *costs* additionally needs
 * `rates:view_cost`. Writing a number you are not allowed to read is a strange
 * power to hold, and it is the difference between a manager pricing their own
 * project's work and a manager learning what a colleague is paid. Project
 * Managers hold `rates:manage` and not `rates:view_cost`, so they set billable
 * rates and cost stays with Administrators.
 *
 * **The person.** Nothing here checked reach, so with `rates:manage` alone the
 * path `POST /users/{anybody}/rates` worked for anybody in the account. That
 * did not matter while Administrators were the only holders, because their
 * reach is everyone. It matters the moment a profile with `team` reach holds
 * it. 404 rather than 403, as everywhere else: the API does not confirm that a
 * person outside your reach exists.
 */
async function assertMayWriteRate(ctx: Ctx, userId: string, kind: "billable" | "cost"): Promise<void> {
  assertCan(ctx, "rates:manage");
  if (kind === "cost") assertCan(ctx, "rates:view_cost");
  await assertWithinReach(ctx, userId);
}

/** The person is yourself, or somebody your profile's reach covers. */
async function assertWithinReach(ctx: Ctx, userId: string): Promise<void> {
  if (userId === ctx.actor.userId || ctx.actor.kind === "system") return;

  const [row] = await ctx.db
    .select({ id: s.users.id })
    .from(s.users)
    .where(and(eq(s.users.id, userId), sql`${s.users.id} IN ${visibleUserIds(ctx)}`))
    .limit(1);

  if (!row) throw notFound("That person");
}

export async function listRates(ctx: Ctx, userId: string) {
  // Cost rates are money about a person. Seeing your own is fine; seeing
  // everybody's needs the capability.
  // The capability says "may see rates", not "may see everyone's", so the
  // person has to be within reach as well.
  if (userId !== ctx.actor.userId) {
    assertCan(ctx, "rates:view_billable");
    await assertWithinReach(ctx, userId);
  }

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
  await assertMayWriteRate(ctx, userId, input.kind);

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
/**
 * Change what somebody is paid or charged, from a date.
 *
 * `createRate` inserts, and the database forbids overlapping ranges for one
 * person and kind, so "put this person on a new rate" through `createRate`
 * alone fails the moment they already have one: an open-ended row covers every
 * future day, and the new one collides with it. Every screen that offers to
 * change a rate needs this, so it lives here rather than being rebuilt in the
 * UI out of a delete and an insert that are not in the same transaction.
 *
 * **History is not rewritten, and that is the point.** A time entry carries the
 * rate that applied when it was written, in `billableRateCents` and
 * `costRateCents`. Closing the old range and opening a new one changes what
 * future entries resolve to and leaves every existing entry exactly as it was,
 * so last quarter's profitability does not move because somebody had a raise.
 * The re-rate action is the only thing that touches a snapshot.
 */
export async function setRate(
  ctx: Ctx,
  userId: string,
  input: { kind: "billable" | "cost"; amountCents: number; effectiveFrom: IsoDate }
) {
  await assertMayWriteRate(ctx, userId, input.kind);

  if (input.amountCents < 0) {
    throw validationFailed({ amountCents: ["A rate cannot be negative."] });
  }

  return withTransaction(ctx, async (tx) => {
    const existing = await tx.db
      .select()
      .from(s.userRates)
      .where(and(eq(s.userRates.userId, userId), eq(s.userRates.kind, input.kind)))
      .for("update");

    for (const row of existing) {
      // Starts on or after the new date: entirely superseded, so it goes.
      if (row.startsOn && row.startsOn >= input.effectiveFrom) {
        await tx.db.delete(s.userRates).where(eq(s.userRates.id, row.id));
        continue;
      }
      // Still running on the new date: close it the day before.
      if (!row.endsOn || row.endsOn >= input.effectiveFrom) {
        await tx.db
          .update(s.userRates)
          .set({ endsOn: addDays(input.effectiveFrom, -1) })
          .where(eq(s.userRates.id, row.id));
      }
    }

    const id = newId();
    await tx.db.insert(s.userRates).values({
      id,
      userId,
      kind: input.kind,
      amountCents: input.amountCents,
      startsOn: input.effectiveFrom,
      endsOn: null,
      createdBy: tx.actor.userId,
    });

    tx.audit({
      action: "rate.set",
      entityType: "user_rate",
      entityId: id,
      entityLabel: `${input.kind} rate from ${input.effectiveFrom}`,
      after: { userId, ...input },
    });

    return { id, ...input };
  });
}


export async function deleteRate(ctx: Ctx, userId: string, rateId: string) {
  // The capability floor first, so a Member gets the same answer whether or
  // not the rate exists. The kind is only knowable once the row is read.
  assertCan(ctx, "rates:manage");
  await assertWithinReach(ctx, userId);

  const [existing] = await ctx.db
    .select()
    .from(s.userRates)
    .where(and(eq(s.userRates.id, rateId), eq(s.userRates.userId, userId)))
    .limit(1);
  if (!existing) throw notFound("That rate");

  // Deleting a cost rate changes what the business believes it spends, so it
  // needs the same standing as setting one.
  if (existing.kind === "cost") assertCan(ctx, "rates:view_cost");

  await ctx.db.delete(s.userRates).where(eq(s.userRates.id, rateId));

  ctx.audit({
    action: "rate.delete",
    entityType: "user_rate",
    entityId: rateId,
    before: existing,
  });
}
