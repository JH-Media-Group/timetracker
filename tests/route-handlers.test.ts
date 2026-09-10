/**
 * Route handlers, called the way the browser calls them.
 *
 * Almost everything else in this suite tests a service directly, which is the
 * right default. This covers the strip between the two: the handler that
 * unpacks a request and calls the service. Nothing else looks at it, and it is
 * where a defect hides best, because the service is correct and the client is
 * correct and neither test can see the wire.
 *
 * The stop route is the worked example and the reason this file exists.
 * `stopTimer` has always taken an optional user id, and `src/lib/api.ts` has
 * always sent one, and the handler called `stopTimer(ctx)` and dropped it.
 * Every service test passed. Stopping a teammate's timer stopped your own
 * instead, and the fix for t-DVQ2qW reached the client and died at the handler,
 * deployed and believed for a day.
 *
 * Each case here is deliberately one a service test cannot express: it is about
 * what the handler does with the request, not about what the service does with
 * its arguments.
 */

import { beforeEach, afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, db, makeClient, makeProject, makeProjectTask, makeTask, resetDb, s, seedSettings } from "./helpers";
import { newId } from "@/server/db/ids";
import { syncBaseProfiles } from "@/server/auth/profiles";
import { createCtx, type Actor, type Ctx } from "@/server/ctx";
import { BASE_PROFILES, type BaseProfileKey, type Capability } from "@/server/auth/capabilities";
import { createTimeEntry, runningEntry } from "@/server/services/time";
import { callRoute } from "./support/route-harness";

import { POST as STOP } from "@/app/api/v1/time-entries/[id]/stop/route";
import { PATCH as PATCH_ME } from "@/app/api/v1/me/route";

let profiles: Record<string, string>;
const people: Record<string, string> = {};
let projectId: string;
let taskId: string;

function ctxFor(key: BaseProfileKey): Ctx {
  const actor: Actor = {
    userId: people[key]!,
    profileId: profiles[key]!,
    baseKey: key,
    capabilities: new Set(BASE_PROFILES[key].capabilities as readonly Capability[]),
    kind: "user",
    timezone: "America/New_York",
    isOwner: key === "administrator",
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
      timezone: "America/New_York",
    });
  }
  await seedSettings();

  const clientId = await makeClient("Handler Co");
  projectId = await makeProject(clientId, { name: "Handlers", billBy: "people" });
  // `createTimeEntry` takes the task, and resolves the project-task itself.
  taskId = await makeTask();
  await makeProjectTask(projectId, taskId);

  // A person books only to a project they are on, so both need adding or
  // `createTimeEntry` refuses the setup before a route is ever called.
  await db.insert(s.projectMembers).values([
    { id: newId(), projectId, userId: people.administrator!, isManager: true },
    { id: newId(), projectId, userId: people.member! },
  ]);
});

afterAll(closeDb);

