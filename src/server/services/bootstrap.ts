/**
 * The app shell's one request.
 *
 * Everything the client needs before it can render anything: who you are, what
 * you can do, and the reference data the project picker and every dropdown read
 * from. Six queries in parallel rather than six requests in series, because
 * this is on the critical path of every cold load.
 *
 * The alternative, letting each page fetch what it needs, was rejected for the
 * usual reason: the project picker has to open instantly, and a picker that
 * fetches on open is a picker that stutters.
 */

import { asc, eq, isNull, and } from "drizzle-orm";
import type { Ctx } from "@/server/ctx";
import * as s from "@/server/db/schema";
import { serializeSettings } from "@/server/serialize";
import { listClients } from "./clients";
import { listProjects } from "./projects";
import { listTasks } from "./tasks";
import { listUsers } from "./people";
import { getSettings } from "./settings";
import { pinnedProjectIds } from "./projects";
import { getUser } from "./people";

export async function bootstrap(ctx: Ctx) {
  const [me, users, clients, projects, tasks, settings, categories, pinned] = await Promise.all([
    getUser(ctx, ctx.actor.userId),
    listUsers(ctx),
    listClients(ctx, { includeArchived: true }),
    listProjects(ctx, { includeArchived: true }),
    listTasks(ctx, { includeArchived: true }),
    getSettings(ctx),
    ctx.db
      .select()
      .from(s.expenseCategories)
      .where(isNull(s.expenseCategories.archivedAt))
      .orderBy(asc(s.expenseCategories.name)),
    pinnedProjectIds(ctx),
  ]);

  return {
    me,
    users,
    clients,
    projects,
    tasks,
    settings: serializeSettings(settings),
    expenseCategories: categories.map((c) => ({
      id: c.id,
      name: c.name,
      unitName: c.unitName,
      unitPriceCents: c.unitPriceCents,
      archivedAt: c.archivedAt ? c.archivedAt.toISOString() : null,
    })),
    pinnedProjectIds: pinned,
    capabilities: [...ctx.actor.capabilities].sort(),
  };
}

/* --------------------------------------------------------- expense categories */

export async function listExpenseCategories(ctx: Ctx, opts: { includeArchived?: boolean } = {}) {
  const rows = await ctx.db
    .select()
    .from(s.expenseCategories)
    .where(opts.includeArchived ? undefined : isNull(s.expenseCategories.archivedAt))
    .orderBy(asc(s.expenseCategories.name));

  return rows.map((c) => ({
    id: c.id,
    name: c.name,
    unitName: c.unitName,
    unitPriceCents: c.unitPriceCents,
    archivedAt: c.archivedAt ? c.archivedAt.toISOString() : null,
  }));
}
