/**
 * Timesheet approvals.
 *
 * A submission covers a period, and it covers **both** the time entries and the
 * expenses in it. They are reviewed together because a week is a week: sending
 * back the hours but silently approving the taxi fare would be a strange thing
 * for a system to do.
 *
 * The lock an approval imposes is period-based, not row-based. That is enforced
 * in `canEdit`, not here, but it is the reason this service records the period
 * rather than tagging individual rows and calling it done.
 */

import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { assertCan, withTransaction, type Ctx } from "@/server/ctx";
import * as s from "@/server/db/schema";
import { newId } from "@/server/db/ids";
import { approvalScope, canActOnBehalfOf, visibleUserIds } from "@/server/auth/scope";
import { AppError, forbidden, notFound, validationFailed } from "@/server/errors";
import { addDays, dayIn, eachDay, isIsoDate, startOfWeek, type IsoDate } from "@/domain/calendar";
import { getSettings } from "./settings";

export interface SubmissionDto {
  id: string;
  userId: string;
  periodStart: string;
  periodEnd: string;
  state: string;
  submittedAt: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  totalSeconds: number;
  flags: string[];
  amended: boolean;
}

const toDto = (row: s.SubmissionRow): SubmissionDto => ({
  id: row.id,
  userId: row.userId,
  periodStart: row.periodStart,
  periodEnd: row.periodEnd,
  state: row.state,
  submittedAt: row.submittedAt ? row.submittedAt.toISOString() : null,
  reviewedBy: row.reviewedBy,
  reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
  reviewNote: row.reviewNote,
  totalSeconds: row.totalSeconds,
  flags: (row.flags as string[]) ?? [],
  amended: row.amendedAt != null,
});

/* -------------------------------------------------------------------- read */

export async function listSubmissions(
  ctx: Ctx,
  opts: { state?: string; periodStart?: IsoDate; limit?: number } = {}
): Promise<SubmissionDto[]> {
  const conditions = [approvalScope(ctx)];
  if (opts.state && opts.state !== "all") conditions.push(eq(s.timesheetSubmissions.state, opts.state));
  if (opts.periodStart) conditions.push(eq(s.timesheetSubmissions.periodStart, opts.periodStart));

  const rows = await ctx.db
    .select()
    .from(s.timesheetSubmissions)
    .where(and(...conditions))
    .orderBy(desc(s.timesheetSubmissions.periodStart), desc(s.timesheetSubmissions.submittedAt))
    .limit(opts.limit ?? 500);

  return rows.map(toDto);
}

/** The caller's own submissions, whatever their review capability. */
export async function mySubmissions(ctx: Ctx): Promise<SubmissionDto[]> {
  const rows = await ctx.db
    .select()
    .from(s.timesheetSubmissions)
    .where(eq(s.timesheetSubmissions.userId, ctx.actor.userId))
    .orderBy(desc(s.timesheetSubmissions.periodStart))
    .limit(100);
  return rows.map(toDto);
}

/* ------------------------------------------------------------------ submit */

/**
 * Flags computed at submit time.
 *
 * A snapshot rather than a live query: the reviewer is looking at what was true
 * when the week was submitted, and a flag that quietly disappears while
 * somebody is reading the queue is worse than one that is slightly stale.
 */
async function computeFlags(
  ctx: Ctx,
  userId: string,
  periodStart: IsoDate,
  periodEnd: IsoDate
): Promise<{ flags: string[]; totalSeconds: number }> {
  const settings = await getSettings(ctx);

  const rows = await ctx.db
    .select({
      spentOn: s.timeEntries.spentOn,
      durationSeconds: s.timeEntries.durationSeconds,
      notes: s.timeEntries.notes,
      isBillable: s.timeEntries.isBillable,
    })
    .from(s.timeEntries)
    .where(
      and(
        eq(s.timeEntries.userId, userId),
        gte(s.timeEntries.spentOn, periodStart),
        lte(s.timeEntries.spentOn, periodEnd),
        isNull(s.timeEntries.deletedAt)
      )
    );

  const totalSeconds = rows.reduce((a, r) => a + r.durationSeconds, 0);
  const flags: string[] = [];

  const byDay = new Map<string, number>();
  for (const r of rows) byDay.set(r.spentOn, (byDay.get(r.spentOn) ?? 0) + r.durationSeconds);

  const threshold = settings.flagMissingBelowSeconds;
  if (threshold != null) {
    const short = eachDay(periodStart, periodEnd).filter((day) => {
      const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
      if (dow === 0 || dow === 6) return false;
      return (byDay.get(day) ?? 0) < threshold;
    });
    if (short.length) flags.push(`${short.length} short ${short.length === 1 ? "day" : "days"}`);
  }

  const missingNotes = rows.filter((r) => !r.notes?.trim()).length;
  if (missingNotes > 0) flags.push(`${missingNotes} without notes`);

  const nonBillable = rows.filter((r) => !r.isBillable).reduce((a, r) => a + r.durationSeconds, 0);
  if (totalSeconds > 0 && nonBillable / totalSeconds > 0.5) flags.push("Mostly non-billable");

  const long = rows.filter((r) => r.durationSeconds > 12 * 3600).length;
  if (long > 0) flags.push(`${long} over 12 hours`);

  if (totalSeconds === 0) flags.push("Empty week");

  return { flags, totalSeconds };
}

