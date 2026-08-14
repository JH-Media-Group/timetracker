/**
 * Projects.
 *
 * A project decides how its time is billed, budgeted, and reported, so this is
 * where most of the validation lives. The rules that catch people:
 *
 *   - the budget amount has to match the budget type. An hours budget with a
 *     fee amount is not a warning, it is a rejected write.
 *   - a task can only be removed from a project while nothing has been tracked
 *     against it, otherwise the hours lose their task.
 *   - archiving cascades to nothing. Archived projects keep their tasks,
 *     members, and history, so unarchiving restores the whole thing.
 */

import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { assertCan, withTransaction, type Ctx } from "@/server/ctx";
import * as s from "@/server/db/schema";
import { newId } from "@/server/db/ids";
import { clientScope, projectScope } from "@/server/auth/scope";
import { AppError, notFound, validationFailed } from "@/server/errors";
import { serializeProject, type ProjectDto } from "@/server/serialize";
import { validateBudgetShape, type BudgetBy } from "@/domain/budgets";
import { commonTaskIds } from "./tasks";

export interface ProjectInput {
  clientId: string;
  name: string;
  code?: string | null;
  billingType: "time_and_materials" | "fixed_fee" | "non_billable";
  billBy?: "project" | "tasks" | "people" | "none";
  hourlyRateCents?: number | null;
  feeCents?: number | null;
  feeCadence?: "single" | "monthly" | null;
  budgetBy?: BudgetBy;
  budgetSeconds?: number | null;
  budgetFeeCents?: number | null;
  budgetResetsMonthly?: boolean;
  budgetAlertPercent?: number | null;
  startsOn?: string | null;
  endsOn?: string | null;
  notes?: string | null;
  reportVisibility?: "managers" | "everyone";
  tags?: string[];
  taskIds?: string[];
  memberIds?: string[];
  managerIds?: string[];
}

/* -------------------------------------------------------------------- read */

export async function listProjects(
  ctx: Ctx,
  opts: { includeArchived?: boolean; archivedOnly?: boolean; clientId?: string } = {}
): Promise<ProjectDto[]> {
  const conditions = [projectScope(ctx)];
  if (opts.archivedOnly) conditions.push(sql`${s.projects.archivedAt} IS NOT NULL`);
  else if (!opts.includeArchived) conditions.push(isNull(s.projects.archivedAt));
  if (opts.clientId) conditions.push(eq(s.projects.clientId, opts.clientId));

  const rows = await ctx.db
    .select()
    .from(s.projects)
    .where(and(...conditions))
    .orderBy(asc(s.projects.name));

  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const [tasks, members, tags] = await Promise.all([
    ctx.db
      .select({ projectId: s.projectTasks.projectId, taskId: s.projectTasks.taskId })
      .from(s.projectTasks)
      .where(and(inArray(s.projectTasks.projectId, ids), isNull(s.projectTasks.archivedAt))),
    ctx.db
      .select({
        projectId: s.projectMembers.projectId,
        userId: s.projectMembers.userId,
        isManager: s.projectMembers.isManager,
      })
      .from(s.projectMembers)
      .where(and(inArray(s.projectMembers.projectId, ids), isNull(s.projectMembers.archivedAt))),
    ctx.db
      .select({ projectId: s.projectTags.projectId, name: s.tags.name })
      .from(s.projectTags)
      .innerJoin(s.tags, eq(s.tags.id, s.projectTags.tagId))
      .where(inArray(s.projectTags.projectId, ids)),
  ]);

  const group = <T, K extends keyof T>(rows: T[], key: K, pick: (r: T) => string) => {
    const map = new Map<string, string[]>();
    for (const r of rows) {
      const k = String(r[key]);
      const list = map.get(k);
      if (list) list.push(pick(r));
      else map.set(k, [pick(r)]);
    }
    return map;
  };

  const taskMap = group(tasks, "projectId", (r) => r.taskId);
  const memberMap = group(members, "projectId", (r) => r.userId);
  const managerMap = group(members.filter((m) => m.isManager), "projectId", (r) => r.userId);
  const tagMap = group(tags, "projectId", (r) => r.name);

  return rows.map((r) =>
    serializeProject(ctx, r, {
      taskIds: taskMap.get(r.id) ?? [],
      memberIds: memberMap.get(r.id) ?? [],
      managerIds: managerMap.get(r.id) ?? [],
      tags: tagMap.get(r.id) ?? [],
    })
  );
}

