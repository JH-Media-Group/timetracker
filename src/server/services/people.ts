/**
 * People.
 *
 * Reading the roster is open to everyone: a timesheet has to name whoever
 * tracked the time, and hiding colleagues' names from each other in an
 * eleven-person company would be theatre. Rates are the part that is gated, and
 * that gating happens in the serializer.
 */

import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { assertCan, type Ctx } from "@/server/ctx";
import { BASE_PROFILES, effectiveCapabilities, type BaseProfileKey, type Capability } from "@/server/auth/capabilities";
import * as s from "@/server/db/schema";
import { newId } from "@/server/db/ids";
import { userScope, visibleUserIds } from "@/server/auth/scope";
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
          /*
            Only for people this actor can reach.

            `rates:view_billable` used to imply account-wide reach, because
            every profile holding it had `othersScope: "all"`. Project Manager
            is the first holder with `team` reach, and without this line their
            bootstrap carried every colleague's charge-out rate on every page
            load, while `listRates` answered 404 for the same person. The
            capability says "may see rates", not "may see everyone's".
          */
          sql`${s.userRates.userId} IN ${visibleUserIds(ctx)}`,
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

export interface CreateUserInput extends UserInput {
  firstName: string;
  lastName: string;
  email: string;
  timezone: string;
  weeklyCapacitySeconds: number;
  employmentType: "employee" | "contractor";
  profileId: string;
}

export async function createUser(ctx: Ctx, input: CreateUserInput): Promise<UserDto> {
  assertCan(ctx, "people:manage");
  const id = newId();
  await assertMayGrantProfile(ctx, id, { isOwner: false, profileId: null }, input.profileId);

  const [created] = await ctx.db.insert(s.users).values({
    id,
    firstName: input.firstName.trim(),
    lastName: input.lastName.trim(),
    email: input.email.trim().toLowerCase(),
    timezone: input.timezone,
    weeklyCapacitySeconds: input.weeklyCapacitySeconds,
    employmentType: input.employmentType,
    profileId: input.profileId,
    startedOn: input.startedOn,
  }).returning(USER_COLUMNS);

  if (input.roles) await setNamedLinks(ctx, id, input.roles, "roles");
  if (input.departments) await setNamedLinks(ctx, id, input.departments, "departments");
  ctx.audit({
    action: "user.create",
    entityType: "user",
    entityId: id,
    entityLabel: `${created!.firstName} ${created!.lastName}`,
    after: created,
  });
  return getUser(ctx, id);
}

