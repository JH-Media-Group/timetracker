/**
 * Scope predicates.
 *
 * Layer two of the three-layer authorization model. The capability gate says
 * *whether* an actor may list time entries; this says *whose*. It returns SQL,
 * composed into the query's WHERE clause, never a filter applied to rows after
 * they are fetched.
 *
 * That distinction is the whole point. Filtering after the fetch means the
 * database returned rows the actor was not entitled to, and every future
 * refactor, aggregate, or count is one forgotten line away from leaking them.
 *
 * Specification: docs/BACKEND_PRD.md section 7.3.
 */

import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import * as s from "@/server/db/schema";
import { othersScopeFor } from "./capabilities";
import type { Ctx } from "@/server/ctx";

/** Always-true and always-false, for composing without special cases. */
const ALWAYS = sql`true`;
const NEVER = sql`false`;

export type Reach = "none" | "team" | "all";

export function reachOf(ctx: Ctx): Reach {
  if (ctx.actor.kind === "system") return "all";
  return othersScopeFor(ctx.actor.baseKey);
}

/**
 * The set of user ids an actor may see records for.
 *
 * `team` resolves through two routes, unioned: people explicitly assigned to
 * them in `user_managed_users`, and people on projects they manage. A project
 * manager who is not anybody's line manager still needs to review the time
 * logged against their project.
 */
export function visibleUserIds(ctx: Ctx): SQL {
  const me = ctx.actor.userId;
  switch (reachOf(ctx)) {
    case "all":
      return sql`(SELECT id FROM ${s.users})`;
    case "team":
      return sql`(
        SELECT ${s.users.id} FROM ${s.users} WHERE ${s.users.id} = ${me}
        UNION
        SELECT managed_id FROM ${s.userManagedUsers} WHERE manager_id = ${me}
        UNION
        SELECT pm.user_id FROM ${s.projectMembers} pm
        WHERE pm.archived_at IS NULL
          AND pm.project_id IN (
            SELECT project_id FROM ${s.projectMembers}
            WHERE user_id = ${me} AND is_manager AND archived_at IS NULL
          )
      )`;
    default:
      return sql`(SELECT ${sql.raw(`'${me}'::uuid`)})`;
  }
}

/** Restricts a query to time entries the actor may see. */
export function timeEntryScope(ctx: Ctx, opts: { requestedUserId?: string | null } = {}): SQL {
  const me = ctx.actor.userId;

  // Asking for your own records never needs a capability.
  if (opts.requestedUserId && opts.requestedUserId === me) {
    return eq(s.timeEntries.userId, me);
  }

  const reach = reachOf(ctx);
  const canViewOthers = ctx.actor.kind === "system" || ctx.actor.capabilities.has("time:view_others");

  if (!canViewOthers) return eq(s.timeEntries.userId, me);
  if (reach === "all") return ALWAYS;

  return or(eq(s.timeEntries.userId, me), sql`${s.timeEntries.userId} IN ${visibleUserIds(ctx)}`)!;
}

/** Restricts a query to expenses the actor may see. Same shape as time. */
export function expenseScope(ctx: Ctx, opts: { requestedUserId?: string | null } = {}): SQL {
  const me = ctx.actor.userId;
  if (opts.requestedUserId && opts.requestedUserId === me) return eq(s.expenses.userId, me);

  const canViewOthers =
    ctx.actor.kind === "system" ||
    ctx.actor.capabilities.has("expense:view_others") ||
    ctx.actor.capabilities.has("expense:manage");

  if (!canViewOthers) return eq(s.expenses.userId, me);
  if (reachOf(ctx) === "all") return ALWAYS;

  return or(eq(s.expenses.userId, me), sql`${s.expenses.userId} IN ${visibleUserIds(ctx)}`)!;
}

/**
 * Restricts a query to projects the actor may see.
 *
 * Everyone can see the projects they are assigned to. `project:view` on its own
 * does not open the whole account: without a management capability an actor
 * sees their own assignments, which is what makes the project picker safe.
 */
export function projectScope(ctx: Ctx): SQL {
  if (ctx.actor.kind === "system") return ALWAYS;

  const wide =
    ctx.actor.capabilities.has("project:manage") ||
    ctx.actor.capabilities.has("report:view_all") ||
    ctx.actor.capabilities.has("invoice:manage") ||
    ctx.actor.capabilities.has("people:manage");

  if (wide) return ALWAYS;

  return sql`${s.projects.id} IN (
    SELECT project_id FROM ${s.projectMembers}
    WHERE user_id = ${ctx.actor.userId} AND archived_at IS NULL
  )`;
}

