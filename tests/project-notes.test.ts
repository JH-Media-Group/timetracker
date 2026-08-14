/**
 * Project notes, and who may read them (TALLY-36).
 *
 * Notes have been captured by the project editor and stored since the first
 * migration. They were serialized to the browser and displayed by nothing, and
 * `settings.projectNotesVisibility`, the setting that decides who may see them,
 * governed nothing at all. `tests/settings-consumed.test.ts` found it.
 *
 * The assertion that matters here is **absence from the payload**, not absence
 * from the screen. A field the actor may not read must never reach the browser;
 * hiding it in a component ships it and calls that privacy. So every test below
 * checks the serialized object rather than any rendering of it.
 */

import { beforeEach, afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, db, makeClient, resetDb, s, seedSettings } from "./helpers";
import { newId } from "@/server/db/ids";
import { syncBaseProfiles } from "@/server/auth/profiles";
import { createCtx, type Actor, type Ctx } from "@/server/ctx";
import { BASE_PROFILES, type BaseProfileKey, type Capability } from "@/server/auth/capabilities";
import { createProject, getProject, listProjects } from "@/server/services/projects";

const people: Record<string, string> = {};
let clientId: string;

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

async function makeNotedProject(notes: string | null) {
  const ctx = await ctxFor("administrator");
  const project = await createProject(ctx, {
    clientId,
    name: "Website",
    billingType: "time_and_materials",
    billBy: "project",
    budgetBy: "none",
    notes,
  });
  // Members can only see projects they are on.
  await db.insert(s.projectMembers).values({
    id: newId(),
    projectId: project.id,
    userId: people.member!,
    isManager: false,
  });
  return project.id;
}

beforeEach(async () => {
  await resetDb();
  const profiles = (await syncBaseProfiles(db)).ids;

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

  await seedSettings();
  clientId = await makeClient("Example Client 43");
});

afterAll(async () => {
  await closeDb();
});

describe("with projectNotesVisibility = managers, which is the default", () => {
  it("gives the notes to somebody who manages projects", async () => {
    const id = await makeNotedProject("Client prefers Tuesday check-ins.");
    const project = await getProject(await ctxFor("administrator"), id);

    expect(project.notes).toBe("Client prefers Tuesday check-ins.");
  });

  /** The assertion the ticket is really about. */
  it("does not send them to a Member at all", async () => {
    const id = await makeNotedProject("Client prefers Tuesday check-ins.");
    const project = await getProject(await ctxFor("member"), id);

    expect(
      "notes" in project,
      "the field must be absent, not null and not empty: a Member should never receive it"
    ).toBe(false);
  });

  it("holds on the list as well as the detail", async () => {
    await makeNotedProject("Sensitive.");

    const asManager = await listProjects(await ctxFor("administrator"), {});
    const asMember = await listProjects(await ctxFor("member"), {});

    expect(asManager[0]!.notes).toBe("Sensitive.");
    expect("notes" in asMember[0]!).toBe(false);
  });
});

describe("with projectNotesVisibility = everyone", () => {
  beforeEach(async () => {
    await db.update(s.settings).set({ projectNotesVisibility: "everyone" });
    const { invalidateSettings } = await import("@/server/services/settings");
    invalidateSettings();
  });

  it("gives the notes to a Member too", async () => {
    const id = await makeNotedProject("Everybody may read this.");
    const project = await getProject(await ctxFor("member"), id);

    expect(project.notes).toBe("Everybody may read this.");
  });
});

describe("empty notes", () => {
  /**
   * Absent and empty are different states, and they stay different: absent
   * means "you may not read these", empty means "there are none". Both render
   * nothing, but conflating them on the wire would make the first
   * indistinguishable from the second.
   */
  it("is present and null for somebody allowed to see them", async () => {
    const id = await makeNotedProject(null);
    const project = await getProject(await ctxFor("administrator"), id);

    expect("notes" in project).toBe(true);
    expect(project.notes).toBeNull();
  });

  it("is still absent for somebody who is not", async () => {
    const id = await makeNotedProject(null);
    const project = await getProject(await ctxFor("member"), id);

    expect("notes" in project).toBe(false);
  });
});
