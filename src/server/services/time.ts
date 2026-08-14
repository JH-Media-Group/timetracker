/**
 * Time entries.
 *
 * The heart of the product, and the place where the domain rules actually bite:
 *
 *   - `spent_on` is resolved in the **owner's** timezone, not the actor's and
 *     not the server's, once, at creation, and never drifts after (4.4).
 *   - rates are snapshotted at write time and only recomputed when the project,
 *     task, person, or date changes (4.5).
 *   - one running timer per person, enforced by the database. Starting a second
 *     one stops the first in the same transaction, in that order, because the
 *     reverse trips the unique index (4.9).
 *   - editability is a single predicate covering four locks, and it is
 *     period-based so a back-dated entry cannot slip into an approved week
 *     (4.10).
 */

import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { assertCan, withTransaction, type Ctx } from "@/server/ctx";
import * as s from "@/server/db/schema";
import { newId } from "@/server/db/ids";
import { timeEntryScope, canActOnBehalfOf } from "@/server/auth/scope";
import { AppError, forbidden, notFound, recordLocked, validationFailed } from "@/server/errors";
import { serializeTimeEntry, type TimeEntryDto } from "@/server/serialize";
import { canEdit, type EditabilityContext } from "@/domain/editability";
import { dayIn, type IsoDate } from "@/domain/calendar";
import { getSettings } from "./settings";
import { resolveForEntry } from "./rates";
import { projectTaskFor } from "./projects";

/* ---------------------------------------------------------------- reading */

export interface TimeQuery {
  from?: IsoDate;
  to?: IsoDate;
  userId?: string;
  projectId?: string;
  clientId?: string;
  taskId?: string;
  isBillable?: boolean;
  invoiced?: boolean;
  limit?: number;
}

function conditionsFor(ctx: Ctx, q: TimeQuery) {
  const conditions = [isNull(s.timeEntries.deletedAt), timeEntryScope(ctx, { requestedUserId: q.userId })];

  if (q.from) conditions.push(gte(s.timeEntries.spentOn, q.from));
  if (q.to) conditions.push(lte(s.timeEntries.spentOn, q.to));
  if (q.userId) conditions.push(eq(s.timeEntries.userId, q.userId));
  if (q.projectId) conditions.push(eq(s.timeEntries.projectId, q.projectId));
  if (q.isBillable !== undefined) conditions.push(eq(s.timeEntries.isBillable, q.isBillable));
  if (q.invoiced === true) conditions.push(sql`${s.timeEntries.invoiceId} IS NOT NULL`);
  if (q.invoiced === false) conditions.push(isNull(s.timeEntries.invoiceId));
  if (q.clientId) {
    conditions.push(
      sql`${s.timeEntries.projectId} IN (SELECT id FROM ${s.projects} WHERE client_id = ${q.clientId})`
    );
  }
  if (q.taskId) {
    conditions.push(
      sql`${s.timeEntries.projectTaskId} IN (SELECT id FROM ${s.projectTasks} WHERE task_id = ${q.taskId})`
    );
  }

  return and(...conditions);
}

export async function listTimeEntries(ctx: Ctx, q: TimeQuery = {}): Promise<TimeEntryDto[]> {
  const rows = await ctx.db
    .select({
      entry: s.timeEntries,
      taskId: s.projectTasks.taskId,
      invoiceState: s.invoices.state,
    })
    .from(s.timeEntries)
    .innerJoin(s.projectTasks, eq(s.projectTasks.id, s.timeEntries.projectTaskId))
    .leftJoin(s.invoices, eq(s.invoices.id, s.timeEntries.invoiceId))
    .where(conditionsFor(ctx, q))
    .orderBy(desc(s.timeEntries.spentOn), asc(s.timeEntries.startedAt), asc(s.timeEntries.createdAt))
    .limit(Math.min(q.limit ?? 5000, 10000));

  if (rows.length === 0) return [];

  const lockContext = await editabilityContextFor(ctx, [...new Set(rows.map((r) => r.entry.userId))]);

  return rows.map((r) => {
    const lock = canEdit(
      {
        spentOn: r.entry.spentOn,
        userId: r.entry.userId,
        invoiceId: r.entry.invoiceId,
        invoiceState: r.invoiceState,
        billedExternally: r.entry.billedExternally,
      },
      lockContext(r.entry.userId)
    );
    return serializeTimeEntry(ctx, { ...r.entry, taskId: r.taskId }, {
      locked: !lock.editable,
      lockReasons: lock.reasons,
    });
  });
}

