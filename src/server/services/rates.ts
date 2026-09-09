/**
 * Rates.
 *
 * Dated ranges, with the overlap rule enforced by the database. This module
 * reads them, resolves them onto a time entry, and manages the CRUD.
 *
 * Specification: docs/BACKEND_PRD.md section 4.5.
 */

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { assertCan, lockNamed, withTransaction, type Ctx } from "@/server/ctx";
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

  /*
    You do not set your own rate.

    `assertWithinReach` waves the self case through, because reach is a
    question about other people. That was harmless while Administrators were
    the only holders of `rates:manage`; it stopped being harmless the moment
    a `team`-reach profile got it. A Project Manager could raise their own
    billable rate, and on a `billBy: \"people\"` project every hour they then
    logged would invoice at it. `assertMayGrantProfile` twelve files over
    already refuses to let somebody change their own permissions and says
    \"Ask another administrator\"; money deserves the same answer.

    The account owner is exempt because somebody has to be able to set the
    first rate, and the owner is the one account that cannot be demoted.
  */
  if (userId === ctx.actor.userId && !ctx.actor.isOwner && ctx.actor.kind !== "system") {
    throw validationFailed({
      amountCents: ["You cannot set your own rate. Ask an administrator."],
    });
  }

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
 * `createRate` inserts an explicit range and the database forbids two ranges of
 * one kind covering the same day, so "put this person on a new rate" through
 * `createRate` alone always collides with the open-ended row already there.
 * This is what a screen calls.
 *
 * **Nothing is deleted.** The first version of this closed the range covering
 * the new date and `DELETE`d every range starting on or after it, which read as
 * "entirely superseded" and was not: a backdated change wiped a person's whole
 * rate history, including changes scheduled ahead of it, with `before: null` in
 * the audit row and nothing to reconstruct it from. A reviewer set a rate
 * effective last June and lost the year either side of it. `CLAUDE.md` says
 * archive over delete and that every destructive action gets Undo or a typed
 * confirmation, and this had neither.
 *
 * So a later range is left exactly where it is, and the new one simply runs
 * until that range begins. Setting a rate in March when July is already
 * scheduled gives March to June at the new price and leaves July alone, which
 * is what somebody scheduling a raise would expect. A range that starts on the
 * very day being set is amended in place rather than replaced, so its id and
 * its history survive.
 *
 * **Existing time entries never move.** An entry carries the rate snapshot it
 * was written with, so changing a rate changes what future entries resolve to
 * and leaves last quarter's profitability alone. The re-rate action is the only
 * thing that touches a snapshot.
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
    /*
      An advisory lock, not `FOR UPDATE`.

      `FOR UPDATE` locks the rows a statement can see, which is nothing at all
      when a person has no rate of this kind yet, so two first-time writers both
      inserted and the loser got a raw overlap error from an endpoint whose
      whole purpose is to spare the caller thinking about overlaps. Locking the
      name serialises the pair whether or not any row exists.
    */
    await lockNamed(tx, `rate:${userId}:${input.kind}`);

    const existing = await tx.db
      .select()
      .from(s.userRates)
      .where(and(eq(s.userRates.userId, userId), eq(s.userRates.kind, input.kind)))
      .orderBy(s.userRates.startsOn);

    // A range that already starts on this day is the same decision being made
    // again: amend it rather than stacking a second row on the same date.
    const sameDay = existing.find((r) => r.startsOn === input.effectiveFrom);
    if (sameDay) {
      await tx.db
        .update(s.userRates)
        .set({ amountCents: input.amountCents })
        .where(eq(s.userRates.id, sameDay.id));

      tx.audit({
        action: "rate.set",
        entityType: "user_rate",
        entityId: sameDay.id,
        entityLabel: `${input.kind} rate from ${input.effectiveFrom}`,
        before: sameDay,
        after: { ...sameDay, amountCents: input.amountCents },
      });
      return { id: sameDay.id, ...input };
    }

    // Whatever is running on the day: close it the evening before.
    const covering = existing.find(
      (r) =>
        (!r.startsOn || r.startsOn < input.effectiveFrom) &&
        (!r.endsOn || r.endsOn >= input.effectiveFrom)
    );
    if (covering) {
      await tx.db
        .update(s.userRates)
        .set({ endsOn: addDays(input.effectiveFrom, -1) })
        .where(eq(s.userRates.id, covering.id));
    }

    // Anything scheduled after this stays scheduled, and bounds the new range.
    const nextStart = existing
      .map((r) => r.startsOn)
      .filter((d): d is string => Boolean(d) && d! > input.effectiveFrom)
      .sort()[0];

    const id = newId();
    await tx.db.insert(s.userRates).values({
      id,
      userId,
      kind: input.kind,
      amountCents: input.amountCents,
      startsOn: input.effectiveFrom,
      endsOn: nextStart ? addDays(nextStart as IsoDate, -1) : null,
      createdBy: tx.actor.userId,
    });

    tx.audit({
      action: "rate.set",
      entityType: "user_rate",
      entityId: id,
      entityLabel: `${input.kind} rate from ${input.effectiveFrom}`,
      before: covering ?? null,
      after: { userId, ...input, endsOn: nextStart ? addDays(nextStart as IsoDate, -1) : null },
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

  /*
    404, not 403, for a cost row this actor may not see.

    `listRates` filters cost rows out entirely, so answering \"forbidden\" here
    told the caller a row exists that the list denies. It is a weak oracle,
    since you need the id, but the house rule is 404 for anything outside
    your scope and there is no reason for this to be the exception.
  */
  if (existing.kind === "cost" && !ctx.actor.capabilities.has("rates:view_cost") && ctx.actor.kind !== "system") {
    throw notFound("That rate");
  }

  await ctx.db.delete(s.userRates).where(eq(s.userRates.id, rateId));

  ctx.audit({
    action: "rate.delete",
    entityType: "user_rate",
    entityId: rateId,
    before: existing,
  });
}

/* ---------------------------------------------------------------- re-rate */

/** What a re-rate would do, or did. Money in cents, as everywhere else. */
export interface ReRateOutcome {
  /** Entries in scope that were eligible to change. */
  considered: number;
  /** Entries whose snapshot actually moved. */
  changed: number;
  /** Eligible entries the resolver returned the same numbers for. */
  unchanged: number;
  /** In scope but deliberately untouched, by reason. */
  skipped: { invoiced: number; billedExternally: number; locked: number; running: number };
  /** The billable value of the considered entries, before and after. */
  billableCentsBefore: number;
  billableCentsAfter: number;
  /** Hours still resolving to no rate, which re-rating cannot fix. */
  stillUnrated: number;
}

/**
 * Re-resolve the rate snapshots on a project's unbilled hours.
 *
 * THE ONE THING THAT MAY CHANGE A SNAPSHOT
 *
 * An entry records the rates in force when it was written and never
 * recalculates them, which is what keeps January's cost from moving when
 * somebody gets a raise in March. The PRD and CLAUDE.md have both described an
 * "explicit re-rate action" as the single exception since the schema was
 * written. It did not exist. Nothing in the product could change a snapshot.
 *
 * That is not a tidiness problem. Every Example Client 07 hour imported from Harvest
 * carried a snapshot of zero, because the export had no rates in it. Setting an
 * hourly rate on the project afterwards correctly changed nothing, so 876
 * entries of real work were worth nothing on the Uninvoiced screen and nothing
 * on an invoice, and there was no way to put it right (t-zNfxik, t-9Uli4l).
 *
 * WHAT IT REFUSES TO TOUCH
 *
 * Anything already billed, by us or elsewhere, and anything locked. An invoice
 * that has gone to a client is a statement about money owed, and changing the
 * hours behind it afterwards makes the document disagree with the ledger. Work
 * marked billed in QuickBooks is the same promise kept somewhere else. Those
 * are counted and reported rather than silently passed over, because "it did
 * not change everything I selected" is exactly the thing an operator has to be
 * told (the lesson from `markBilledExternally`).
 *
 * It re-resolves cost as well as billable. Both are snapshots taken by the same
 * function at the same moment, and an import that lost one usually lost both.
 */
export async function reRateProject(
  ctx: Ctx,
  input: { projectId: string; from?: IsoDate; to?: IsoDate; dryRun?: boolean }
): Promise<ReRateOutcome> {
  assertCan(ctx, "rates:manage");

  const [project] = await ctx.db
    .select({ id: s.projects.id })
    .from(s.projects)
    .where(eq(s.projects.id, input.projectId))
    .limit(1);
  if (!project) throw notFound("That project");

  const rows = await ctx.db
    .select({
      id: s.timeEntries.id,
      userId: s.timeEntries.userId,
      projectTaskId: s.timeEntries.projectTaskId,
      spentOn: s.timeEntries.spentOn,
      durationSeconds: s.timeEntries.durationSeconds,
      billableRateCents: s.timeEntries.billableRateCents,
      costRateCents: s.timeEntries.costRateCents,
      invoiceId: s.timeEntries.invoiceId,
      billedExternally: s.timeEntries.billedExternally,
      ratesLockedAt: s.timeEntries.ratesLockedAt,
      timerStartedAt: s.timeEntries.timerStartedAt,
    })
    .from(s.timeEntries)
    .where(
      and(
        eq(s.timeEntries.projectId, input.projectId),
        sql`${s.timeEntries.deletedAt} IS NULL`,
        input.from ? sql`${s.timeEntries.spentOn} >= ${input.from}` : sql`true`,
        input.to ? sql`${s.timeEntries.spentOn} <= ${input.to}` : sql`true`
      )
    );

  const outcome: ReRateOutcome = {
    considered: 0,
    changed: 0,
    unchanged: 0,
    skipped: { invoiced: 0, billedExternally: 0, locked: 0, running: 0 },
    billableCentsBefore: 0,
    billableCentsAfter: 0,
    stillUnrated: 0,
  };

  const eligible: typeof rows = [];
  for (const row of rows) {
    if (row.invoiceId) { outcome.skipped.invoiced++; continue; }
    if (row.billedExternally) { outcome.skipped.billedExternally++; continue; }
    if (row.ratesLockedAt) { outcome.skipped.locked++; continue; }
    if (row.timerStartedAt) { outcome.skipped.running++; continue; }
    eligible.push(row);
  }
  outcome.considered = eligible.length;

  /*
    Value is accumulated in cent-seconds and divided once, per BACKEND_PRD 3.6.
    Rounding each entry to cents and summing drifts in one direction, and this
    number is the one somebody decides whether to run the action on.
  */
  let beforeCentSeconds = 0;
  let afterCentSeconds = 0;
  const updates: { id: string; billableRateCents: number; costRateCents: number }[] = [];

  for (const row of eligible) {
    const resolved = await resolveForEntry(ctx, {
      userId: row.userId,
      projectId: input.projectId,
      projectTaskId: row.projectTaskId,
      spentOn: row.spentOn as IsoDate,
    });

    beforeCentSeconds += row.durationSeconds * row.billableRateCents;
    afterCentSeconds += row.durationSeconds * resolved.billableRateCents;
    if (resolved.rateMissing) outcome.stillUnrated++;

    if (
      resolved.billableRateCents === row.billableRateCents &&
      resolved.costRateCents === row.costRateCents
    ) {
      outcome.unchanged++;
      continue;
    }

    outcome.changed++;
    updates.push({
      id: row.id,
      billableRateCents: resolved.billableRateCents,
      costRateCents: resolved.costRateCents,
    });
  }

  outcome.billableCentsBefore = Math.round(beforeCentSeconds / 3600);
  outcome.billableCentsAfter = Math.round(afterCentSeconds / 3600);

  // A preview writes nothing. It exists so the screen can say what the action
  // would do to the money before anybody presses it.
  if (input.dryRun) return outcome;
  if (!updates.length) return outcome;

  return withTransaction(ctx, async (tx) => {
    for (const update of updates) {
      await tx.db
        .update(s.timeEntries)
        .set({
          billableRateCents: update.billableRateCents,
          costRateCents: update.costRateCents,
          updatedAt: tx.now(),
          updatedBy: tx.actor.userId,
        })
        .where(eq(s.timeEntries.id, update.id));
    }

    /*
      The changed ids go in the audit, not just how many.

      This rewrites money on rows that already existed, which is the one thing
      the snapshot rule exists to prevent, so the record has to be able to answer
      "which entries, and from what to what" long after the fact. The scope
      bounds the size: this runs against one project.
    */
    tx.audit({
      action: "rates.re_rate",
      entityType: "project",
      entityId: input.projectId,
      entityLabel: "Re-rated unbilled hours",
      after: {
        from: input.from ?? null,
        to: input.to ?? null,
        ...outcome,
        entries: updates,
      },
    });

    return outcome;
  });
}