export async function getProject(ctx: Ctx, id: string): Promise<ProjectDto> {
  const [row] = await ctx.db
    .select()
    .from(s.projects)
    .where(and(eq(s.projects.id, id), projectScope(ctx)))
    .limit(1);
  if (!row) throw notFound("That project");

  const [tasks, members, tags] = await Promise.all([
    ctx.db
      .select({ taskId: s.projectTasks.taskId })
      .from(s.projectTasks)
      .where(and(eq(s.projectTasks.projectId, id), isNull(s.projectTasks.archivedAt))),
    ctx.db
      .select({ userId: s.projectMembers.userId, isManager: s.projectMembers.isManager })
      .from(s.projectMembers)
      .where(and(eq(s.projectMembers.projectId, id), isNull(s.projectMembers.archivedAt))),
    ctx.db
      .select({ name: s.tags.name })
      .from(s.projectTags)
      .innerJoin(s.tags, eq(s.tags.id, s.projectTags.tagId))
      .where(eq(s.projectTags.projectId, id)),
  ]);

  return serializeProject(ctx, row, {
    taskIds: tasks.map((t) => t.taskId),
    memberIds: members.map((m) => m.userId),
    managerIds: members.filter((m) => m.isManager).map((m) => m.userId),
    tags: tags.map((t) => t.name),
  });
}

/* ------------------------------------------------------------------- write */

function validate(input: Partial<ProjectInput>) {
  const errors: Record<string, string[]> = {};

  if (input.name !== undefined && !input.name.trim()) errors.name = ["A project needs a name."];

  if (input.budgetBy) {
    const shape = validateBudgetShape({
      by: input.budgetBy,
      budgetSeconds: input.budgetSeconds ?? null,
      budgetFeeCents: input.budgetFeeCents ?? null,
    });
    if (!shape.ok) errors[shape.field] = [shape.message];
  }

  if (input.billingType === "fixed_fee" && input.feeCents != null && input.feeCents < 0) {
    errors.feeCents = ["A fee cannot be negative."];
  }
  if (input.startsOn && input.endsOn && input.startsOn > input.endsOn) {
    errors.endsOn = ["The end date is before the start date."];
  }
  if (input.billingType === "non_billable" && input.billBy && input.billBy !== "none") {
    errors.billBy = ["A non-billable project has nothing to bill by."];
  }

  if (Object.keys(errors).length) throw validationFailed(errors);
}

export async function createProject(ctx: Ctx, input: ProjectInput): Promise<ProjectDto> {
  assertCan(ctx, "project:manage");
  validate(input);

  return withTransaction(ctx, async (tx) => {
    const [client] = await tx.db
      .select({ id: s.clients.id })
      .from(s.clients)
      .where(eq(s.clients.id, input.clientId))
      .limit(1);
    if (!client) throw validationFailed({ clientId: ["That client does not exist."] });

    const id = newId();
    await tx.db.insert(s.projects).values({
      id,
      clientId: input.clientId,
      name: input.name.trim(),
      code: input.code ?? null,
      billingType: input.billingType,
      billBy: input.billingType === "non_billable" ? "none" : (input.billBy ?? "people"),
      hourlyRateCents: input.hourlyRateCents ?? null,
      feeCents: input.billingType === "fixed_fee" ? (input.feeCents ?? null) : null,
      feeCadence: input.billingType === "fixed_fee" ? (input.feeCadence ?? "single") : null,
      budgetBy: input.budgetBy ?? "none",
      budgetSeconds: input.budgetSeconds ?? null,
      budgetFeeCents: input.budgetFeeCents ?? null,
      budgetResetsMonthly: input.budgetResetsMonthly ?? false,
      budgetAlertPercent: input.budgetAlertPercent == null ? null : String(input.budgetAlertPercent),
      startsOn: input.startsOn ?? null,
      endsOn: input.endsOn ?? null,
      notes: input.notes ?? null,
      reportVisibility: input.reportVisibility ?? "managers",
      createdBy: tx.actor.userId,
      updatedBy: tx.actor.userId,
    });

    // A new project starts with the common tasks unless the caller named a set.
    const taskIds = input.taskIds ?? (await commonTaskIds(tx));
    await setTasks(tx, id, taskIds);
    await setMembers(tx, id, input.memberIds ?? [], input.managerIds ?? []);
    if (input.tags?.length) await setTags(tx, id, input.tags);

    tx.audit({ action: "project.create", entityType: "project", entityId: id, entityLabel: input.name, after: input });
    tx.emit({ topic: "project.created", payload: { projectId: id, clientId: input.clientId } });

    return getProject(tx, id);
  });
}