export async function getTimeEntry(ctx: Ctx, id: string): Promise<TimeEntryDto> {
  const [row] = await ctx.db
    .select({ entry: s.timeEntries, taskId: s.projectTasks.taskId, invoiceState: s.invoices.state })
    .from(s.timeEntries)
    .innerJoin(s.projectTasks, eq(s.projectTasks.id, s.timeEntries.projectTaskId))
    .leftJoin(s.invoices, eq(s.invoices.id, s.timeEntries.invoiceId))
    .where(and(eq(s.timeEntries.id, id), isNull(s.timeEntries.deletedAt), timeEntryScope(ctx)))
    .limit(1);

  if (!row) throw notFound("That time entry");

  const lockContext = await editabilityContextFor(ctx, [row.entry.userId]);
  const lock = canEdit(
    {
      spentOn: row.entry.spentOn,
      userId: row.entry.userId,
      invoiceId: row.entry.invoiceId,
      invoiceState: row.invoiceState,
      billedExternally: row.entry.billedExternally,
    },
    lockContext(row.entry.userId)
  );

  return serializeTimeEntry(ctx, { ...row.entry, taskId: row.taskId }, {
    locked: !lock.editable,
    lockReasons: lock.reasons,
  });
}

export async function runningEntry(ctx: Ctx, userId?: string): Promise<TimeEntryDto | null> {
  const target = userId ?? ctx.actor.userId;
  const [row] = await ctx.db
    .select({ entry: s.timeEntries, taskId: s.projectTasks.taskId })
    .from(s.timeEntries)
    .innerJoin(s.projectTasks, eq(s.projectTasks.id, s.timeEntries.projectTaskId))
    .where(
      and(
        eq(s.timeEntries.userId, target),
        sql`${s.timeEntries.timerStartedAt} IS NOT NULL`,
        isNull(s.timeEntries.deletedAt),
        timeEntryScope(ctx, { requestedUserId: target })
      )
    )
    .limit(1);

  if (!row) return null;
  return serializeTimeEntry(ctx, { ...row.entry, taskId: row.taskId });
}

/* -------------------------------------------------------------- editability */

/**
 * Builds a per-user editability context in one query set.
 *
 * The approved-period lookup is the expensive part, so it is fetched once for
 * every user in the result rather than per row. A week view with thirty entries
 * would otherwise make thirty identical queries.
 */
async function editabilityContextFor(
  ctx: Ctx,
  userIds: string[]
): Promise<(userId: string) => EditabilityContext> {
  const settings = await getSettings(ctx);
  const canOverride =
    ctx.actor.kind === "system" ||
    ctx.actor.capabilities.has("people:manage") ||
    ctx.actor.baseKey === "administrator";

  const approvals = userIds.length
    ? await ctx.db
        .select({
          userId: s.timesheetSubmissions.userId,
          periodStart: s.timesheetSubmissions.periodStart,
          periodEnd: s.timesheetSubmissions.periodEnd,
        })
        .from(s.timesheetSubmissions)
        .where(
          and(inArray(s.timesheetSubmissions.userId, userIds), eq(s.timesheetSubmissions.state, "approved"))
        )
    : [];

  const byUser = new Map<string, { periodStart: string; periodEnd: string }[]>();
  for (const a of approvals) {
    const list = byUser.get(a.userId);
    if (list) list.push(a);
    else byUser.set(a.userId, [a]);
  }

  const today = dayIn(settings.timezone, ctx.now());

  return (userId: string) => ({
    today,
    approvedPeriods: byUser.get(userId) ?? [],
    lockTimesheetsAfterDays: settings.lockTimesheetsAfterDays,
    canOverride,
  });
}

/** Loads one entry and throws unless the actor may change it. */
async function loadEditable(ctx: Ctx, id: string) {
  const [row] = await ctx.db
    .select({ entry: s.timeEntries, invoiceState: s.invoices.state })
    .from(s.timeEntries)
    .leftJoin(s.invoices, eq(s.invoices.id, s.timeEntries.invoiceId))
    .where(and(eq(s.timeEntries.id, id), isNull(s.timeEntries.deletedAt), timeEntryScope(ctx)))
    .limit(1);

  if (!row) throw notFound("That time entry");

  const own = row.entry.userId === ctx.actor.userId;
  if (own) assertCan(ctx, "time:edit_own");
  else if (!(await canActOnBehalfOf(ctx, row.entry.userId))) {
    throw forbidden("You cannot change time for that person.");
  }

  const lockContext = await editabilityContextFor(ctx, [row.entry.userId]);
  const lock = canEdit(
    {
      spentOn: row.entry.spentOn,
      userId: row.entry.userId,
      invoiceId: row.entry.invoiceId,
      invoiceState: row.invoiceState,
      billedExternally: row.entry.billedExternally,
    },
    lockContext(row.entry.userId)
  );

  if (!lock.editable) throw recordLocked(lock.reasons);
  return { entry: row.entry, requiresOverride: lock.requiresOverride, reasons: lock.reasons };
}

