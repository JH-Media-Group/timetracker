/**
 * What archiving a person actually does.
 *
 * It used to be one column write. A review traced the consequences, and they
 * were quiet and then loud.
 *
 * Quiet, because a running timer survived: every report and aggregate excludes
 * entries with `timer_started_at` set, so those hours vanished from the numbers
 * without anybody being told.
 *
 * Loud, because of what happens when somebody eventually stops that timer.
 * `stopRunning` computes the duration as `now - timer_started_at`, so a timer
 * left running when a contractor left in March and stopped in June becomes a
 * single entry of several thousand hours, sailing past the 24-hour ceiling the
 * write schemas enforce, and landing in a client's billable total.
 *
 * And the project membership stayed live, which kept an archived person inside
 * `visibleUserIds`, so they remained part of a project manager's reach and kept
 * appearing in assignment pickers.
 *
 * Archiving now closes all three in one transaction. These are the assertions.
 */

import { beforeEach, afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, db, makeClient, makeProject, makeProjectTask, makeTask, resetDb, s } from "./helpers";
import { newId } from "@/server/db/ids";
import { syncBaseProfiles } from "@/server/auth/profiles";
import { createCtx, type Actor, type Ctx } from "@/server/ctx";
import { BASE_PROFILES, type BaseProfileKey, type Capability } from "@/server/auth/capabilities";
import { archiveUser } from "@/server/services/people";

let profiles: Record<string, string>;
const people: Record<string, string> = {};
let projectId: string;
let projectTaskId: string;

async function ctxFor(key: string): Promise<Ctx> {
  const userId = people[key]!;
  const [row] = await db
    .select({
      timezone: s.users.timezone,
      isOwner: s.users.isOwner,
      profileId: s.permissionProfiles.id,
      baseKey: s.permissionProfiles.baseKey,
      capabilities: s.permissionProfiles.capabilities,
    })
    .from(s.users)
    .innerJoin(s.permissionProfiles, eq(s.permissionProfiles.id, s.users.profileId))
    .where(eq(s.users.id, userId))
    .limit(1);

  const actor: Actor = {
    userId,
    profileId: row!.profileId,
    baseKey: row!.baseKey,
    capabilities: new Set(row!.capabilities as Capability[]),
    kind: "user",
    timezone: row!.timezone,
    isOwner: row!.isOwner,
  };
  return createCtx({ actor });
}

beforeEach(async () => {
  await resetDb();
  profiles = (await syncBaseProfiles(db)).ids;

  for (const key of Object.keys(BASE_PROFILES) as BaseProfileKey[]) {
    const id = newId();
    people[key] = id;
    await db.insert(s.users).values({
      id,
      email: `${key}@jhmediagroup.com`,
      firstName: key,
      lastName: "Person",
      profileId: profiles[key]!,
    });
  }

  const clientId = await makeClient();
  projectId = await makeProject(clientId);
  projectTaskId = await makeProjectTask(projectId, await makeTask());

  await db.insert(s.projectMembers).values({
    id: newId(),
    projectId,
    userId: people.member!,
    isManager: false,
  });
});

afterAll(async () => {
  await closeDb();
});

/** A timer that has been running since `startedHoursAgo`. */
async function startTimer(userId: string, startedHoursAgo: number): Promise<string> {
  const id = newId();
  await db.insert(s.timeEntries).values({
    id,
    userId,
    projectId,
    projectTaskId,
    spentOn: "2026-08-01",
    timerStartedAt: new Date(Date.now() - startedHoursAgo * 3600_000),
    durationSeconds: 0,
    isBillable: true,
  });
  return id;
}