export async function updateProject(ctx: Ctx, id: string, input: Partial<ProjectInput>): Promise<ProjectDto> {
  assertCan(ctx, "project:manage");

  return withTransaction(ctx, async (tx) => {
    const before = await getProject(tx, id);
    const [current] = await tx.db.select().from(s.projects).where(eq(s.projects.id, id)).limit(1);
    if (!current) throw notFound("That project");

    // Validate against the merged shape, not the patch alone: changing
    // budget_by without resending the amount has to be checked together.
    validate({
      ...({
        billingType: current.billingType as ProjectInput["billingType"],
        budgetBy: current.budgetBy as BudgetBy,
        budgetSeconds: current.budgetSeconds,
        budgetFeeCents: current.budgetFeeCents,
        startsOn: current.startsOn,
        endsOn: current.endsOn,
      } as Partial<ProjectInput>),
      ...input,
    });

    const patch: Record<string, unknown> = { updatedAt: tx.now(), updatedBy: tx.actor.userId };
    const assign = (key: keyof ProjectInput, column: string, transform?: (v: unknown) => unknown) => {
      if (input[key] !== undefined) patch[column] = transform ? transform(input[key]) : input[key];
    };

    if (input.name !== undefined) patch.name = input.name.trim();

    // Re-parenting a project is allowed, but only to a client that exists and
    // that the actor can see, and never once it has been invoiced: the invoice
    // was raised against the old client, and moving it silently detaches the
    // history from the party that was billed.
    if (input.clientId !== undefined && input.clientId !== current.clientId) {
      const [destination] = await tx.db
        .select({ id: s.clients.id })
        .from(s.clients)
        .where(and(eq(s.clients.id, input.clientId), clientScope(tx)))
        .limit(1);
      if (!destination) throw validationFailed({ clientId: ["That client does not exist."] });

      const [invoiced] = await tx.db
        .select({ invoiceId: s.invoiceProjects.invoiceId })
        .from(s.invoiceProjects)
        .where(eq(s.invoiceProjects.projectId, id))
        .limit(1);
      if (invoiced) {
        throw new AppError(
          "conflict",
          "This project has been invoiced, so it cannot be moved to another client."
        );
      }
      patch.clientId = input.clientId;
    }

    assign("code", "code");
    assign("billingType", "billingType");
    assign("billBy", "billBy");
    assign("hourlyRateCents", "hourlyRateCents");
    assign("feeCents", "feeCents");
    assign("feeCadence", "feeCadence");
    assign("budgetBy", "budgetBy");
    assign("budgetSeconds", "budgetSeconds");
    assign("budgetFeeCents", "budgetFeeCents");
    assign("budgetResetsMonthly", "budgetResetsMonthly");
    assign("budgetAlertPercent", "budgetAlertPercent", (v) => (v == null ? null : String(v)));
    assign("startsOn", "startsOn");
    assign("endsOn", "endsOn");
    assign("notes", "notes");
    assign("reportVisibility", "reportVisibility");

    // Switching to non-billable clears the billing configuration, so a project
    // cannot carry a rate it will never apply.
    if (input.billingType === "non_billable") {
      patch.billBy = "none";
      patch.hourlyRateCents = null;
      patch.feeCents = null;
      patch.feeCadence = null;
    }

    await tx.db.update(s.projects).set(patch as never).where(eq(s.projects.id, id));

    if (input.taskIds) await setTasks(tx, id, input.taskIds);
    if (input.memberIds || input.managerIds) {
      await setMembers(tx, id, input.memberIds ?? before.memberIds, input.managerIds ?? before.managerIds);
    }
    if (input.tags) await setTags(tx, id, input.tags);

    const after = await getProject(tx, id);
    tx.audit({ action: "project.update", entityType: "project", entityId: id, entityLabel: after.name, before, after });

    return after;
  });
}