export async function submitTimesheet(
  ctx: Ctx,
  input: { periodStart: IsoDate; userId?: string }
): Promise<SubmissionDto> {
  const targetUserId = input.userId ?? ctx.actor.userId;
  if (targetUserId === ctx.actor.userId) assertCan(ctx, "approval:submit");
  else if (!(await canActOnBehalfOf(ctx, targetUserId))) {
    throw forbidden("You cannot submit that person's timesheet.");
  }

  if (!isIsoDate(input.periodStart)) throw validationFailed({ periodStart: ["Use YYYY-MM-DD."] });

  return withTransaction(ctx, async (tx) => {
    const settings = await getSettings(tx);
    const periodStart = startOfWeek(input.periodStart, settings.weekStartsOn);
    const periodEnd = addDays(periodStart, 6);

    const { flags, totalSeconds } = await computeFlags(tx, targetUserId, periodStart, periodEnd);

    const [existing] = await tx.db
      .select()
      .from(s.timesheetSubmissions)
      .where(
        and(eq(s.timesheetSubmissions.userId, targetUserId), eq(s.timesheetSubmissions.periodStart, periodStart))
      )
      .limit(1);

    if (existing?.state === "approved") {
      throw new AppError("period_approved", "That week has already been approved.");
    }

    const id = existing?.id ?? newId();

    if (existing) {
      // Resubmitting after changes were requested returns it to the queue.
      await tx.db
        .update(s.timesheetSubmissions)
        .set({
          state: "submitted",
          submittedAt: tx.now(),
          totalSeconds,
          flags,
          reviewedBy: null,
          reviewedAt: null,
          reviewNote: null,
          updatedAt: tx.now(),
        })
        .where(eq(s.timesheetSubmissions.id, id));
    } else {
      await tx.db.insert(s.timesheetSubmissions).values({
        id,
        userId: targetUserId,
        periodStart,
        periodEnd,
        state: "submitted",
        submittedAt: tx.now(),
        totalSeconds,
        flags,
      });
    }

    // Associate the period's rows, so the submission is a record of what was
    // reviewed rather than only of when.
    //
    // Cleared first. An entry moved out of the period between two submissions
    // otherwise keeps pointing at this one, and the submission then claims to
    // cover work that is no longer in it.
    await tx.db
      .update(s.timeEntries)
      .set({ approvalId: null })
      .where(
        and(
          eq(s.timeEntries.approvalId, id),
          sql`(${s.timeEntries.spentOn} < ${periodStart} OR ${s.timeEntries.spentOn} > ${periodEnd})`
        )
      );
    await tx.db
      .update(s.expenses)
      .set({ approvalId: null })
      .where(
        and(
          eq(s.expenses.approvalId, id),
          sql`(${s.expenses.spentOn} < ${periodStart} OR ${s.expenses.spentOn} > ${periodEnd})`
        )
      );

    await tx.db
      .update(s.timeEntries)
      .set({ approvalId: id })
      .where(
        and(
          eq(s.timeEntries.userId, targetUserId),
          gte(s.timeEntries.spentOn, periodStart),
          lte(s.timeEntries.spentOn, periodEnd),
          isNull(s.timeEntries.deletedAt)
        )
      );

    await tx.db
      .update(s.expenses)
      .set({ approvalId: id })
      .where(
        and(
          eq(s.expenses.userId, targetUserId),
          gte(s.expenses.spentOn, periodStart),
          lte(s.expenses.spentOn, periodEnd),
          isNull(s.expenses.deletedAt)
        )
      );

    tx.audit({
      action: "timesheet.submit",
      entityType: "timesheet_submission",
      entityId: id,
      after: { periodStart, periodEnd, totalSeconds, flags },
    });
    tx.emit({ topic: "timesheet.submitted", payload: { submissionId: id, userId: targetUserId, periodStart } });

    const [row] = await tx.db.select().from(s.timesheetSubmissions).where(eq(s.timesheetSubmissions.id, id)).limit(1);
    return toDto(row!);
  });
}

/* ------------------------------------------------------------------ review */

async function loadReviewable(ctx: Ctx, id: string) {
  assertCan(ctx, "approval:review");

  const [row] = await ctx.db
    .select()
    .from(s.timesheetSubmissions)
    .where(and(eq(s.timesheetSubmissions.id, id), approvalScope(ctx)))
    .limit(1);

  if (!row) throw notFound("That submission");

  // Approving your own week is not review, it is self-certification.
  if (row.userId === ctx.actor.userId && !ctx.actor.capabilities.has("approval:review_all")) {
    throw forbidden("Somebody else has to review your own timesheet.");
  }

  return row;
}