/* --------------------------------------------------------------- creating */

export interface CreateTimeEntryInput {
  userId?: string;
  projectId: string;
  taskId: string;
  spentOn?: IsoDate;
  durationSeconds?: number;
  startedAt?: string | null;
  endedAt?: string | null;
  notes?: string | null;
  isBillable?: boolean;
  /** Start a timer on the new entry, stopping whatever was running. */
  start?: boolean;
  source?: string;
}

export interface CreateResult {
  entry: TimeEntryDto;
  /** The entry that was stopped to make room, when `start` was set. */
  stopped: TimeEntryDto | null;
}

export async function createTimeEntry(ctx: Ctx, input: CreateTimeEntryInput): Promise<CreateResult> {
  const targetUserId = input.userId ?? ctx.actor.userId;
  const own = targetUserId === ctx.actor.userId;

  if (own) assertCan(ctx, "time:create_own");
  else if (!(await canActOnBehalfOf(ctx, targetUserId))) {
    throw forbidden("You cannot log time for that person.");
  }

  return withTransaction(ctx, async (tx) => {
    const settings = await getSettings(tx);

    // The calendar day belongs to the *owner*, not the actor. Somebody in
    // Atlanta logging time for a colleague in Karachi must not shift that
    // person's day.
    const [owner] = await tx.db
      .select({ timezone: s.users.timezone, archivedAt: s.users.archivedAt })
      .from(s.users)
      .where(eq(s.users.id, targetUserId))
      .limit(1);
    if (!owner) throw validationFailed({ userId: ["That person does not exist."] });
    if (owner.archivedAt) throw validationFailed({ userId: ["That person is archived."] });

    const spentOn = input.spentOn ?? dayIn(owner.timezone, tx.now());

    // "Future" is measured on the owner's calendar, not the account's. When it
    // is still Thursday afternoon in Atlanta it is already Friday in Karachi,
    // and refusing somebody in Karachi permission to log today would be absurd.
    if (!settings.allowFutureDates && spentOn > dayIn(owner.timezone, tx.now())) {
      throw validationFailed({ spentOn: ["This account does not allow time on future dates."] });
    }

    // A project has to be live and the person has to be on it.
    const [project] = await tx.db
      .select({ archivedAt: s.projects.archivedAt, name: s.projects.name })
      .from(s.projects)
      .where(eq(s.projects.id, input.projectId))
      .limit(1);
    if (!project) throw validationFailed({ projectId: ["That project does not exist."] });
    if (project.archivedAt) throw validationFailed({ projectId: ["That project is archived."] });

    const projectTaskId = await projectTaskFor(tx, input.projectId, input.taskId);

    // Creating into an approved period is refused for the owner, and flags the
    // submission when an administrator overrides.
    const lockContext = await editabilityContextFor(tx, [targetUserId]);
    const lock = canEdit(
      { spentOn, userId: targetUserId, invoiceId: null, invoiceState: null, billedExternally: false },
      lockContext(targetUserId)
    );
    if (!lock.editable) throw new AppError("period_approved", "That week has been approved.", {
      meta: { reasons: lock.reasons },
    });

    const notes = input.notes?.trim() || null;
    const rates = await resolveForEntry(tx, {
      userId: targetUserId,
      projectId: input.projectId,
      projectTaskId,
      spentOn,
    });

    // A task can be billable at a zero rate (the rate is simply missing), so
    // billability comes from the task, not from whether a rate was found.
    const isBillable = input.isBillable ?? (await taskIsBillable(tx, projectTaskId));

    if (settings.requireNotes === "always" && !notes) {
      throw validationFailed({ notes: ["This account requires a note on every entry."] });
    }
    if (settings.requireNotes === "non_billable" && !isBillable && !notes) {
      throw validationFailed({ notes: ["This account requires a note on non-billable time."] });
    }

    // One running timer per person. Stop first, then insert: the reverse order
    // trips the partial unique index inside the same statement batch.
    let stopped: TimeEntryDto | null = null;
    if (input.start) stopped = await stopRunning(tx, targetUserId);

    const id = newId();
    const now = tx.now();

    await tx.db.insert(s.timeEntries).values({
      id,
      userId: targetUserId,
      projectId: input.projectId,
      projectTaskId,
      spentOn,
      startedAt: input.startedAt ? new Date(input.startedAt) : input.start ? now : null,
      endedAt: input.endedAt ? new Date(input.endedAt) : null,
      durationSeconds: input.start ? 0 : Math.max(0, Math.round(input.durationSeconds ?? 0)),
      timerStartedAt: input.start ? now : null,
      notes,
      isBillable,
      billableRateCents: isBillable ? rates.billableRateCents : 0,
      costRateCents: rates.costRateCents,
      source: input.source ?? "web",
      createdBy: ctx.actor.userId,
      updatedBy: ctx.actor.userId,
    });

    tx.audit({
      action: input.start ? "time_entry.start" : "time_entry.create",
      entityType: "time_entry",
      entityId: id,
      entityLabel: project.name,
      after: { spentOn, projectId: input.projectId, durationSeconds: input.durationSeconds ?? 0 },
      override: lock.requiresOverride,
    });
    tx.emit({
      topic: input.start ? "timer.started" : "time_entry.created",
      payload: { entryId: id, userId: targetUserId, projectId: input.projectId },
    });

    return { entry: await getTimeEntry(tx, id), stopped };
  });
}