describe("POST /time-entries/:id/stop", () => {
  it("stops the person named in the body, not the caller", async () => {
    /*
      The regression that started this file. An administrator on a teammate's
      timesheet presses Stop on their running row; the client posts their id.
      A handler that ignores the body stops the administrator's own timer, and
      no service test can tell, because the service is given the right argument
      in every one of them.
    */
    const admin = ctxFor("administrator");
    const member = ctxFor("member");

    const mine = await createTimeEntry(admin, { projectId, taskId, start: true });
    const theirs = await createTimeEntry(member, { projectId, taskId, start: true });

    const response = await callRoute(STOP, {
      path: "/api/v1/time-entries/current/stop",
      method: "POST",
      as: people.administrator,
      body: { userId: people.member },
      params: { id: "current" },
    });

    expect(response.status).toBe(200);

    const [stopped] = await db.select().from(s.timeEntries).where(eq(s.timeEntries.id, theirs.entry.id));
    expect(stopped!.timerStartedAt, "their timer stopped").toBeNull();

    const stillMine = await runningEntry(admin);
    expect(stillMine?.id, "the caller's own timer kept running").toBe(mine.entry.id);
  });

  it("stops the caller's own timer when the body names nobody", async () => {
    // The ordinary case, and the one that hid the bug: with no id in the body
    // the handler and the broken handler behave identically.
    const admin = ctxFor("administrator");
    const mine = await createTimeEntry(admin, { projectId, taskId, start: true });

    const response = await callRoute(STOP, {
      path: "/api/v1/time-entries/current/stop",
      method: "POST",
      as: people.administrator,
      body: {},
      params: { id: "current" },
    });

    expect(response.status).toBe(200);
    const [stopped] = await db.select().from(s.timeEntries).where(eq(s.timeEntries.id, mine.entry.id));
    expect(stopped!.timerStartedAt).toBeNull();
  });

  it("refuses to stop somebody else's timer without the capability", async () => {
    // A Member holds no `time:edit_others`. The service enforces it; this
    // proves the handler passes the id along far enough for it to be enforced,
    // rather than quietly falling back to the caller and succeeding.
    const admin = ctxFor("administrator");
    const running = await createTimeEntry(admin, { projectId, taskId, start: true });

    const response = await callRoute(STOP, {
      path: "/api/v1/time-entries/current/stop",
      method: "POST",
      as: people.member,
      body: { userId: people.administrator },
      params: { id: "current" },
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    const [untouched] = await db.select().from(s.timeEntries).where(eq(s.timeEntries.id, running.entry.id));
    expect(untouched!.timerStartedAt, "still running").not.toBeNull();
  });

  it("refuses a request from another origin", async () => {
    /*
      The third lock on cross-site writes, and the only one that does not depend
      on a browser getting SameSite or a preflight right. It lives in the route
      wrapper, so no service test reaches it.
    */
    const admin = ctxFor("administrator");
    await createTimeEntry(admin, { projectId, taskId, start: true });

    const response = await callRoute(STOP, {
      path: "/api/v1/time-entries/current/stop",
      method: "POST",
      as: people.administrator,
      body: {},
      params: { id: "current" },
      headers: { origin: "https://evil.example" },
    });

    expect(response.status).toBe(403);
    expect(await runningEntry(admin), "the timer is untouched").not.toBeNull();
  });
});

describe("PATCH /me", () => {
  it("sets your own timezone with no capability at all", async () => {
    /*
      A preference about yourself is not a permission, which is why this route
      declares none. A contractor could not change her timezone for want of a
      caller, so her hours landed on a US calendar day; the endpoint was right
      the whole time. This holds that open for the least privileged profile
      there is.
    */
    const response = await callRoute(PATCH_ME, {
      path: "/api/v1/me",
      method: "PATCH",
      as: people.member,
      body: { timezone: "Asia/Karachi" },
    });

    expect(response.status).toBe(200);

    const [row] = await db.select().from(s.users).where(eq(s.users.id, people.member!));
    expect(row!.timezone).toBe("Asia/Karachi");
  });

  it("refuses a timezone the platform does not know", async () => {
    // A bad preference used to make every later calendar-day resolution throw,
    // turning one person's settings into 500s on every time entry they wrote.
    const response = await callRoute(PATCH_ME, {
      path: "/api/v1/me",
      method: "PATCH",
      as: people.member,
      body: { timezone: "Mars/Olympus_Mons" },
    });

    expect(response.status).toBe(422);

    const [row] = await db.select().from(s.users).where(eq(s.users.id, people.member!));
    expect(row!.timezone, "unchanged").toBe("America/New_York");
  });

  it("changes nobody else", async () => {
    // There is no id in this route by design. If one ever appears, it must not
    // become a way to edit another person without `people:manage`.
    await callRoute(PATCH_ME, {
      path: "/api/v1/me",
      method: "PATCH",
      as: people.member,
      body: { timezone: "Europe/Bucharest" },
    });

    const [admin] = await db.select().from(s.users).where(eq(s.users.id, people.administrator!));
    expect(admin!.timezone).toBe("America/New_York");
  });
});