export async function archiveProject(ctx: Ctx, id: string, archived: boolean): Promise<ProjectDto> {
  assertCan(ctx, archived ? "project:archive" : "project:manage");

  return withTransaction(ctx, async (tx) => {
    const before = await getProject(tx, id);

    if (archived) {
      // A running timer on a project that is about to be archived would be
      // stranded: it cannot be stopped from a project nobody can open.
      const running = await tx.db
        .select({ id: s.timeEntries.id })
        .from(s.timeEntries)
        .where(
          and(
            eq(s.timeEntries.projectId, id),
            sql`${s.timeEntries.timerStartedAt} IS NOT NULL`,
            isNull(s.timeEntries.deletedAt)
          )
        );
      if (running.length > 0) {
        throw new AppError(
          "archive_blocked",
          `${running.length} ${running.length === 1 ? "timer is" : "timers are"} still running on this project.`,
          { meta: { runningEntryIds: running.map((r) => r.id) } }
        );
      }
    }

    await tx.db
      .update(s.projects)
      .set({ archivedAt: archived ? tx.now() : null, updatedAt: tx.now(), updatedBy: tx.actor.userId })
      .where(eq(s.projects.id, id));

    const after = await getProject(tx, id);
    tx.audit({
      action: archived ? "project.archive" : "project.restore",
      entityType: "project",
      entityId: id,
      entityLabel: after.name,
      before,
      after,
    });
    tx.emit({ topic: archived ? "project.archived" : "project.restored", payload: { projectId: id } });

    return after;
  });
}

/* ------------------------------------------------------- tasks and members */

/**
 * Sets the project's task list.
 *
 * Removing a task that has tracked time would orphan those hours, so a task
 * with history is archived on the project rather than deleted, and stays
 * visible in reports.
 */
export async function setTasks(ctx: Ctx, projectId: string, taskIds: string[]) {
  const existing = await ctx.db
    .select({ id: s.projectTasks.id, taskId: s.projectTasks.taskId, archivedAt: s.projectTasks.archivedAt })
    .from(s.projectTasks)
    .where(eq(s.projectTasks.projectId, projectId));

  const wanted = new Set(taskIds);
  const have = new Map(existing.map((e) => [e.taskId, e]));

  const toAdd = taskIds.filter((t) => !have.has(t));
  if (toAdd.length) {
    const defaults = await ctx.db
      .select({ id: s.tasks.id, billable: s.tasks.isDefaultBillable })
      .from(s.tasks)
      .where(inArray(s.tasks.id, toAdd));
    const billableById = new Map(defaults.map((d) => [d.id, d.billable]));

    await ctx.db.insert(s.projectTasks).values(
      toAdd.map((taskId) => ({
        id: newId(),
        projectId,
        taskId,
        isBillable: billableById.get(taskId) ?? true,
      }))
    );
  }

  // Anything previously archived that is wanted again comes back.
  const toRestore = existing.filter((e) => wanted.has(e.taskId) && e.archivedAt);
  if (toRestore.length) {
    await ctx.db
      .update(s.projectTasks)
      .set({ archivedAt: null })
      .where(inArray(s.projectTasks.id, toRestore.map((e) => e.id)));
  }

  const toRemove = existing.filter((e) => !wanted.has(e.taskId) && !e.archivedAt);
  if (toRemove.length) {
    const ids = toRemove.map((e) => e.id);
    const used = await ctx.db
      .select({ projectTaskId: s.timeEntries.projectTaskId })
      .from(s.timeEntries)
      .where(and(inArray(s.timeEntries.projectTaskId, ids), isNull(s.timeEntries.deletedAt)))
      .groupBy(s.timeEntries.projectTaskId);

    const usedIds = new Set(used.map((u) => u.projectTaskId));
    const archivable = ids.filter((id) => usedIds.has(id));
    const deletable = ids.filter((id) => !usedIds.has(id));

    if (archivable.length) {
      await ctx.db
        .update(s.projectTasks)
        .set({ archivedAt: ctx.now() })
        .where(inArray(s.projectTasks.id, archivable));
    }
    if (deletable.length) {
      await ctx.db.delete(s.projectTasks).where(inArray(s.projectTasks.id, deletable));
    }
  }
}

