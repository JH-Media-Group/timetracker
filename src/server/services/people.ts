/**
 * People.
 *
 * Reading the roster is open to everyone: a timesheet has to name whoever
 * tracked the time, and hiding colleagues' names from each other in an
 * eleven-person company would be theatre. Rates are the part that is gated, and
 * that gating happens in the serializer.
 */

import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { assertCan, type Ctx } from "@/server/ctx";
import { BASE_PROFILES, type BaseProfileKey, type Capability } from "@/server/auth/capabilities";
import * as s from "@/server/db/schema";
import { newId } from "@/server/db/ids";
import { userScope } from "@/server/auth/scope";
import { forbidden, notFound, validationFailed } from "@/server/errors";
import { serializeUser, type UserDto } from "@/server/serialize";
import { rateFor } from "./rates";

/**
 * Every column of `users` except the password hash.
 *
 * Named explicitly rather than using `.select()`, because these rows reach the
 * audit log, and `SELECT *` put argon2id hashes into an append-only table that
 * an audit export then hands to anybody with `audit:view`.
 */
const USER_COLUMNS = {
  id: s.users.id,
  email: s.users.email,
  firstName: s.users.firstName,
  lastName: s.users.lastName,
  avatarKey: s.users.avatarKey,
  employeeId: s.users.employeeId,
  timezone: s.users.timezone,
  weeklyCapacitySeconds: s.users.weeklyCapacitySeconds,
  employmentType: s.users.employmentType,
  isOwner: s.users.isOwner,
  profileId: s.users.profileId,
  autoAssignProjects: s.users.autoAssignProjects,
  theme: s.users.theme,
  notificationPrefs: s.users.notificationPrefs,
  startedOn: s.users.startedOn,
  endedOn: s.users.endedOn,
  archivedAt: s.users.archivedAt,
  lastSeenAt: s.users.lastSeenAt,
  externalRef: s.users.externalRef,
  createdAt: s.users.createdAt,
  updatedAt: s.users.updatedAt,
} as const;

export async function listUsers(
  ctx: Ctx,
  opts: { includeArchived?: boolean; archivedOnly?: boolean } = {}
): Promise<UserDto[]> {
  const conditions = [userScope(ctx)];
  if (opts.archivedOnly) conditions.push(sql`${s.users.archivedAt} IS NOT NULL`);
  else if (!opts.includeArchived) conditions.push(isNull(s.users.archivedAt));

  const rows = await ctx.db
    .select(USER_COLUMNS)
    .from(s.users)
    .where(and(...conditions))
    .orderBy(asc(s.users.firstName), asc(s.users.lastName));

  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);

  const [roles, departments, rates] = await Promise.all([
    ctx.db
      .select({ userId: s.userRoles.userId, name: s.roles.name })
      .from(s.userRoles)
      .innerJoin(s.roles, eq(s.roles.id, s.userRoles.roleId))
      .where(inArray(s.userRoles.userId, ids)),
    ctx.db
      .select({ userId: s.userDepartments.userId, name: s.departments.name })
      .from(s.userDepartments)
      .innerJoin(s.departments, eq(s.departments.id, s.userDepartments.departmentId))
      .where(inArray(s.userDepartments.userId, ids)),
    // The rate in force today, for display only. Entries carry their own
    // snapshot, so this never feeds a calculation.
    ctx.db
      .select({ userId: s.userRates.userId, kind: s.userRates.kind, amountCents: s.userRates.amountCents })
      .from(s.userRates)
      .where(
        and(
          inArray(s.userRates.userId, ids),
          sql`(${s.userRates.startsOn} IS NULL OR ${s.userRates.startsOn} <= CURRENT_DATE)`,
          sql`(${s.userRates.endsOn} IS NULL OR ${s.userRates.endsOn} >= CURRENT_DATE)`
        )
      ),
  ]);

  const collect = (rows: { userId: string; name: string }[]) => {
    const map = new Map<string, string[]>();
    for (const r of rows) {
      const list = map.get(r.userId);
      if (list) list.push(r.name);
      else map.set(r.userId, [r.name]);
    }
    return map;
  };

  const roleMap = collect(roles);
  const departmentMap = collect(departments);
  const billable = new Map(rates.filter((r) => r.kind === "billable").map((r) => [r.userId, r.amountCents]));
  const cost = new Map(rates.filter((r) => r.kind === "cost").map((r) => [r.userId, r.amountCents]));

  return rows.map((r) =>
    serializeUser(ctx, r, {
      roles: roleMap.get(r.id) ?? [],
      departments: departmentMap.get(r.id) ?? [],
      billableRateCents: billable.get(r.id),
      costRateCents: cost.get(r.id),
    })
  );
}