async function taskIsBillable(ctx: Ctx, projectTaskId: string): Promise<boolean> {
  const [row] = await ctx.db
    .select({ isBillable: s.projectTasks.isBillable })
    .from(s.projectTasks)
    .where(eq(s.projectTasks.id, projectTaskId))
    .limit(1);
  return row?.isBillable ?? false;
}

/* --------------------------------------------------------------- updating */

export interface UpdateTimeEntryInput {
  projectId?: string;
  taskId?: string;
  spentOn?: IsoDate;
  durationSeconds?: number;
  startedAt?: string | null;
  endedAt?: string | null;
  notes?: string | null;
  isBillable?: boolean;
}

export async function updateTimeEntry(ctx: Ctx, id: string, input: UpdateTimeEntryInput): Promise<TimeEntryDto> {
  return withTransaction(ctx, async (tx) => {
    const { entry: before, requiresOverride } = await loadEditable(tx, id);

    const patch: Record<string, unknown> = { updatedAt: tx.now(), updatedBy: tx.actor.userId };

    const projectId = input.projectId ?? before.projectId;
    const spentOn = input.spentOn ?? before.spentOn;

    let projectTaskId = before.projectTaskId;
    if (input.taskId || input.projectId) {
      const taskId = input.taskId ?? (await taskIdOf(tx, before.projectTaskId));
      projectTaskId = await projectTaskFor(tx, projectId, taskId);
      patch.projectId = projectId;
      patch.projectTaskId = projectTaskId;
    }

    if (input.spentOn !== undefined) patch.spentOn = spentOn;
    if (input.durationSeconds !== undefined) {
      patch.durationSeconds = Math.max(0, Math.round(input.durationSeconds));
    }
    if (input.startedAt !== undefined) patch.startedAt = input.startedAt ? new Date(input.startedAt) : null;
    if (input.endedAt !== undefined) patch.endedAt = input.endedAt ? new Date(input.endedAt) : null;
    if (input.notes !== undefined) patch.notes = input.notes?.trim() || null;
    if (input.isBillable !== undefined) patch.isBillable = input.isBillable;

    // Re-resolve rates only when something the rate depends on has moved. An
    // edit to the note must not silently reprice work at today's rate.
    const rateInputsChanged =
      input.projectId !== undefined ||
      input.taskId !== undefined ||
      input.spentOn !== undefined ||
      input.isBillable !== undefined;

    if (rateInputsChanged && before.ratesLockedAt == null) {
      const rates = await resolveForEntry(tx, {
        userId: before.userId,
        projectId,
        projectTaskId,
        spentOn,
      });
      const billable = input.isBillable ?? before.isBillable;
      patch.billableRateCents = billable ? rates.billableRateCents : 0;
      patch.costRateCents = rates.costRateCents;
    }

    const [after] = await tx.db
      .update(s.timeEntries)
      .set(patch as never)
      .where(eq(s.timeEntries.id, id))
      .returning();

    tx.audit({
      action: "time_entry.update",
      entityType: "time_entry",
      entityId: id,
      before,
      after,
      override: requiresOverride,
    });
    tx.emit({ topic: "time_entry.updated", payload: { entryId: id, userId: before.userId } });

    return getTimeEntry(tx, id);
  });
}