export async function setMembers(ctx: Ctx, projectId: string, memberIds: string[], managerIds: string[]) {
  const wanted = new Set([...memberIds, ...managerIds]);
  const managers = new Set(managerIds);

  const existing = await ctx.db
    .select({ id: s.projectMembers.id, userId: s.projectMembers.userId, archivedAt: s.projectMembers.archivedAt })
    .from(s.projectMembers)
    .where(eq(s.projectMembers.projectId, projectId));

  const have = new Map(existing.map((e) => [e.userId, e]));

  const toAdd = [...wanted].filter((u) => !have.has(u));
  if (toAdd.length) {
    await ctx.db.insert(s.projectMembers).values(
      toAdd.map((userId) => ({ id: newId(), projectId, userId, isManager: managers.has(userId) }))
    );
  }

  for (const e of existing) {
    if (wanted.has(e.userId)) {
      await ctx.db
        .update(s.projectMembers)
        .set({ isManager: managers.has(e.userId), archivedAt: null, updatedAt: ctx.now() })
        .where(eq(s.projectMembers.id, e.id));
    } else if (!e.archivedAt) {
      // Archived, never deleted: their tracked hours still point at this
      // project, and reports group by member.
      await ctx.db
        .update(s.projectMembers)
        .set({ archivedAt: ctx.now(), updatedAt: ctx.now() })
        .where(eq(s.projectMembers.id, e.id));
    }
  }
}

export async function setTags(ctx: Ctx, projectId: string, names: string[]) {
  const cleaned = [...new Set(names.map((n) => n.trim()).filter(Boolean))];

  await ctx.db.delete(s.projectTags).where(eq(s.projectTags.projectId, projectId));
  if (cleaned.length === 0) return;

  const existing = await ctx.db.select().from(s.tags).where(inArray(s.tags.name, cleaned));
  const byName = new Map(existing.map((t) => [t.name, t.id]));

  const missing = cleaned.filter((n) => !byName.has(n));
  if (missing.length) {
    const created = await ctx.db
      .insert(s.tags)
      .values(missing.map((name) => ({ id: newId(), name })))
      .onConflictDoNothing()
      .returning({ id: s.tags.id, name: s.tags.name });
    for (const t of created) byName.set(t.name, t.id);

    // onConflictDoNothing returns nothing for rows that raced; re-read those.
    const stillMissing = missing.filter((n) => !byName.has(n));
    if (stillMissing.length) {
      const found = await ctx.db.select().from(s.tags).where(inArray(s.tags.name, stillMissing));
      for (const t of found) byName.set(t.name, t.id);
    }
  }

  await ctx.db
    .insert(s.projectTags)
    .values(cleaned.map((name) => ({ projectId, tagId: byName.get(name)! })).filter((v) => v.tagId))
    .onConflictDoNothing();
}

/* ------------------------------------------------------------------- pins */

export async function pinProject(ctx: Ctx, projectId: string, pinned: boolean) {
  if (pinned) {
    await ctx.db
      .insert(s.userPinnedProjects)
      .values({ userId: ctx.actor.userId, projectId })
      .onConflictDoNothing();
  } else {
    await ctx.db
      .delete(s.userPinnedProjects)
      .where(and(eq(s.userPinnedProjects.userId, ctx.actor.userId), eq(s.userPinnedProjects.projectId, projectId)));
  }
}

export async function pinnedProjectIds(ctx: Ctx): Promise<string[]> {
  const rows = await ctx.db
    .select({ projectId: s.userPinnedProjects.projectId })
    .from(s.userPinnedProjects)
    .where(eq(s.userPinnedProjects.userId, ctx.actor.userId));
  return rows.map((r) => r.projectId);
}

/**
 * The project_task row for a (project, task) pair.
 *
 * The front end works in task ids because that is what a person picks; the
 * database works in project_task ids because that is where the rate and the
 * budget live. This is the translation, and it is where "that task is not on
 * this project" is caught.
 */
export async function projectTaskFor(ctx: Ctx, projectId: string, taskId: string): Promise<string> {
  const [row] = await ctx.db
    .select({ id: s.projectTasks.id })
    .from(s.projectTasks)
    .where(
      and(
        eq(s.projectTasks.projectId, projectId),
        eq(s.projectTasks.taskId, taskId),
        isNull(s.projectTasks.archivedAt)
      )
    )
    .limit(1);

  if (!row) throw validationFailed({ taskId: ["That task is not available on this project."] });
  return row.id;
}
