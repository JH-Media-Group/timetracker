/**
 * The task library.
 *
 * One shared list; projects draw from it. The rule worth knowing is
 * common-task propagation: a task marked `is_common` is added to every project
 * created *afterwards*, and marking an existing task common offers to add it to
 * live projects as a separate, explicit action rather than doing it silently.
 * Retroactively adding a task to four hundred projects is not something to do
 * as a side effect of a checkbox.
 */

import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { assertCan, withTransaction, type Ctx } from "@/server/ctx";
import * as s from "@/server/db/schema";
import { newId } from "@/server/db/ids";
import { AppError, notFound, validationFailed } from "@/server/errors";
import { canSeeBillable } from "@/server/serialize";

export interface TaskDto {
  id: string;
  name: string;
  defaultBillable: boolean;
  isCommon: boolean;
  defaultHourlyRateCents: number | null;
  archivedAt: string | null;
}

/**
 * A task's default rate is money, like every other rate in the system.
 *
 * It is null throughout the seed, so nothing leaked, but `serializeProject` is
 * careful about exactly this kind of value and this was not. The `ctx` argument
 * is what makes the omission visible next time somebody adds a field.
 */
const toDto = (ctx: Ctx, row: s.TaskRow): TaskDto => ({
  id: row.id,
  name: row.name,
  defaultBillable: row.isDefaultBillable,
  isCommon: row.isCommon,
  defaultHourlyRateCents: canSeeBillable(ctx) ? row.defaultHourlyRateCents : null,
  archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
});

export async function listTasks(ctx: Ctx, opts: { includeArchived?: boolean } = {}): Promise<TaskDto[]> {
  const rows = await ctx.db
    .select()
    .from(s.tasks)
    .where(opts.includeArchived ? undefined : isNull(s.tasks.archivedAt))
    .orderBy(asc(s.tasks.name));
  return rows.map((row) => toDto(ctx, row));
}

export async function createTask(
  ctx: Ctx,
  input: { name: string; defaultBillable?: boolean; isCommon?: boolean; defaultHourlyRateCents?: number | null }
): Promise<TaskDto> {
  assertCan(ctx, "task:manage");
  const name = input.name.trim();
  if (!name) throw validationFailed({ name: ["A task needs a name."] });

  const id = newId();
  await ctx.db.insert(s.tasks).values({
    id,
    name,
    isDefaultBillable: input.defaultBillable ?? true,
    isCommon: input.isCommon ?? false,
    defaultHourlyRateCents: input.defaultHourlyRateCents ?? null,
    createdBy: ctx.actor.userId,
    updatedBy: ctx.actor.userId,
  });

  ctx.audit({ action: "task.create", entityType: "task", entityId: id, entityLabel: name, after: input });

  const [row] = await ctx.db.select().from(s.tasks).where(eq(s.tasks.id, id)).limit(1);
  return toDto(ctx, row!);
}

export async function updateTask(
  ctx: Ctx,
  id: string,
  input: Partial<{ name: string; defaultBillable: boolean; isCommon: boolean; defaultHourlyRateCents: number | null; archived: boolean }>
): Promise<TaskDto> {
  assertCan(ctx, "task:manage");

  const [before] = await ctx.db.select().from(s.tasks).where(eq(s.tasks.id, id)).limit(1);
  if (!before) throw notFound("That task");

  const patch: Record<string, unknown> = { updatedAt: ctx.now(), updatedBy: ctx.actor.userId };
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw validationFailed({ name: ["A task needs a name."] });
    patch.name = name;
  }
  if (input.defaultBillable !== undefined) patch.isDefaultBillable = input.defaultBillable;
  if (input.isCommon !== undefined) patch.isCommon = input.isCommon;
  if (input.defaultHourlyRateCents !== undefined) patch.defaultHourlyRateCents = input.defaultHourlyRateCents;
  if (input.archived !== undefined) patch.archivedAt = input.archived ? ctx.now() : null;

  const [after] = await ctx.db.update(s.tasks).set(patch as never).where(eq(s.tasks.id, id)).returning();

  ctx.audit({
    action: input.archived !== undefined ? (input.archived ? "task.archive" : "task.restore") : "task.update",
    entityType: "task",
    entityId: id,
    entityLabel: after!.name,
    before,
    after,
  });

  return toDto(ctx, after!);
}

/**
 * Hard delete, allowed only while nothing references the task.
 *
 * Time entries reference `project_tasks`, which reference `tasks`, so a task
 * with any history cannot be deleted without orphaning hours. Archive is the
 * answer, and the error says so.
 */
export async function deleteTask(ctx: Ctx, id: string): Promise<void> {
  assertCan(ctx, "task:manage");

  const [{ count }] = (await ctx.db.execute<{ count: string }>(sql`
    SELECT COUNT(*)::text AS count
    FROM ${s.timeEntries} te
    JOIN ${s.projectTasks} pt ON pt.id = te.project_task_id
    WHERE pt.task_id = ${id} AND te.deleted_at IS NULL
  `)) as unknown as { count: string }[];

  if (Number(count) > 0) {
    throw new AppError(
      "archive_blocked",
      `That task has ${count} time entries against it. Archive it instead, so the history stays intact.`,
      { meta: { entryCount: Number(count) } }
    );
  }

  const [before] = await ctx.db.select().from(s.tasks).where(eq(s.tasks.id, id)).limit(1);
  if (!before) throw notFound("That task");

  await ctx.db.delete(s.projectTasks).where(eq(s.projectTasks.taskId, id));
  await ctx.db.delete(s.tasks).where(eq(s.tasks.id, id));

  ctx.audit({ action: "task.delete", entityType: "task", entityId: id, entityLabel: before.name, before });
}

/** The tasks a new project starts with. */
export async function commonTaskIds(ctx: Ctx): Promise<string[]> {
  const rows = await ctx.db
    .select({ id: s.tasks.id })
    .from(s.tasks)
    .where(and(eq(s.tasks.isCommon, true), isNull(s.tasks.archivedAt)));
  return rows.map((r) => r.id);
}

/**
 * Adds a task to every active project that does not already have it.
 *
 * An explicit action, never a side effect of marking a task common: it can
 * touch hundreds of projects, and it should be something somebody chose.
 */
export async function propagateToActiveProjects(ctx: Ctx, taskId: string): Promise<number> {
  assertCan(ctx, "task:manage");

  return withTransaction(ctx, async (tx) => {
    const projects = await tx.db
      .select({ id: s.projects.id })
      .from(s.projects)
      .where(
        and(
          isNull(s.projects.archivedAt),
          sql`NOT EXISTS (
            SELECT 1 FROM ${s.projectTasks} pt
            WHERE pt.project_id = ${s.projects.id} AND pt.task_id = ${taskId}
          )`
        )
      );

    if (projects.length === 0) return 0;

    const [task] = await tx.db.select().from(s.tasks).where(eq(s.tasks.id, taskId)).limit(1);
    if (!task) throw notFound("That task");

    await tx.db.insert(s.projectTasks).values(
      projects.map((p) => ({
        id: newId(),
        projectId: p.id,
        taskId,
        isBillable: task.isDefaultBillable,
      }))
    );

    tx.audit({
      action: "task.propagate",
      entityType: "task",
      entityId: taskId,
      entityLabel: task.name,
      after: { projectCount: projects.length },
    });

    return projects.length;
  });
}
