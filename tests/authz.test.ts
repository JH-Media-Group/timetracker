/**
 * Authorization, exercised through the services rather than asserted about the
 * capability constants.
 *
 * The constants having the right shape proves nothing: what matters is whether
 * a Member calling `listClients` actually gets a filtered list, and whether a
 * Project Manager can reach somebody else's time entries. So every test here
 * builds a real Ctx and calls a real service against real rows.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, db, makeProjectTask, resetDb, s } from "./helpers";
import { newId } from "@/server/db/ids";
import { syncBaseProfiles } from "@/server/auth/profiles";
import { createCtx, withTransaction, type Actor, type Ctx } from "@/server/ctx";
import { BASE_PROFILES, type BaseProfileKey, type Capability } from "@/server/auth/capabilities";
import { listClients, getClient, createClient } from "@/server/services/clients";
import { listProjects, getProject } from "@/server/services/projects";
import { archiveUser, listProfiles, listUsers, getUser, updateUser } from "@/server/services/people";
import { listRates } from "@/server/services/rates";
import { search } from "@/server/services/search";
import { AppError } from "@/server/errors";

let profiles: Record<string, string>;
const people: Record<string, string> = {};
let clientA: string;
let clientB: string;
let projectA: string;
let projectB: string;

/** A Ctx for a seeded person, with their real profile's capabilities. */
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
  const synced = await syncBaseProfiles(db);
  profiles = synced.ids;

  // One person per base profile, plus a second Member who shares nothing.
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
  const outsider = newId();
  people.outsider = outsider;
  await db.insert(s.users).values({
    id: outsider,
    email: "outsider@jhmediagroup.com",
    firstName: "Outsider",
    lastName: "Person",
    profileId: profiles.member!,
  });

  clientA = newId();
  clientB = newId();
  await db.insert(s.clients).values([
    { id: clientA, name: "Client A" },
    { id: clientB, name: "Client B" },
  ]);

  projectA = newId();
  projectB = newId();
  await db.insert(s.projects).values([
    { id: projectA, clientId: clientA, name: "Project A", billingType: "time_and_materials", billBy: "people" },
    { id: projectB, clientId: clientB, name: "Project B", billingType: "time_and_materials", billBy: "people" },
  ]);

  // The Member is on Project A only. The Project Manager manages Project A.
  await db.insert(s.projectMembers).values([
    { id: newId(), projectId: projectA, userId: people.member!, isManager: false },
    { id: newId(), projectId: projectA, userId: people.project_manager!, isManager: true },
  ]);
});

afterAll(async () => {
  await closeDb();
});

/* ============================================================ scope filters */

describe("client scope", () => {
  it("shows a Member only the clients they work for", async () => {
    const ctx = await ctxFor("member");
    const clients = await listClients(ctx);
    expect(clients.map((c) => c.name)).toEqual(["Client A"]);
  });

  it("shows an Administrator every client", async () => {
    const ctx = await ctxFor("administrator");
    const clients = await listClients(ctx);
    expect(clients.map((c) => c.name).sort()).toEqual(["Client A", "Client B"]);
  });

  it("shows Accounting every client, because invoicing needs them all", async () => {
    const ctx = await ctxFor("accounting");
    const clients = await listClients(ctx);
    expect(clients).toHaveLength(2);
  });

  it("shows a Member nothing when they are on no projects", async () => {
    const ctx = await ctxFor("outsider");
    await expect(listClients(ctx)).resolves.toEqual([]);
  });

  it("returns 404, not 403, for a client outside scope", async () => {
    const ctx = await ctxFor("member");
    // Project B's client exists, and saying "forbidden" would confirm that.
    try {
      await getClient(ctx, clientB);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as AppError).code).toBe("not_found");
      expect((e as AppError).status).toBe(404);
    }
  });
});