async function taskIdOf(ctx: Ctx, projectTaskId: string): Promise<string> {
  const [row] = await ctx.db
    .select({ taskId: s.projectTasks.taskId })
    .from(s.projectTasks)
    .where(eq(s.projectTasks.id, projectTaskId))
    .limit(1);
  if (!row) throw notFound("That task");
  return row.taskId;
}

/* --------------------------------------------------------------- deleting */

export async function deleteTimeEntry(ctx: Ctx, id: string): Promise<void> {
  await withTransaction(ctx, async (tx) => {
    const { entry, requiresOverride } = await loadEditable(tx, id);

    await tx.db
      .update(s.timeEntries)
      .set({ deletedAt: tx.now(), updatedBy: tx.actor.userId })
      .where(eq(s.timeEntries.id, id));

    tx.audit({
      action: "time_entry.delete",
      entityType: "time_entry",
      entityId: id,
      before: entry,
      override: requiresOverride,
    });
    tx.emit({ topic: "time_entry.deleted", payload: { entryId: id, userId: entry.userId } });
  });
}

/** Undo. The row was never really gone, so this is a field flip. */
export async function restoreTimeEntry(ctx: Ctx, id: string): Promise<TimeEntryDto> {
  return withTransaction(ctx, async (tx) => {
    const [row] = await tx.db
      .select()
      .from(s.timeEntries)
      .where(and(eq(s.timeEntries.id, id), timeEntryScope(tx)))
      .limit(1);
    if (!row) throw notFound("That time entry");

    if (row.userId === tx.actor.userId) assertCan(tx, "time:edit_own");
    else if (!(await canActOnBehalfOf(tx, row.userId))) throw forbidden("You cannot restore that entry.");

    await tx.db
      .update(s.timeEntries)
      .set({ deletedAt: null, updatedAt: tx.now(), updatedBy: tx.actor.userId })
      .where(eq(s.timeEntries.id, id));

    tx.audit({ action: "time_entry.restore", entityType: "time_entry", entityId: id, after: row });
    return getTimeEntry(tx, id);
  });
}

/* ---------------------------------------------------------------- timers */

/**
 * Stops whoever's timer is running, returning what it stopped.
 *
 * The addition happens in SQL so the server clock is authoritative: a client
 * with a skewed clock, a sleeping laptop, and a stale tab all produce the same
 * answer.
 */
async function stopRunning(ctx: Ctx, userId: string): Promise<TimeEntryDto | null> {
  const [running] = await ctx.db
    .select({ id: s.timeEntries.id })
    .from(s.timeEntries)
    .where(
      and(
        eq(s.timeEntries.userId, userId),
        sql`${s.timeEntries.timerStartedAt} IS NOT NULL`,
        isNull(s.timeEntries.deletedAt)
      )
    )
    .limit(1);

  if (!running) return null;

  // The elapsed time is computed in SQL, so the server clock is authoritative
  // and a sleeping laptop cannot invent a duration. `ctx.now()` rather than
  // `now()` because both ends of the interval have to come from one clock:
  // mixing them lets an injected test clock produce an entry that ended before
  // it started, which the ordering constraint then rejects.
  const stoppedAt = ctx.now();
  await ctx.db
    .update(s.timeEntries)
    .set({
      durationSeconds: sql`${s.timeEntries.durationSeconds} + GREATEST(0, EXTRACT(EPOCH FROM (${stoppedAt.toISOString()}::timestamptz - ${s.timeEntries.timerStartedAt}))::integer)`,
      endedAt: stoppedAt,
      timerStartedAt: null,
      updatedAt: stoppedAt,
      updatedBy: ctx.actor.userId,
    })
    .where(eq(s.timeEntries.id, running.id));

  ctx.audit({ action: "timer.stop", entityType: "time_entry", entityId: running.id });
  ctx.emit({ topic: "timer.stopped", payload: { entryId: running.id, userId } });

  return getTimeEntry(ctx, running.id);
}

export async function stopTimer(ctx: Ctx, userId?: string): Promise<TimeEntryDto | null> {
  const target = userId ?? ctx.actor.userId;
  if (target !== ctx.actor.userId && !(await canActOnBehalfOf(ctx, target))) {
    throw forbidden("You cannot stop that person's timer.");
  }
  return withTransaction(ctx, async (tx) => stopRunning(tx, target));
}