export async function approveSubmission(ctx: Ctx, id: string, note?: string): Promise<SubmissionDto> {
  return withTransaction(ctx, async (tx) => {
    const before = await loadReviewable(tx, id);

    const [after] = await tx.db
      .update(s.timesheetSubmissions)
      .set({
        state: "approved",
        reviewedBy: tx.actor.userId,
        reviewedAt: tx.now(),
        reviewNote: note?.trim() || null,
        updatedAt: tx.now(),
      })
      .where(eq(s.timesheetSubmissions.id, id))
      .returning();

    tx.audit({
      action: "timesheet.approve",
      entityType: "timesheet_submission",
      entityId: id,
      before,
      after,
    });
    tx.emit({
      topic: "timesheet.approved",
      payload: { submissionId: id, userId: before.userId, periodStart: before.periodStart },
    });

    await notify(tx, before.userId, {
      kind: "approval",
      title: `Your week of ${before.periodStart} was approved.`,
      body: note?.trim() || null,
      entityType: "timesheet_submission",
      entityId: id,
      url: "/timesheet",
    });

    return toDto(after!);
  });
}

export async function requestChanges(ctx: Ctx, id: string, note: string): Promise<SubmissionDto> {
  const cleaned = note?.trim();
  // A rejection without a reason is a rejection somebody has to chase.
  if (!cleaned) throw validationFailed({ note: ["Say what needs to change."] });

  return withTransaction(ctx, async (tx) => {
    const before = await loadReviewable(tx, id);

    const [after] = await tx.db
      .update(s.timesheetSubmissions)
      .set({
        state: "changes_requested",
        reviewedBy: tx.actor.userId,
        reviewedAt: tx.now(),
        reviewNote: cleaned,
        updatedAt: tx.now(),
      })
      .where(eq(s.timesheetSubmissions.id, id))
      .returning();

    tx.audit({
      action: "timesheet.request_changes",
      entityType: "timesheet_submission",
      entityId: id,
      before,
      after,
    });

    await notify(tx, before.userId, {
      kind: "approval",
      title: `Changes requested on your week of ${before.periodStart}.`,
      body: cleaned,
      entityType: "timesheet_submission",
      entityId: id,
      url: "/timesheet",
    });

    return toDto(after!);
  });
}

/** Bulk approve, for a reviewer working down the queue. */
export async function approveMany(ctx: Ctx, ids: string[]): Promise<number> {
  let approved = 0;
  for (const id of ids) {
    await approveSubmission(ctx, id);
    approved += 1;
  }
  return approved;
}

/* ------------------------------------------------------------ reminders */

export async function remindToSubmit(
  ctx: Ctx,
  input: { periodStart: IsoDate; userIds?: string[] }
): Promise<number> {
  assertCan(ctx, "approval:review");

  return withTransaction(ctx, async (tx) => {
    const settings = await getSettings(tx);
    const periodStart = startOfWeek(input.periodStart, settings.weekStartsOn);

    const candidates = await tx.db
      .select({ id: s.users.id })
      .from(s.users)
      .where(
        and(
          isNull(s.users.archivedAt),
          // Reach, not just capability. Without this, omitting `userIds` mailed
          // the whole company on behalf of a reviewer who oversees four people.
          sql`${s.users.id} IN ${visibleUserIds(tx)}`,
          input.userIds?.length ? inArray(s.users.id, input.userIds) : sql`true`,
          sql`NOT EXISTS (
            SELECT 1 FROM ${s.timesheetSubmissions} sub
            WHERE sub.user_id = ${s.users.id} AND sub.period_start = ${periodStart}
          )`
        )
      );

    for (const person of candidates) {
      await notify(tx, person.id, {
        kind: "reminder",
        title: `Your timesheet for the week of ${periodStart} is not submitted.`,
        body: null,
        entityType: "timesheet_submission",
        entityId: null,
        url: "/timesheet",
      });
    }

    tx.audit({
      action: "timesheet.remind",
      entityType: "timesheet_submission",
      after: { periodStart, count: candidates.length },
    });

    return candidates.length;
  });
}

/* -------------------------------------------------------------------- util */

async function notify(
  ctx: Ctx,
  userId: string,
  n: { kind: string; title: string; body: string | null; entityType: string | null; entityId: string | null; url: string | null }
) {
  await ctx.db.insert(s.notifications).values({
    id: newId(),
    userId,
    kind: n.kind,
    title: n.title,
    body: n.body,
    entityType: n.entityType,
    entityId: n.entityId,
    url: n.url,
  });
}

/** The approved periods for a person, used by the editability predicate. */
export async function approvedPeriodsFor(ctx: Ctx, userId: string) {
  const rows = await ctx.db
    .select({ periodStart: s.timesheetSubmissions.periodStart, periodEnd: s.timesheetSubmissions.periodEnd })
    .from(s.timesheetSubmissions)
    .where(and(eq(s.timesheetSubmissions.userId, userId), eq(s.timesheetSubmissions.state, "approved")))
    .orderBy(asc(s.timesheetSubmissions.periodStart));
  return rows;
}