describe("project scope", () => {
  it("shows a Member only their own projects", async () => {
    const ctx = await ctxFor("member");
    const projects = await listProjects(ctx);
    expect(projects.map((p) => p.name)).toEqual(["Project A"]);
  });

  it("shows a Project Manager every project, because they manage the work", async () => {
    const ctx = await ctxFor("project_manager");
    const projects = await listProjects(ctx);
    expect(projects).toHaveLength(2);
  });

  it("returns 404 for a project outside scope", async () => {
    const ctx = await ctxFor("member");
    await expect(getProject(ctx, projectB)).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("search", () => {
  it("filters before ranking, so a Member cannot see another team's project", async () => {
    const ctx = await ctxFor("member");
    const result = await search(ctx, "Project");
    expect(result.hits.filter((h) => h.type === "project").map((h) => h.label)).toEqual(["Project A"]);
  });

  it("shows an Administrator both", async () => {
    const ctx = await ctxFor("administrator");
    const result = await search(ctx, "Project");
    expect(result.hits.filter((h) => h.type === "project")).toHaveLength(2);
  });
});

/* ========================================================= field redaction */

describe("rate redaction", () => {
  beforeEach(async () => {
    await db.insert(s.userRates).values([
      { id: newId(), userId: people.member!, kind: "billable", amountCents: 15000 },
      { id: newId(), userId: people.member!, kind: "cost", amountCents: 6000 },
    ]);
  });

  it("hides both rates from another Member", async () => {
    const ctx = await ctxFor("outsider");
    const user = await getUser(ctx, people.member!);
    expect(user.billableRateCents).toBeUndefined();
    expect(user.costRateCents).toBeUndefined();
  });

  it("shows a person their own rates", async () => {
    const ctx = await ctxFor("member");
    const user = await getUser(ctx, people.member!);
    expect(user.billableRateCents).toBe(15000);
    // Even your own cost rate is administrator-only: it is what the company
    // pays for you, not what you charge.
    expect(user.costRateCents).toBeUndefined();
  });

  it("shows Accounting the billable rate but not the cost rate", async () => {
    const ctx = await ctxFor("accounting");
    const user = await getUser(ctx, people.member!);
    expect(user.billableRateCents).toBe(15000);
    expect(user.costRateCents).toBeUndefined();
  });

  it("shows an Administrator both", async () => {
    const ctx = await ctxFor("administrator");
    const user = await getUser(ctx, people.member!);
    expect(user.billableRateCents).toBe(15000);
    expect(user.costRateCents).toBe(6000);
  });

  it("hides cost rates from the rate list for everyone but an Administrator", async () => {
    const accounting = await listRates(await ctxFor("accounting"), people.member!);
    expect(accounting.map((r) => r.kind)).toEqual(["billable"]);

    const admin = await listRates(await ctxFor("administrator"), people.member!);
    expect(admin.map((r) => r.kind).sort()).toEqual(["billable", "cost"]);
  });

  it("refuses to list another person's rates without the capability", async () => {
    const ctx = await ctxFor("member");
    await expect(listRates(ctx, people.accounting!)).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("project money redaction", () => {
  beforeEach(async () => {
    await db
      .update(s.projects)
      .set({ billingType: "fixed_fee", feeCents: 5_000_00, hourlyRateCents: 150_00 })
      .where(eq(s.projects.id, projectA));
  });

  it("hides the fee from a Member on the project", async () => {
    const ctx = await ctxFor("member");
    const project = await getProject(ctx, projectA);
    expect(project.name).toBe("Project A");
    expect(project.feeCents).toBeUndefined();
    expect(project.hourlyRateCents).toBeUndefined();
  });

  it("shows the fee to Accounting", async () => {
    const ctx = await ctxFor("accounting");
    const project = await getProject(ctx, projectA);
    expect(project.feeCents).toBe(500000);
  });
});

/* ============================================================ capabilities */

describe("write capabilities", () => {
  it("refuses a Member creating a client", async () => {
    const ctx = await ctxFor("member");
    await expect(createClient(ctx, { name: "Sneaky Ltd." })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("allows a Project Manager to create a client", async () => {
    const ctx = await ctxFor("project_manager");
    const created = await createClient(ctx, { name: "New Client" });
    expect(created.name).toBe("New Client");
  });

  it("refuses a Member editing somebody else", async () => {
    const ctx = await ctxFor("member");
    await expect(updateUser(ctx, people.outsider!, { firstName: "Renamed" })).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("allows a People Admin to edit somebody", async () => {
    const ctx = await ctxFor("people_admin");
    const updated = await updateUser(ctx, people.member!, { firstName: "Renamed" });
    expect(updated.firstName).toBe("Renamed");
  });

  /**
   * The owner's whole record, not just their permissions.
   *
   * This asserted `validation_failed` and now asserts `forbidden`, because the
   * guard moved and widened. It used to live inside the profile check, which
   * meant an Administrator could not change the owner's *profile* and could
   * change the owner's *email*, and the planned SSO matches a first sign-in to
   * an existing row by email address. Refusing the whole record is the rule the
   * PRD always stated; refusing one field was as far as the code went.
   */
  it("refuses anybody but the owner editing the owner's record", async () => {
    await db.update(s.users).set({ isOwner: true }).where(eq(s.users.id, people.member!));
    const ctx = await ctxFor("administrator");

    await expect(
      updateUser(ctx, people.member!, { profileId: profiles.accounting! })
    ).rejects.toMatchObject({ code: "forbidden" });

    // The field that mattered and was not covered.
    await expect(
      updateUser(ctx, people.member!, { email: "attacker@example.invalid" })
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  /**
   * Reaching down is the same escalation as reaching up.
   *
   * A review proved a People Admin could move any non-owner Administrator to
   * Member, and separately archive them and revoke their sessions. The grant
   * check asked whether the new profile stayed inside the actor's permissions
   * and never asked the same about the current one, so demotion was open. One
   * People Admin could strip every administrator except the owner.
   */
  it("refuses a People Admin demoting an Administrator", async () => {
    const ctx = await ctxFor("people_admin");
    await expect(
      updateUser(ctx, people.administrator!, { profileId: profiles.member! })
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("refuses a People Admin archiving an Administrator", async () => {
    const ctx = await ctxFor("people_admin");
    await expect(archiveUser(ctx, people.administrator!, true)).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("still lets a People Admin archive somebody at or below their own rank", async () => {
    const ctx = await ctxFor("people_admin");
    const archived = await archiveUser(ctx, people.member!, true);
    expect(archived.archivedAt).toBeTruthy();
  });

  /** Nobody archives themselves out of the only seat that can undo it. */
  it("refuses archiving yourself", async () => {
    const ctx = await ctxFor("administrator");
    await expect(archiveUser(ctx, people.administrator!, true)).rejects.toMatchObject({
      code: "validation_failed",
    });
  });
});

/* ============================================================ the roster */

describe("the people roster", () => {
  it("is visible to everyone, because a timesheet has to name who tracked it", async () => {
    const ctx = await ctxFor("member");
    const users = await listUsers(ctx);
    expect(users.length).toBeGreaterThan(1);
  });
});

/* ================================================= privilege escalation */

describe("permission escalation", () => {
  it("refuses a People Admin granting a profile stronger than their own", async () => {
    // The attack this closes: people:manage is deliberately granted to People
    // Admins, who are deliberately denied settings, cost rates, and the audit
    // log. Without this guard they read the administrator profile id and PATCH
    // somebody onto it, then sign in as them.
    const ctx = await ctxFor("people_admin");
    await expect(
      updateUser(ctx, people.member!, { profileId: profiles.administrator! })
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("refuses anybody changing their own profile, even an Administrator", async () => {
    const ctx = await ctxFor("administrator");
    await expect(
      updateUser(ctx, people.administrator!, { profileId: profiles.member! })
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("allows granting a profile weaker than the actor's", async () => {
    const ctx = await ctxFor("people_admin");
    const updated = await updateUser(ctx, people.member!, { profileId: profiles.member! });
    expect(updated.profileId).toBe(profiles.member);
  });

  it("allows an Administrator to promote somebody else", async () => {
    const ctx = await ctxFor("administrator");
    const updated = await updateUser(ctx, people.member!, { profileId: profiles.accounting! });
    expect(updated.profileId).toBe(profiles.accounting);
  });

  it("keeps the profile capability list away from anybody without people:manage", async () => {
    // The list of which profile grants what is a map of how to escalate.
    const ctx = await ctxFor("member");
    await expect(listProfiles(ctx)).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("what reaches the audit log", () => {
  it("never carries a password hash", async () => {
    await db
      .update(s.users)
      .set({ passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$SECRETSALT$SECRETHASH" })
      .where(eq(s.users.id, people.member!));

    const ctx = await ctxFor("administrator");
    await withTransaction(ctx, async (tx) => {
      await updateUser(tx, people.member!, { firstName: "Audited" });
    });

    const rows = await db.select().from(s.auditLog);
    expect(rows.length).toBeGreaterThan(0);
    const serialised = JSON.stringify(rows);
    expect(serialised).not.toContain("SECRETHASH");
    expect(serialised).not.toContain("passwordHash");
    expect(serialised).not.toContain("password_hash");
  });
});