/**
 * Starts a new timer from an existing entry's project, task, and notes.
 *
 * A new entry rather than resuming the old one: resuming would make today's
 * work land on yesterday's date, and the whole point of `spent_on` never
 * drifting is that a day's total stays a day's total.
 */
export async function startTimerFrom(ctx: Ctx, entryId: string): Promise<CreateResult> {
  const [source] = await ctx.db
    .select({
      userId: s.timeEntries.userId,
      projectId: s.timeEntries.projectId,
      notes: s.timeEntries.notes,
      taskId: s.projectTasks.taskId,
    })
    .from(s.timeEntries)
    .innerJoin(s.projectTasks, eq(s.projectTasks.id, s.timeEntries.projectTaskId))
    .where(and(eq(s.timeEntries.id, entryId), timeEntryScope(ctx)))
    .limit(1);

  if (!source) throw notFound("That time entry");

  return createTimeEntry(ctx, {
    userId: source.userId,
    projectId: source.projectId,
    taskId: source.taskId,
    notes: source.notes,
    start: true,
  });
}

/* ------------------------------------------------------- split, duplicate */

export async function splitTimeEntry(ctx: Ctx, id: string, atSeconds: number): Promise<TimeEntryDto[]> {
  return withTransaction(ctx, async (tx) => {
    const { entry } = await loadEditable(tx, id);

    if (atSeconds <= 0 || atSeconds >= entry.durationSeconds) {
      throw validationFailed({ atSeconds: ["Split at a point inside the entry."] });
    }

    const remainder = entry.durationSeconds - atSeconds;

    await tx.db
      .update(s.timeEntries)
      .set({ durationSeconds: atSeconds, updatedAt: tx.now(), updatedBy: tx.actor.userId })
      .where(eq(s.timeEntries.id, id));

    const newEntryId = newId();
    await tx.db.insert(s.timeEntries).values({
      id: newEntryId,
      userId: entry.userId,
      projectId: entry.projectId,
      projectTaskId: entry.projectTaskId,
      spentOn: entry.spentOn,
      durationSeconds: remainder,
      notes: entry.notes,
      isBillable: entry.isBillable,
      // The split inherits the original's rate snapshot. Re-resolving would
      // reprice half the work at today's rate for no reason.
      billableRateCents: entry.billableRateCents,
      costRateCents: entry.costRateCents,
      createdBy: tx.actor.userId,
      updatedBy: tx.actor.userId,
    });

    tx.audit({ action: "time_entry.split", entityType: "time_entry", entityId: id, after: { atSeconds, newEntryId } });

    return [await getTimeEntry(tx, id), await getTimeEntry(tx, newEntryId)];
  });
}

export async function duplicateTimeEntry(ctx: Ctx, id: string, spentOn?: IsoDate): Promise<TimeEntryDto> {
  const [source] = await ctx.db
    .select({ entry: s.timeEntries, taskId: s.projectTasks.taskId })
    .from(s.timeEntries)
    .innerJoin(s.projectTasks, eq(s.projectTasks.id, s.timeEntries.projectTaskId))
    .where(and(eq(s.timeEntries.id, id), timeEntryScope(ctx)))
    .limit(1);
  if (!source) throw notFound("That time entry");

  const result = await createTimeEntry(ctx, {
    userId: source.entry.userId,
    projectId: source.entry.projectId,
    taskId: source.taskId,
    spentOn: spentOn ?? source.entry.spentOn,
    durationSeconds: source.entry.durationSeconds,
    notes: source.entry.notes,
    isBillable: source.entry.isBillable,
  });
  return result.entry;
}

/* ------------------------------------------------------------- copy a day */

export async function copyDay(
  ctx: Ctx,
  input: { from: IsoDate; to: IsoDate; includeDurations?: boolean; userId?: string }
): Promise<TimeEntryDto[]> {
  const targetUserId = input.userId ?? ctx.actor.userId;
  if (targetUserId !== ctx.actor.userId && !(await canActOnBehalfOf(ctx, targetUserId))) {
    throw forbidden("You cannot copy time for that person.");
  }

  return withTransaction(ctx, async (tx) => {
    const source = await tx.db
      .select({ entry: s.timeEntries, taskId: s.projectTasks.taskId })
      .from(s.timeEntries)
      .innerJoin(s.projectTasks, eq(s.projectTasks.id, s.timeEntries.projectTaskId))
      .where(
        and(
          eq(s.timeEntries.userId, targetUserId),
          eq(s.timeEntries.spentOn, input.from),
          isNull(s.timeEntries.deletedAt),
          isNull(s.timeEntries.timerStartedAt)
        )
      );

    const created: TimeEntryDto[] = [];
    for (const row of source) {
      const result = await createTimeEntry(tx, {
        userId: targetUserId,
        projectId: row.entry.projectId,
        taskId: row.taskId,
        spentOn: input.to,
        durationSeconds: input.includeDurations ? row.entry.durationSeconds : 0,
        notes: row.entry.notes,
        isBillable: row.entry.isBillable,
      });
      created.push(result.entry);
    }

    tx.audit({
      action: "timesheet.copy_day",
      entityType: "time_entry",
      after: { from: input.from, to: input.to, count: created.length },
    });

    return created;
  });
}