export async function updateUser(ctx: Ctx, id: string, input: UserInput): Promise<UserDto> {
  // Editing yourself is limited to preferences and handled by PATCH /me.
  // Anything here changes what somebody can do or what they cost.
  assertCan(ctx, "people:manage");

  /*
    Locked, and everything below decided from what the lock returned.

    Reading unlocked and authorizing on that read is a check-then-act race, and
    the same one already fixed in `inviteUser`. A promotion committing in the
    window means the rank check passes against the old profile and the write
    lands on the new one: a People Admin edits an account that became an
    Administrator while they waited, changes its email, and takes it over
    through a password reset.

    Taking the user before the profile also fixes the order. The profile read
    below locks too, so a caller that took them the other way round would
    deadlock against this one.
  */
  const [before] = await ctx.db
    .select(USER_COLUMNS)
    .from(s.users)
    .where(eq(s.users.id, id))
    .limit(1)
    .for("update");
  if (!before) throw notFound("That person");

  /**
   * The owner's record belongs to the owner.
   *
   * Only `profileId` used to be protected, which left the owner's **email**
   * editable by anybody holding `people:manage`. That is not cosmetic: the
   * planned Google SSO matches a first sign-in to an existing row by email
   * address (BACKEND_PRD 7.1), so changing it hands the account to whoever
   * controls the new address. The rule was always "the owner cannot be demoted
   * or removed"; it was enforced for two verbs and open for the rest of the
   * record.
   */
  if (before.isOwner && ctx.actor.kind !== "system" && id !== ctx.actor.userId) {
    throw forbidden("Only the account owner can edit the owner's record.");
  }

  // Editing somebody more powerful than you is the same reach as demoting them.
  if (before.profileId && id !== ctx.actor.userId) {
    await assertOutranksOrEqual(ctx, before.profileId, "edit");
  }

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

  // Locked before the decision, for the reason given in `updateUser`.
  const [before] = await ctx.db
    .select(USER_COLUMNS)
    .from(s.users)
    .where(eq(s.users.id, id))
    .limit(1)
    .for("update");
  if (!before) throw notFound("That person");
  if (before.isOwner && archived) {
    throw validationFailed({ _: ["The account owner cannot be archived."] });
  }

  // Archiving somebody is the most complete version of reaching down: they stop
  // being able to sign in at all. It needs the same rank rule as a demotion,
  // and until a review found this it had none.
  if (before.profileId) await assertOutranksOrEqual(ctx, before.profileId, archived ? "archive" : "restore");

  if (archived && id === ctx.actor.userId) {
    throw validationFailed({
      _: ["You cannot archive yourself. Ask another administrator, so somebody is left holding the keys."],
    });
  }

  if (archived) await assertNotTheLastAdministrator(ctx, id);

  await ctx.db
    .update(s.users)
    .set({ archivedAt: archived ? ctx.now() : null, updatedAt: ctx.now() })
    .where(eq(s.users.id, id));

  if (archived) {
    // Archiving ends every session on the next request anyway; revoking makes it
    // immediate and visible in the sessions list.
    await ctx.db
      .update(s.sessions)
      .set({ revokedAt: ctx.now() })
      .where(and(eq(s.sessions.userId, id), isNull(s.sessions.revokedAt)));

    /**
     * Stop the clock, at the moment they left.
     *
     * A running timer survived archiving, and the consequences were quiet and
     * then loud. Quiet, because every report and aggregate excludes entries with
     * `timer_started_at` set, so those hours simply vanish from the numbers.
     * Loud, because whenever somebody later stops it, the duration is computed
     * as `now - timer_started_at`: weeks of wall-clock seconds in a single
     * entry, sailing past the 24-hour ceiling the write schemas enforce, and
     * landing in a client's billable total.
     *
     * Closing it here uses the archive time, which is the last moment we know
     * they were working.
     */
    const stoppedAt = ctx.now();
    await ctx.db
      .update(s.timeEntries)
      .set({
        durationSeconds: sql`GREATEST(0, LEAST(86400, EXTRACT(EPOCH FROM (${stoppedAt.toISOString()}::timestamptz - ${s.timeEntries.timerStartedAt}))::int))`,
        timerStartedAt: null,
        updatedAt: stoppedAt,
      })
      .where(and(eq(s.timeEntries.userId, id), isNull(s.timeEntries.deletedAt), sql`${s.timeEntries.timerStartedAt} IS NOT NULL`));

    /**
     * And take them off their projects.
     *
     * A live `project_members` row keeps an archived person inside
     * `visibleUserIds`, so they stay part of a project manager's reach and keep
     * appearing in assignment pickers. Archiving the membership rather than
     * deleting it keeps their history intact, which is the house rule.
     */
    await ctx.db
      .update(s.projectMembers)
      .set({ archivedAt: stoppedAt })
      .where(and(eq(s.projectMembers.userId, id), isNull(s.projectMembers.archivedAt)));
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
/**
 * Refuses to archive the last person who could let anybody back in.
 *
 * `people:manage` is what grants and restores accounts. An account with nobody
 * holding it is an account where a locked-out person stays locked out and a
 * departed contractor stays on the roster, and the only route back is a hand
 * edit against the database. The owner is exempt from archiving already, so
 * this is really about the case where the owner has left the company and the
 * administrators are managing each other.
 *
 * Counted rather than assumed: this reads the live roster, so it stays true as
 * profiles are edited.
 */
async function assertNotTheLastAdministrator(ctx: Ctx, excludingUserId: string): Promise<void> {
  const rows = await ctx.db
    .select({ capabilities: s.permissionProfiles.capabilities })
    .from(s.users)
    .innerJoin(s.permissionProfiles, eq(s.users.profileId, s.permissionProfiles.id))
    .where(and(isNull(s.users.archivedAt), ne(s.users.id, excludingUserId)));

  /*
    Counted on effective capabilities, like every other capability question in
    this file since one of them was found comparing literal strings.

    Nothing implies `people:manage` today, so this changes no answer now. It is
    the counting that matters: a guard that undercounts holders is a guard that
    lets you archive the last real one, and the day some profile confers it by
    implication is not the day to discover that this line was the exception.
  */
  const remaining = rows.filter((row) =>
    effectiveCapabilities((row.capabilities ?? []) as Capability[]).has("people:manage")
  ).length;

  if (remaining === 0) {
    throw validationFailed({
      _: [
        "This is the last person who can manage people. Archiving them would " +
          "leave nobody able to add, restore, or unlock an account. Give somebody " +
          "else those permissions first.",
      ],
    });
  }
}

/**
 * Refuses when the target currently holds a permission the actor does not.
 *
 * The grant check below asks whether the *new* profile stays inside the actor's
 * own permissions, which stops promotion. For a long time nothing asked the
 * same question about the *current* profile, so demotion was unguarded and a
 * review proved the consequence: a People Admin could move any non-owner
 * Administrator to Member, and the change took effect on that administrator's
 * very next request, because capabilities are re-read from the profile each
 * time. The same gap let a People Admin archive an Administrator outright and
 * revoke their sessions. Between the two, one People Admin could strip and lock
 * out every administrator except the owner.
 *
 * Reaching down is the same escalation as reaching up. Somebody who can remove
 * the people above them ends up the most powerful account by subtraction.
 */
export async function assertOutranksOrEqual(ctx: Ctx, targetProfileId: string, verb: string): Promise<void> {
  if (ctx.actor.kind === "system") return;

  /*
    Locked, because the capabilities read here are what the decision rests on.

    Locking the user serialises against somebody being moved to a different
    profile. It does nothing about the profile they already point at being
    widened, which is how a custom profile gains capabilities: no `users` row
    is touched at all. Without this the check can authorize against
    capabilities that were current when it read them and are not when it acts.

    Always taken after the caller has the user row, so the order is users then
    permission_profiles everywhere this runs, and two of these cannot deadlock
    against each other.
  */
  const [profile] = await ctx.db
    .select({ capabilities: s.permissionProfiles.capabilities })
    .from(s.permissionProfiles)
    .where(eq(s.permissionProfiles.id, targetProfileId))
    .limit(1)
    /*
      Shared, not exclusive. This only reads the profile; it needs the
      capabilities to stay put until the transaction ends, not the right to
      change them. `FOR UPDATE` made every invite for every Member queue behind
      whichever one held the Member profile, through token issuance, mail
      queuing and commit. `FOR SHARE` blocks a capability edit and lets
      concurrent readers through.
    */
    .for("share");

  if (!profile) return; // No profile is no permissions; nothing to outrank.

  const theirs = (profile.capabilities ?? []) as Capability[];
  /*
    Compared on what the caller's capabilities actually confer, not on the
    literal strings.

    `report:view_all` subsumes `report:view_team`, and an Executive Manager
    holds the first without the second, so a set difference reported the
    Executive Manager as lacking something a People Admin had and refused the
    action. The same profile is allowed to read every report in the account.
  */
  const held = effectiveCapabilities(ctx.actor.capabilities as Iterable<Capability>);
  const beyond = theirs.filter((c) => !held.has(c));

  if (beyond.length > 0) {
    throw forbidden(
      `You cannot ${verb} somebody whose permissions exceed your own. ` +
        `They hold ${beyond.slice(0, 3).join(", ")}` +
        (beyond.length > 3 ? `, and ${beyond.length - 3} more` : "") +
        " and you do not."
    );
  }
}

async function assertMayGrantProfile(
  ctx: Ctx,
  targetUserId: string,
  target: { isOwner: boolean; profileId: string | null },
  profileId: string
): Promise<void> {
  if (target.isOwner) {
    throw validationFailed({ profileId: ["The account owner's permissions cannot be changed."] });
  }

  // Reaching down, checked before reaching up.
  if (target.profileId) await assertOutranksOrEqual(ctx, target.profileId, "change the permissions of");

  if (targetUserId === ctx.actor.userId) {
    throw validationFailed({
      profileId: ["You cannot change your own permissions. Ask another administrator."],
    });
  }

  /*
    Shared-locked for the same reason the read in `assertOutranksOrEqual` is:
    this is the profile about to be granted, and deciding whether the caller
    may grant it from capabilities that can be widened before the grant lands
    is the same check-then-act one layer along. Taken after the target user's
    row, so the order stays users then permission_profiles.
  */
  const [profile] = await ctx.db
    .select({ capabilities: s.permissionProfiles.capabilities, name: s.permissionProfiles.name })
    .from(s.permissionProfiles)
    .where(eq(s.permissionProfiles.id, profileId))
    .limit(1)
    .for("share");

  if (!profile) throw validationFailed({ profileId: ["That permission profile does not exist."] });

  if (ctx.actor.kind === "system") return;

  const granting = (profile.capabilities ?? []) as Capability[];
  /*
    On what the caller's capabilities confer, matching `assertOutranksOrEqual`.

    Comparing the literal strings here and the effective ones there would mean
    an Executive Manager could edit a People Admin but not grant that same
    profile to somebody, refused over a capability they exceed. Two readings of
    the same question in one file is how one of them ends up wrong.
  */
  const held = effectiveCapabilities(ctx.actor.capabilities as Iterable<Capability>);
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