/** Restricts a query to clients the actor may see, through their projects. */
export function clientScope(ctx: Ctx): SQL {
  if (ctx.actor.kind === "system") return ALWAYS;

  const wide =
    ctx.actor.capabilities.has("client:manage") ||
    ctx.actor.capabilities.has("project:manage") ||
    ctx.actor.capabilities.has("invoice:manage") ||
    ctx.actor.capabilities.has("report:view_all");

  if (wide) return ALWAYS;

  return sql`${s.clients.id} IN (
    SELECT p.client_id FROM ${s.projects} p
    JOIN ${s.projectMembers} pm ON pm.project_id = p.id
    WHERE pm.user_id = ${ctx.actor.userId} AND pm.archived_at IS NULL
  )`;
}

/** Restricts a query to invoices the actor may see. */
export function invoiceScope(ctx: Ctx): SQL {
  if (ctx.actor.kind === "system") return ALWAYS;
  if (ctx.actor.capabilities.has("invoice:view") || ctx.actor.capabilities.has("invoice:manage")) return ALWAYS;
  return NEVER;
}

/** Restricts a query to people the actor may see. Everyone can see the roster. */
export function userScope(ctx: Ctx): SQL {
  if (ctx.actor.kind === "system") return ALWAYS;
  if (ctx.actor.capabilities.has("people:view")) return ALWAYS;
  return eq(s.users.id, ctx.actor.userId);
}

/** Restricts approvals to submissions the actor may review. */
export function approvalScope(ctx: Ctx): SQL {
  if (ctx.actor.kind === "system") return ALWAYS;

  const me = ctx.actor.userId;
  if (ctx.actor.capabilities.has("approval:review_all")) return ALWAYS;
  if (ctx.actor.capabilities.has("approval:review")) {
    return or(eq(s.timesheetSubmissions.userId, me), sql`${s.timesheetSubmissions.userId} IN ${visibleUserIds(ctx)}`)!;
  }
  return eq(s.timesheetSubmissions.userId, me);
}

/* ------------------------------------------------------ imperative checks */

/**
 * May the actor create or change time on behalf of this person?
 *
 * Used where a scope predicate cannot be: a write names one target, so the
 * question is a yes or no rather than a filter.
 */
export async function canActOnBehalfOf(ctx: Ctx, targetUserId: string): Promise<boolean> {
  if (ctx.actor.kind === "system") return true;
  if (targetUserId === ctx.actor.userId) return true;
  if (!ctx.actor.capabilities.has("time:edit_others")) return false;

  const reach = reachOf(ctx);
  if (reach === "all") return true;
  if (reach === "none") return false;

  const rows = await ctx.db.execute<{ ok: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM ${s.userManagedUsers}
      WHERE manager_id = ${ctx.actor.userId} AND managed_id = ${targetUserId}
      UNION ALL
      SELECT 1 FROM ${s.projectMembers} theirs
      JOIN ${s.projectMembers} mine
        ON mine.project_id = theirs.project_id AND mine.is_manager AND mine.archived_at IS NULL
      WHERE theirs.user_id = ${targetUserId} AND theirs.archived_at IS NULL
        AND mine.user_id = ${ctx.actor.userId}
    ) AS ok
  `);
  return Boolean((rows as unknown as { ok: boolean }[])[0]?.ok);
}

/** Is the actor a manager of this project? */
export async function isProjectManager(ctx: Ctx, projectId: string): Promise<boolean> {
  if (ctx.actor.kind === "system") return true;
  if (ctx.actor.capabilities.has("project:manage")) return true;

  const rows = await ctx.db
    .select({ id: s.projectMembers.id })
    .from(s.projectMembers)
    .where(
      and(
        eq(s.projectMembers.projectId, projectId),
        eq(s.projectMembers.userId, ctx.actor.userId),
        eq(s.projectMembers.isManager, true)
      )
    )
    .limit(1);
  return rows.length > 0;
}

/** Is the actor assigned to this project at all? */
export async function isProjectMember(ctx: Ctx, projectId: string): Promise<boolean> {
  if (ctx.actor.kind === "system") return true;
  const rows = await ctx.db
    .select({ id: s.projectMembers.id })
    .from(s.projectMembers)
    .where(and(eq(s.projectMembers.projectId, projectId), eq(s.projectMembers.userId, ctx.actor.userId)))
    .limit(1);
  return rows.length > 0;
}

export { ALWAYS, NEVER, and, or, eq, inArray };