/* -------------------------------------------------------------- week grid */

export interface WeekRow {
  projectId: string;
  taskId: string;
  notes?: string | null;
  /** Day to seconds. A zero or missing day removes the entry. */
  days: Record<string, number>;
}

export interface WeekResult {
  entries: TimeEntryDto[];
  /** Rows the write could not touch, with the reason. */
  skipped: { spentOn: string; projectId: string; taskId: string; reasons: string[] }[];
}

/**
 * The week grid, in one round trip.
 *
 * Diffs the incoming grid against what exists for that week and that row key
 * (project + task + notes), then creates, updates, and soft-deletes as needed.
 * Thirty cells would otherwise be thirty requests, and a half-applied week is
 * worse than a slow one.
 *
 * Locked entries are reported in `skipped` rather than failing the whole
 * request: one approved day should not stop somebody filling in the rest.
 */
export async function upsertWeek(
  ctx: Ctx,
  input: { userId?: string; weekStart: IsoDate; rows: WeekRow[] }
): Promise<WeekResult> {
  const targetUserId = input.userId ?? ctx.actor.userId;
  if (targetUserId !== ctx.actor.userId && !(await canActOnBehalfOf(ctx, targetUserId))) {
    throw forbidden("You cannot edit that person's timesheet.");
  }

  return withTransaction(ctx, async (tx) => {
    const days = Array.from({ length: 7 }, (_, i) => addDaysIso(input.weekStart, i));
    const weekEnd = days[6]!;

    const existing = await tx.db
      .select({ entry: s.timeEntries, taskId: s.projectTasks.taskId, invoiceState: s.invoices.state })
      .from(s.timeEntries)
      .innerJoin(s.projectTasks, eq(s.projectTasks.id, s.timeEntries.projectTaskId))
      .leftJoin(s.invoices, eq(s.invoices.id, s.timeEntries.invoiceId))
      .where(
        and(
          eq(s.timeEntries.userId, targetUserId),
          gte(s.timeEntries.spentOn, input.weekStart),
          lte(s.timeEntries.spentOn, weekEnd),
          isNull(s.timeEntries.deletedAt),
          isNull(s.timeEntries.timerStartedAt)
        )
      );

    const lockContext = await editabilityContextFor(tx, [targetUserId]);
    const skipped: WeekResult["skipped"] = [];

    const keyOf = (projectId: string, taskId: string, notes: string | null, day: string) =>
      `${projectId}|${taskId}|${notes ?? ""}|${day}`;

    const existingByKey = new Map(
      existing.map((r) => [keyOf(r.entry.projectId, r.taskId, r.entry.notes, r.entry.spentOn), r])
    );
    const seen = new Set<string>();

    const inWeek = new Set(days);

    for (const row of input.rows) {
      const notes = row.notes?.trim() || null;

      // Only the days the client actually sent. Sweeping all seven and treating
      // an absent one as zero would mean a single-cell save silently deleted the
      // rest of that row, which is exactly what the grid does when it saves on
      // blur. Clearing a cell is an explicit zero, so nothing is lost.
      for (const day of Object.keys(row.days)) {
        if (!inWeek.has(day)) {
          throw validationFailed({ days: [day + " is not in the week starting " + input.weekStart + "."] });
        }
        const seconds = Math.max(0, Math.round(row.days[day] ?? 0));
        const key = keyOf(row.projectId, row.taskId, notes, day);
        seen.add(key);

        const current = existingByKey.get(key);

        if (current) {
          const lock = canEdit(
            {
              spentOn: current.entry.spentOn,
              userId: targetUserId,
              invoiceId: current.entry.invoiceId,
              invoiceState: current.invoiceState,
              billedExternally: current.entry.billedExternally,
            },
            lockContext(targetUserId)
          );
          if (!lock.editable) {
            skipped.push({ spentOn: day, projectId: row.projectId, taskId: row.taskId, reasons: lock.reasons });
            continue;
          }

          if (seconds === 0) {
            await tx.db
              .update(s.timeEntries)
              .set({ deletedAt: tx.now(), updatedBy: tx.actor.userId })
              .where(eq(s.timeEntries.id, current.entry.id));
          } else if (seconds !== current.entry.durationSeconds) {
            await tx.db
              .update(s.timeEntries)
              .set({ durationSeconds: seconds, updatedAt: tx.now(), updatedBy: tx.actor.userId })
              .where(eq(s.timeEntries.id, current.entry.id));
          }
          continue;
        }

        if (seconds > 0) {
          try {
            await createTimeEntry(tx, {
              userId: targetUserId,
              projectId: row.projectId,
              taskId: row.taskId,
              spentOn: day,
              durationSeconds: seconds,
              notes,
            });
          } catch (e) {
            if (e instanceof AppError && (e.code === "period_approved" || e.code === "record_locked")) {
              skipped.push({
                spentOn: day,
                projectId: row.projectId,
                taskId: row.taskId,
                reasons: (e.meta?.reasons as string[]) ?? [e.code],
              });
              continue;
            }
            throw e;
          }
        }
      }
    }

    tx.audit({
      action: "timesheet.week_upsert",
      entityType: "time_entry",
      after: { weekStart: input.weekStart, rows: input.rows.length, skipped: skipped.length },
    });

    const entries = await listTimeEntries(tx, {
      userId: targetUserId,
      from: input.weekStart,
      to: weekEnd,
    });

    return { entries, skipped };
  });
}

