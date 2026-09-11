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
import { callRoute, jsonData, sessionCookie } from "./support/route-harness";

import { POST as STOP } from "@/app/api/v1/time-entries/[id]/stop/route";
import { PATCH as PATCH_ME } from "@/app/api/v1/me/route";
import { POST as INVITE } from "@/app/api/v1/users/[id]/invite/route";

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

describe("POST /users/:id/invite", () => {
  /*
    This handler reads its body by hand rather than through the shared helper,
    because an absent body has to keep meaning "email only" while a malformed
    one still has to be refused. That is a strip of code no service test can
    see, and getting it wrong in either direction is silent: swallow the
    validation and a typo becomes an email-only invite nobody asked for, read
    the body twice and every request becomes email-only whatever it said.
  */

  it("emails and returns no link when the body asks for nothing in particular", async () => {
    const response = await callRoute(INVITE, {
      path: `/api/v1/users/${people.member}/invite`,
      method: "POST",
      as: people.administrator,
      params: { id: people.member! },
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(200);
    const data = await jsonData<{ queued: boolean; link?: string }>(response);
    expect(data.queued).toBe(true);
    expect(data.link, "a caller that did not ask for a link must not be handed one").toBeUndefined();
  });

  it("hands back the link when the body asks for one", async () => {
    const response = await callRoute(INVITE, {
      path: `/api/v1/users/${people.member}/invite`,
      method: "POST",
      as: people.administrator,
      params: { id: people.member! },
      body: { email: false, link: true },
    });

    expect(response.status).toBe(200);
    const data = await jsonData<{ queued: boolean; link?: string }>(response);
    expect(data.link).toMatch(/\/set-password\?token=/);
    expect(data.queued).toBe(false);

    const queued = await db
      .select()
      .from(s.outboundMessages)
      .where(eq(s.outboundMessages.userId, people.member!));
    expect(queued, "link only means no email").toHaveLength(0);
  });

  it("refuses a body that asks for neither, rather than defaulting", async () => {
    // A request that means nothing would otherwise mint a token and supersede
    // a live invite the person is already holding.
    const response = await callRoute(INVITE, {
      path: `/api/v1/users/${people.member}/invite`,
      method: "POST",
      as: people.administrator,
      params: { id: people.member! },
      body: { email: false, link: false },
    });

    expect(response.status).toBe(422);

    const tokens = await db.select().from(s.authTokens).where(eq(s.authTokens.userId, people.member!));
    expect(tokens, "a refused request must not have minted anything").toHaveLength(0);
  });

  it("refuses a malformed body instead of quietly emailing", async () => {
    /*
      The reason this is not `body(req, schema).catch(default)`. That form
      cannot tell an absent body from an invalid one, so a wrong type becomes
      an email-only invite and the caller is told it worked.
    */
    const response = await callRoute(INVITE, {
      path: `/api/v1/users/${people.member}/invite`,
      method: "POST",
      as: people.administrator,
      params: { id: people.member! },
      body: { email: "yes", link: true },
    });

    expect(response.status).toBe(422);
  });

  it("refuses an oversized body that declares no length", async () => {
    /*
      The first cap read `content-length`, defaulted a missing one to zero, and
      measured the body after `.trim()`. So a body with no declared length and
      a hundred kilobytes of leading whitespace was measured as twenty-seven
      characters and accepted, having already been buffered in full.

      Built as a stream with no `Content-Length` on purpose, because that is the
      shape that got through.
    */
    const payload = " ".repeat(100_000) + JSON.stringify({ email: false, link: true });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload));
        controller.close();
      },
    });

    const request = new Request(`https://tally.test/api/v1/users/${people.member}/invite`, {
      method: "POST",
      headers: {
        origin: (await import("@/server/env")).env.APP_URL.replace(/\/$/, ""),
        "content-type": "application/json",
        cookie: await sessionCookie(people.administrator!),
      },
      body: stream,
      // Required by undici whenever the body is a stream.
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    Object.defineProperty(request, "cookies", {
      value: {
        get(name: string) {
          const jar = request.headers.get("cookie") ?? "";
          for (const pair of jar.split(";")) {
            const [key, ...rest] = pair.trim().split("=");
            if (key === name) return { name, value: rest.join("=") };
          }
          return undefined;
        },
      },
    });

    const response = await INVITE(
      request as never,
      { params: Promise.resolve({ id: people.member! }) } as never
    );

    expect(response.status).toBe(422);
    const problem = (await response.json()) as { errors?: Record<string, string[]> };
    expect(problem.errors?._?.[0]).toMatch(/far larger/i);
  });

  it("is refused without people:manage", async () => {
    const response = await callRoute(INVITE, {
      path: `/api/v1/users/${people.administrator}/invite`,
      method: "POST",
      as: people.member,
      params: { id: people.administrator! },
      body: { email: false, link: true },
    });

    expect(response.status).toBe(403);
  });
});