export async function getUser(ctx: Ctx, id: string): Promise<UserDto> {
  const [row] = await ctx.db
    .select(USER_COLUMNS)
    .from(s.users)
    .where(and(eq(s.users.id, id), userScope(ctx)))
    .limit(1);
  if (!row) throw notFound("That person");

  const [roles, departments, billable, cost] = await Promise.all([
    ctx.db
      .select({ name: s.roles.name })
      .from(s.userRoles)
      .innerJoin(s.roles, eq(s.roles.id, s.userRoles.roleId))
      .where(eq(s.userRoles.userId, id)),
    ctx.db
      .select({ name: s.departments.name })
      .from(s.userDepartments)
      .innerJoin(s.departments, eq(s.departments.id, s.userDepartments.departmentId))
      .where(eq(s.userDepartments.userId, id)),
    rateFor(ctx, id, "billable"),
    rateFor(ctx, id, "cost"),
  ]);

  return serializeUser(ctx, row, {
    roles: roles.map((r) => r.name),
    departments: departments.map((d) => d.name),
    billableRateCents: billable ?? undefined,
    costRateCents: cost ?? undefined,
  });
}

export interface UserInput {
  firstName?: string;
  lastName?: string;
  email?: string;
  timezone?: string;
  weeklyCapacitySeconds?: number;
  employmentType?: "employee" | "contractor";
  profileId?: string;
  startedOn?: string | null;
  endedOn?: string | null;
  roles?: string[];
  departments?: string[];
}

export async function updateUser(ctx: Ctx, id: string, input: UserInput): Promise<UserDto> {
  // Editing yourself is limited to preferences and handled by PATCH /me.
  // Anything here changes what somebody can do or what they cost.
  assertCan(ctx, "people:manage");

  const [before] = await ctx.db.select(USER_COLUMNS).from(s.users).where(eq(s.users.id, id)).limit(1);
  if (!before) throw notFound("That person");

  const patch: Record<string, unknown> = { updatedAt: ctx.now() };
  if (input.firstName !== undefined) patch.firstName = input.firstName.trim();
  if (input.lastName !== undefined) patch.lastName = input.lastName.trim();
  if (input.email !== undefined) patch.email = input.email.trim().toLowerCase();
  if (input.timezone !== undefined) patch.timezone = input.timezone;
  if (input.weeklyCapacitySeconds !== undefined) {
    if (input.weeklyCapacitySeconds < 0 || input.weeklyCapacitySeconds > 168 * 3600) {
      throw validationFailed({ weeklyCapacitySeconds: ["A week has 168 hours in it."] });
    }
    patch.weeklyCapacitySeconds = input.weeklyCapacitySeconds;
  }
  if (input.employmentType !== undefined) patch.employmentType = input.employmentType;
  if (input.startedOn !== undefined) patch.startedOn = input.startedOn;
  if (input.endedOn !== undefined) patch.endedOn = input.endedOn;

  if (input.profileId !== undefined && input.profileId !== before.profileId) {
    await assertMayGrantProfile(ctx, id, before, input.profileId);
    patch.profileId = input.profileId;
  }

  const [after] = await ctx.db
    .update(s.users)
    .set(patch as never)
    .where(eq(s.users.id, id))
    .returning(USER_COLUMNS);

  if (input.roles) await setNamedLinks(ctx, id, input.roles, "roles");
  if (input.departments) await setNamedLinks(ctx, id, input.departments, "departments");

  ctx.audit({
    action: "user.update",
    entityType: "user",
    entityId: id,
    entityLabel: `${after!.firstName} ${after!.lastName}`,
    before,
    after,
  });

  return getUser(ctx, id);
}

export async function archiveUser(ctx: Ctx, id: string, archived: boolean): Promise<UserDto> {
  assertCan(ctx, "people:manage");

  const [before] = await ctx.db.select(USER_COLUMNS).from(s.users).where(eq(s.users.id, id)).limit(1);
  if (!before) throw notFound("That person");
  if (before.isOwner && archived) {
    throw validationFailed({ _: ["The account owner cannot be archived."] });
  }

  await ctx.db
    .update(s.users)
    .set({ archivedAt: archived ? ctx.now() : null, updatedAt: ctx.now() })
    .where(eq(s.users.id, id));

  // Archiving ends every session on the next request anyway; revoking makes it
  // immediate and visible in the sessions list.
  if (archived) {
    await ctx.db
      .update(s.sessions)
      .set({ revokedAt: ctx.now() })
      .where(and(eq(s.sessions.userId, id), isNull(s.sessions.revokedAt)));
  }

  ctx.audit({
    action: archived ? "user.archive" : "user.restore",
    entityType: "user",
    entityId: id,
    entityLabel: `${before.firstName} ${before.lastName}`,
    before,
  });

  return getUser(ctx, id);
}

/* --------------------------------------------------- roles and departments */

