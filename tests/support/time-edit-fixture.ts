import { createCtx } from "@/server/ctx";
import { BASE_PROFILES } from "@/server/auth/capabilities";
import { newId } from "@/server/db/ids";
import { db, s, resetDb, seedProfiles, seedSettings, makeUser, makeClient, makeProject, makeTask, makeProjectTask } from "../helpers";

export async function timeEditFixture() {
  await resetDb();
  const profiles = await seedProfiles();
  await seedSettings({ companyName: "Example Company", timezone: "UTC", allowFutureDates: false, requireNotes: "never" });
  const owner = await makeUser({ profileId: profiles.member!, email: "member@example.com" });
  const admin = await makeUser({ profileId: profiles.administrator!, email: "admin@example.com" });
  const clientId = await makeClient("Example Client");
  const projectId = await makeProject(clientId);
  const taskId = await makeTask("Example task");
  const projectTaskId = await makeProjectTask(projectId, taskId);
  await db.insert(s.projectMembers).values({ id: newId(), projectId, userId: owner });
  const id = newId();
  await db.insert(s.timeEntries).values({ id, userId: owner, projectId, projectTaskId, spentOn: "2026-11-05", durationSeconds: 3600, notes: "Original note", billableRateCents: 12000, costRateCents: 4000, isBillable: true });
  const context = (key: "member" | "administrator") => createCtx({
    actor: { userId: key === "member" ? owner : admin, profileId: profiles[key]!, baseKey: key, kind: "user", capabilities: new Set(BASE_PROFILES[key].capabilities), timezone: "UTC", isOwner: false },
    now: () => new Date("2026-11-05T12:00:00Z"),
  });
  return { id, owner, admin, clientId, projectId, taskId, projectTaskId, member: context("member"), administrator: context("administrator") };
}