describe("archiving a person", () => {
  it("stops a running timer instead of leaving it running forever", async () => {
    const entryId = await startTimer(people.member!, 3);

    await archiveUser(await ctxFor("administrator"), people.member!, true);

    const [entry] = await db.select().from(s.timeEntries).where(eq(s.timeEntries.id, entryId));
    expect(entry!.timerStartedAt, "the timer must be stopped, not left running").toBeNull();
    expect(entry!.durationSeconds, "roughly the three hours it actually ran").toBeGreaterThan(3 * 3600 - 120);
    expect(entry!.durationSeconds).toBeLessThan(3 * 3600 + 120);
  });

  /**
   * The reason this matters, made concrete.
   *
   * A timer running for six weeks is 1,008 hours. Left for somebody to stop
   * later, that is what would land on the entry, on a client's invoice.
   */
  it("caps a timer that was left running for weeks", async () => {
    const entryId = await startTimer(people.member!, 24 * 42);

    await archiveUser(await ctxFor("administrator"), people.member!, true);

    const [entry] = await db.select().from(s.timeEntries).where(eq(s.timeEntries.id, entryId));
    expect(entry!.timerStartedAt).toBeNull();
    expect(
      entry!.durationSeconds,
      "a single entry must never exceed a day, which is the ceiling the write schemas enforce"
    ).toBeLessThanOrEqual(86_400);
  });

  it("takes them off their projects, so they leave a manager's reach", async () => {
    await archiveUser(await ctxFor("administrator"), people.member!, true);

    const [membership] = await db
      .select()
      .from(s.projectMembers)
      .where(eq(s.projectMembers.userId, people.member!));

    expect(membership!.archivedAt, "the membership must be archived with the person").not.toBeNull();
  });

  it("revokes their sessions", async () => {
    await db.insert(s.sessions).values({
      id: newId(),
      userId: people.member!,
      tokenHash: `hash-${newId()}`,
      expiresAt: new Date(Date.now() + 86_400_000),
      absoluteExpiresAt: new Date(Date.now() + 30 * 86_400_000),
    });

    await archiveUser(await ctxFor("administrator"), people.member!, true);

    const [session] = await db.select().from(s.sessions).where(eq(s.sessions.userId, people.member!));
    expect(session!.revokedAt).not.toBeNull();
  });

  it("leaves their tracked history alone, because archive is not delete", async () => {
    const id = newId();
    await db.insert(s.timeEntries).values({
      id,
      userId: people.member!,
      projectId,
      projectTaskId,
      spentOn: "2026-07-01",
      durationSeconds: 7200,
      isBillable: true,
    });

    await archiveUser(await ctxFor("administrator"), people.member!, true);

    const [entry] = await db.select().from(s.timeEntries).where(eq(s.timeEntries.id, id));
    expect(entry, "a finished entry must survive untouched").toBeDefined();
    expect(entry!.durationSeconds).toBe(7200);
    expect(entry!.deletedAt).toBeNull();
  });

  it("refuses to archive the account owner", async () => {
    await db.update(s.users).set({ isOwner: true }).where(eq(s.users.id, people.member!));
    await expect(
      archiveUser(await ctxFor("administrator"), people.member!, true)
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  /**
   * The account has to keep somebody who can let people back in.
   *
   * Otherwise the only route back is a hand edit against the database, and the
   * person who would normally do it is the one who was archived.
   */
  it("refuses to archive the last person who can manage people", async () => {
    const ctx = await ctxFor("administrator");

    // Everybody else who holds people:manage goes first, which is allowed.
    await archiveUser(ctx, people.people_admin!, true);
    await archiveUser(ctx, people.executive_manager!, true);

    // Now the actor is the only one left, and they cannot archive themselves.
    await expect(archiveUser(ctx, people.administrator!, true)).rejects.toMatchObject({
      code: "validation_failed",
    });
  });

  it("restores somebody, leaving their projects off", async () => {
    const ctx = await ctxFor("administrator");
    await archiveUser(ctx, people.member!, true);

    const restored = await archiveUser(ctx, people.member!, false);
    // The service returns the row's value, which is null; the api seam is what
    // turns null into undefined for the UI.
    expect(restored.archivedAt, "they must no longer be archived").toBeFalsy();

    // Deliberate: coming back does not silently re-add them to work they may no
    // longer be on. The person restoring them assigns the projects.
    const [membership] = await db
      .select()
      .from(s.projectMembers)
      .where(eq(s.projectMembers.userId, people.member!));
    expect(membership!.archivedAt).not.toBeNull();
  });
});
