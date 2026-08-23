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
import { createRate, deleteRate, listRates, setRate } from "@/server/services/rates";
import { search } from "@/server/services/search";
import { AppError } from "@/server/errors";
import type { IsoDate } from "@/domain/calendar";

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

  /*
    Who may WRITE a rate, which is a different question from who may read one.

    `createRate` used to ask only for `rates:manage`, so any holder could set a
    cost rate for anybody in the account. That was harmless while Administrators
    were the only holders, because their reach is everyone and they may see cost
    anyway. Project Managers hold it now, so both halves matter: the kind, and
    the person.
  */
  describe("writing rates", () => {
    const billable = { kind: "billable" as const, amountCents: 20_000, startsOn: null, endsOn: null };
    const cost = { kind: "cost" as const, amountCents: 7_000, startsOn: null, endsOn: null };

    it("lets a Project Manager set the billable rate for somebody they manage", async () => {
      /*
        Through `setRate`, which is what a screen calls. `createRate` alone
        fails here and should: the person already has an open-ended billable
        rate, and the database forbids two ranges of one kind covering the same
        day. Closing the old one and opening the new one is the whole job.
      */
      const ctx = await ctxFor("project_manager");
      await setRate(ctx, people.member!, {
        kind: "billable",
        amountCents: 20_000,
        effectiveFrom: "2026-09-01" as IsoDate,
      });

      const rates = await listRates(await ctxFor("administrator"), people.member!);
      const bill = rates.filter((r) => r.kind === "billable");
      expect(bill.map((r) => r.amountCents)).toContain(20_000);
      expect(
        bill.find((r) => r.amountCents === 15_000)?.endsOn,
        "the old rate is closed the day before, not deleted"
      ).toBe("2026-08-31");
    });

    it("leaves the rate already written onto a time entry alone", async () => {
      /*
        The invariant the whole dated-range design exists for. A raise must not
        move last month's profitability, so the snapshot on an existing entry
        does not change when the rate behind it does.
      */
      const admin = await ctxFor("administrator");
      const taskId = newId();
      await db.insert(s.tasks).values({ id: taskId, name: `Task ${taskId.slice(-6)}` });
      const projectTaskId = await makeProjectTask(projectA, taskId);
      const entryId = newId();
      await db.insert(s.timeEntries).values({
        id: entryId,
        userId: people.member!,
        projectId: projectA,
        projectTaskId,
        spentOn: "2026-08-01",
        durationSeconds: 3600,
        isBillable: true,
        billableRateCents: 15_000,
        costRateCents: 6_000,
      });

      await setRate(admin, people.member!, {
        kind: "billable",
        amountCents: 99_000,
        effectiveFrom: "2026-08-01" as IsoDate,
      });

      const [after] = await db
        .select({ billable: s.timeEntries.billableRateCents })
        .from(s.timeEntries)
        .where(eq(s.timeEntries.id, entryId));
      expect(after!.billable).toBe(15_000);
    });

    it("refuses to let a Project Manager set a cost rate", async () => {
      // The point of the split: they price the work, they do not learn the pay.
      const ctx = await ctxFor("project_manager");
      await expect(
        withTransaction(ctx, (tx) => createRate(tx, people.member!, cost))
      ).rejects.toMatchObject({ code: "forbidden" });
    });

    it("refuses a Project Manager somebody outside their reach, and does not confirm they exist", async () => {
      // `outsider` is on no project this manager runs. 404, not 403.
      const ctx = await ctxFor("project_manager");
      await expect(
        withTransaction(ctx, (tx) => createRate(tx, people.outsider!, billable))
      ).rejects.toMatchObject({ code: "not_found" });
    });

    it("refuses a Member entirely, even for themselves", async () => {
      // The whole reason rates are not on the person's own settings page.
      const ctx = await ctxFor("member");
      await expect(
        withTransaction(ctx, (tx) => createRate(tx, people.member!, billable))
      ).rejects.toMatchObject({ code: "forbidden" });
    });

    /*
      setRate, not createRate.

      Every "refuses" test here used to call `createRate`, so the endpoint the
      screen actually calls had two happy paths and no negative ones. A reviewer
      changed `assertMayWriteRate(ctx, userId, input.kind)` to a hard-coded
      "billable" inside `setRate` alone, which lets a Project Manager write a
      cost rate through the live path, and the whole suite still passed.
    */
    it("does not hand a Project Manager the rates of people outside their reach", async () => {
      /*
        The leak that granting this profile `rates:view_billable` opened.

        Every profile that held it before had account-wide reach, so capability
        and reach were the same question and nothing separated them. A reviewer
        found `listRates` answering 404 for an outsider while `getUser` returned
        their billable rate, and `listUsers` put every colleague's rate in the
        bootstrap payload on every page load.
      */
      // The outsider needs a rate for this to mean anything: asserting that an
      // absent number is absent passes whatever the code does, which is how the
      // first version of this test survived deleting the filter it exists for.
      await db.insert(s.userRates).values({
        id: newId(),
        userId: people.outsider!,
        kind: "billable",
        amountCents: 33_300,
        startsOn: null,
        endsOn: null,
      });

      const pm = await ctxFor("project_manager");

      await expect(listRates(pm, people.outsider!)).rejects.toMatchObject({ code: "not_found" });

      const outsider = (await listUsers(pm)).find((u) => u.id === people.outsider);
      expect(outsider, "the person is still listed").toBeDefined();
      expect(
        outsider!.billableRateCents,
        "but their rate is not, because reach applies to the number too"
      ).toBeUndefined();

      // And somebody they do manage still shows one, or the fix went too far.
      const managed = (await listUsers(pm)).find((u) => u.id === people.member);
      expect(managed!.billableRateCents).toBe(15000);
    });

    it("refuses a Project Manager a cost rate through setRate as well", async () => {
      const ctx = await ctxFor("project_manager");
      await expect(
        setRate(ctx, people.member!, { kind: "cost", amountCents: 7_000, effectiveFrom: "2026-09-01" as IsoDate })
      ).rejects.toMatchObject({ code: "forbidden" });
    });

    it("refuses setRate for somebody outside a Project Manager's reach", async () => {
      const ctx = await ctxFor("project_manager");
      await expect(
        setRate(ctx, people.outsider!, { kind: "billable", amountCents: 20_000, effectiveFrom: "2026-09-01" as IsoDate })
      ).rejects.toMatchObject({ code: "not_found" });
    });

    it("refuses a Member setRate entirely", async () => {
      const ctx = await ctxFor("member");
      await expect(
        setRate(ctx, people.member!, { kind: "billable", amountCents: 20_000, effectiveFrom: "2026-09-01" as IsoDate })
      ).rejects.toMatchObject({ code: "forbidden" });
    });

    it("refuses anybody but the owner setting their own rate", async () => {
      /*
        The self-dealing case. `assertWithinReach` waves the self case through,
        because reach is a question about other people, so a Project Manager
        could price their own labour and invoice a client at it.
      */
      const pm = await ctxFor("project_manager");
      await expect(
        setRate(pm, people.project_manager!, { kind: "billable", amountCents: 99_900, effectiveFrom: "2026-09-01" as IsoDate })
      ).rejects.toMatchObject({ code: "validation_failed" });

      const admin = await ctxFor("administrator");
      await expect(
        setRate(admin, people.administrator!, { kind: "billable", amountCents: 99_900, effectiveFrom: "2026-09-01" as IsoDate })
      ).rejects.toMatchObject({ code: "validation_failed" });
    });

    it("keeps a rate scheduled for later, and runs the new one up to it", async () => {
      /*
        The reviewer's blocker. Setting a backdated rate used to DELETE every
        range starting on or after it, so one PUT erased a person's rate history
        and any change already scheduled, with `before: null` in the audit row.
      */
      const admin = await ctxFor("administrator");
      await setRate(admin, people.outsider!, {
        kind: "billable",
        amountCents: 10_000,
        effectiveFrom: "2026-01-01" as IsoDate,
      });
      await setRate(admin, people.outsider!, {
        kind: "billable",
        amountCents: 30_000,
        effectiveFrom: "2026-07-01" as IsoDate,
      });

      // Now reach back between the two.
      await setRate(admin, people.outsider!, {
        kind: "billable",
        amountCents: 20_000,
        effectiveFrom: "2026-04-01" as IsoDate,
      });

      const rates = (await listRates(admin, people.outsider!))
        .filter((r) => r.kind === "billable")
        .sort((a, b) => (a.startsOn ?? "").localeCompare(b.startsOn ?? ""));

      expect(
        rates.map((r) => [r.startsOn, r.endsOn, r.amountCents]),
        "the July raise survives, and the backdated rate runs up to it"
      ).toEqual([
        ["2026-01-01", "2026-03-31", 10_000],
        ["2026-04-01", "2026-06-30", 20_000],
        ["2026-07-01", null, 30_000],
      ]);
    });

    it("amends a range that already starts on that day rather than stacking another", async () => {
      const admin = await ctxFor("administrator");
      await setRate(admin, people.outsider!, { kind: "billable", amountCents: 10_000, effectiveFrom: "2026-01-01" as IsoDate });
      await setRate(admin, people.outsider!, { kind: "billable", amountCents: 11_000, effectiveFrom: "2026-01-01" as IsoDate });

      const rates = (await listRates(admin, people.outsider!)).filter((r) => r.kind === "billable");
      expect(rates).toHaveLength(1);
      expect(rates[0]!.amountCents).toBe(11_000);
    });

    it("lets an Administrator set either kind", async () => {
      const ctx = await ctxFor("administrator");
      await withTransaction(ctx, (tx) => createRate(tx, people.outsider!, billable));
      await withTransaction(ctx, (tx) => createRate(tx, people.outsider!, cost));

      const rates = await listRates(await ctxFor("administrator"), people.outsider!);
      expect(rates.map((r) => r.kind).sort()).toEqual(["billable", "cost"]);
    });

    it("answers 404 when a Project Manager names a cost rate they cannot see", async () => {
      const admin = await ctxFor("administrator");
      const seeded = await listRates(admin, people.member!);
      const costRate = seeded.find((r) => r.kind === "cost")!;

      const pm = await ctxFor("project_manager");
      /*
        404, not 403. `listRates` filters cost rows out entirely for this
        profile, so answering "forbidden" would confirm the existence of a row
        the list denies. The house rule is 404 for anything outside scope.
      */
      await expect(
        withTransaction(pm, (tx) => deleteRate(tx, people.member!, costRate.id))
      ).rejects.toMatchObject({ code: "not_found" });

      // And it is still there.
      expect((await listRates(admin, people.member!)).some((r) => r.id === costRate.id)).toBe(true);
    });
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