async function setNamedLinks(ctx: Ctx, userId: string, names: string[], kind: "roles" | "departments") {
  const cleaned = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  const table = kind === "roles" ? s.roles : s.departments;
  const linkTable = kind === "roles" ? s.userRoles : s.userDepartments;
  const linkColumn = kind === "roles" ? s.userRoles.roleId : s.userDepartments.departmentId;

  await ctx.db.delete(linkTable).where(eq(linkTable.userId, userId));
  if (cleaned.length === 0) return;

  const existing = await ctx.db.select().from(table).where(inArray(table.name, cleaned));
  const byName = new Map(existing.map((r) => [r.name, r.id]));

  const missing = cleaned.filter((n) => !byName.has(n));
  if (missing.length) {
    const created = await ctx.db
      .insert(table)
      .values(missing.map((name) => ({ id: newId(), name })))
      .onConflictDoNothing()
      .returning();
    for (const r of created) byName.set(r.name, r.id);

    const stillMissing = missing.filter((n) => !byName.has(n));
    if (stillMissing.length) {
      const found = await ctx.db.select().from(table).where(inArray(table.name, stillMissing));
      for (const r of found) byName.set(r.name, r.id);
    }
  }

  const values = cleaned
    .map((name) => byName.get(name))
    .filter((id): id is string => Boolean(id))
    .map((id) => ({ userId, [linkColumn === s.userRoles.roleId ? "roleId" : "departmentId"]: id }));

  if (values.length) await ctx.db.insert(linkTable).values(values as never).onConflictDoNothing();
}

export async function listRoles(ctx: Ctx) {
  const rows = await ctx.db.select().from(s.roles).where(isNull(s.roles.archivedAt)).orderBy(asc(s.roles.name));
  return rows.map((r) => ({ id: r.id, name: r.name }));
}

export async function listDepartments(ctx: Ctx) {
  const rows = await ctx.db
    .select()
    .from(s.departments)
    .where(isNull(s.departments.archivedAt))
    .orderBy(asc(s.departments.name));
  return rows.map((r) => ({ id: r.id, name: r.name }));
}

export async function listProfiles(ctx: Ctx) {
  // The capability list of every profile is a map of how to escalate. Reading
  // it is a people-management concern, not public reference data.
  assertCan(ctx, "people:manage");

  const rows = await ctx.db
    .select({
      id: s.permissionProfiles.id,
      name: s.permissionProfiles.name,
      isBase: s.permissionProfiles.isBase,
      baseKey: s.permissionProfiles.baseKey,
      capabilities: s.permissionProfiles.capabilities,
    })
    .from(s.permissionProfiles)
    .orderBy(asc(s.permissionProfiles.name));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    isBase: r.isBase,
    baseKey: r.baseKey,
    capabilities: r.capabilities,
  }));
}


/* -------------------------------------------------- permission escalation */

/**
 * May this actor move that person onto that profile?
 *
 * Three rules, and the first two exist because `people:manage` is deliberately
 * granted to People Admins and Executive Managers, neither of whom is meant to
 * reach settings, cost rates, or the audit log:
 *
 *   1. nobody grants a capability they do not themselves hold. Without this,
 *      any holder of `people:manage` reads the administrator profile id and
 *      PATCHes themselves onto it, and the whole capability model is decorative.
 *   2. nobody changes their own profile. Self-promotion needs a second person
 *      even when rule 1 would allow it.
 *   3. the account owner's profile is fixed, including by the owner. An account
 *      with no administrator is an account nobody can repair.
 */
async function assertMayGrantProfile(
  ctx: Ctx,
  targetUserId: string,
  target: { isOwner: boolean },
  profileId: string
): Promise<void> {
  if (target.isOwner) {
    throw validationFailed({ profileId: ["The account owner's permissions cannot be changed."] });
  }

  if (targetUserId === ctx.actor.userId) {
    throw validationFailed({
      profileId: ["You cannot change your own permissions. Ask another administrator."],
    });
  }

  const [profile] = await ctx.db
    .select({ capabilities: s.permissionProfiles.capabilities, name: s.permissionProfiles.name })
    .from(s.permissionProfiles)
    .where(eq(s.permissionProfiles.id, profileId))
    .limit(1);

  if (!profile) throw validationFailed({ profileId: ["That permission profile does not exist."] });

  if (ctx.actor.kind === "system") return;

  const granting = (profile.capabilities ?? []) as Capability[];
  const held = ctx.actor.capabilities;
  const beyond = granting.filter((c) => !held.has(c));

  if (beyond.length > 0) {
    throw forbidden(
      `That profile grants permissions you do not have yourself: ${beyond.slice(0, 4).join(", ")}` +
        (beyond.length > 4 ? `, and ${beyond.length - 4} more.` : ".")
    );
  }
}

/** The base profile a capability set corresponds to, for messages and tests. */
export const profileKeyFor = (capabilities: readonly string[]): BaseProfileKey | null => {
  for (const [key, definition] of Object.entries(BASE_PROFILES) as [BaseProfileKey, { capabilities: readonly string[] }][]) {
    if (definition.capabilities.length === capabilities.length &&
        definition.capabilities.every((c) => capabilities.includes(c))) {
      return key;
    }
  }
  return null;
};