/* ---------------------------------------------------------------- summary */

export interface DaySummary {
  spentOn: IsoDate;
  totalSeconds: number;
  billableSeconds: number;
  /** Below the account's threshold on a working day. */
  missing: boolean;
}

export async function timesheetSummary(
  ctx: Ctx,
  input: { from: IsoDate; to: IsoDate; userId?: string }
): Promise<{ days: DaySummary[]; capacitySeconds: number; totalSeconds: number }> {
  const targetUserId = input.userId ?? ctx.actor.userId;

  const rows = await ctx.db
    .select({
      spentOn: s.timeEntries.spentOn,
      totalSeconds: sql<string>`SUM(${s.timeEntries.durationSeconds})::text`,
      billableSeconds: sql<string>`SUM(CASE WHEN ${s.timeEntries.isBillable} THEN ${s.timeEntries.durationSeconds} ELSE 0 END)::text`,
    })
    .from(s.timeEntries)
    .where(
      and(
        eq(s.timeEntries.userId, targetUserId),
        gte(s.timeEntries.spentOn, input.from),
        lte(s.timeEntries.spentOn, input.to),
        isNull(s.timeEntries.deletedAt),
        timeEntryScope(ctx, { requestedUserId: targetUserId })
      )
    )
    .groupBy(s.timeEntries.spentOn)
    .orderBy(asc(s.timeEntries.spentOn));

  const settings = await getSettings(ctx);
  const [user] = await ctx.db
    .select({ weeklyCapacitySeconds: s.users.weeklyCapacitySeconds })
    .from(s.users)
    .where(eq(s.users.id, targetUserId))
    .limit(1);

  const threshold = settings.flagMissingBelowSeconds;
  const today = dayIn(settings.timezone, ctx.now());
  const byDay = new Map(rows.map((r) => [r.spentOn, r]));

  const days: DaySummary[] = [];
  let total = 0;
  for (let day = input.from; day <= input.to; day = addDaysIso(day, 1)) {
    const row = byDay.get(day);
    const totalSeconds = Number(row?.totalSeconds ?? 0);
    total += totalSeconds;
    days.push({
      spentOn: day,
      totalSeconds,
      billableSeconds: Number(row?.billableSeconds ?? 0),
      // Only past working days can be "missing": today is still in progress and
      // a weekend is not a gap.
      missing:
        threshold != null && totalSeconds < threshold && day < today && !isWeekendIso(day),
    });
  }

  return {
    days,
    capacitySeconds: user?.weeklyCapacitySeconds ?? 0,
    totalSeconds: total,
  };
}

/* ------------------------------------------------------------------- util */

function addDaysIso(date: IsoDate, days: number): IsoDate {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isWeekendIso(date: IsoDate): boolean {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  return dow === 0 || dow === 6;
}
