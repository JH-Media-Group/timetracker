/**
 * The database's own guarantees.
 *
 * These are the invariants that must hold even if every line of application
 * code is wrong: one running timer, no overlapping rates, no negative
 * durations. If the database enforces them a race condition cannot produce a
 * broken row; if only the service layer does, eventually it will.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  closeDb, db, expectConstraintViolation, makeClient, makeProject, makeProjectTask,
  makeTask, makeUser, resetDb, s, seedProfiles,
} from "./helpers";
import { newId } from "@/server/db/ids";

let profiles: Record<string, string>;

beforeEach(async () => {
  await resetDb();
  profiles = await seedProfiles();
});

afterAll(async () => {
  await closeDb();
});

async function timeFixture() {
  const userId = await makeUser({ profileId: profiles.member! });
  const clientId = await makeClient();
  const projectId = await makeProject(clientId);
  const taskId = await makeTask();
  const projectTaskId = await makeProjectTask(projectId, taskId);
  return { userId, projectId, projectTaskId, spentOn: "2026-08-14", isBillable: true } as const;
}

describe("time entries", () => {
  it("allows exactly one running timer per person", async () => {
    const base = await timeFixture();
    await db.insert(s.timeEntries).values({ id: newId(), ...base, timerStartedAt: new Date() });

    await expectConstraintViolation(
      db.insert(s.timeEntries).values({ id: newId(), ...base, timerStartedAt: new Date() }),
      "one_running_timer_per_user"
    );
  });

  it("lets a second timer start once the first is stopped", async () => {
    const base = await timeFixture();
    const first = newId();

    await db.insert(s.timeEntries).values({ id: first, ...base, timerStartedAt: new Date() });
    await db.update(s.timeEntries).set({ timerStartedAt: null }).where(eq(s.timeEntries.id, first));
    await db.insert(s.timeEntries).values({ id: newId(), ...base, timerStartedAt: new Date() });

    const rows = await db.select().from(s.timeEntries);
    expect(rows.filter((r) => r.timerStartedAt !== null)).toHaveLength(1);
  });

  it("ignores soft-deleted rows when enforcing the running timer", async () => {
    const base = await timeFixture();
    await db.insert(s.timeEntries).values({
      id: newId(), ...base, timerStartedAt: new Date(), deletedAt: new Date(),
    });

    // A deleted running entry must not block a new one.
    await db.insert(s.timeEntries).values({ id: newId(), ...base, timerStartedAt: new Date() });

    const live = await db.select().from(s.timeEntries);
    expect(live.filter((r) => r.timerStartedAt !== null && r.deletedAt === null)).toHaveLength(1);
  });

  it("refuses a negative duration", async () => {
    const base = await timeFixture();
    await expectConstraintViolation(
      db.insert(s.timeEntries).values({ id: newId(), ...base, durationSeconds: -1 }),
      "time_entries_duration_non_negative"
    );
  });
});

describe("user rates", () => {
  it("refuses two open-ended rates of the same kind", async () => {
    const userId = await makeUser({ profileId: profiles.member! });
    await db.insert(s.userRates).values({ id: newId(), userId, kind: "billable", amountCents: 10000 });

    await expectConstraintViolation(
      db.insert(s.userRates).values({ id: newId(), userId, kind: "billable", amountCents: 12000 }),
      "user_rates_no_overlap"
    );
  });

  it("refuses overlapping dated ranges", async () => {
    const userId = await makeUser({ profileId: profiles.member! });
    await db.insert(s.userRates).values({
      id: newId(), userId, kind: "cost", amountCents: 5000, startsOn: "2026-01-01", endsOn: "2026-06-30",
    });

    // Ranges are inclusive at both ends, so sharing 30 June is an overlap.
    await expectConstraintViolation(
      db.insert(s.userRates).values({
        id: newId(), userId, kind: "cost", amountCents: 5500, startsOn: "2026-06-30", endsOn: "2026-12-31",
      }),
      "user_rates_no_overlap"
    );
  });

  it("allows adjacent ranges that do not overlap", async () => {
    const userId = await makeUser({ profileId: profiles.member! });
    await db.insert(s.userRates).values({
      id: newId(), userId, kind: "cost", amountCents: 5000, startsOn: "2026-01-01", endsOn: "2026-06-30",
    });
    await db.insert(s.userRates).values({
      id: newId(), userId, kind: "cost", amountCents: 5500, startsOn: "2026-07-01", endsOn: null,
    });

    const rates = await db.select().from(s.userRates);
    expect(rates).toHaveLength(2);
  });

  it("keeps billable and cost rates independent", async () => {
    const userId = await makeUser({ profileId: profiles.member! });
    await db.insert(s.userRates).values({ id: newId(), userId, kind: "billable", amountCents: 15000 });
    await db.insert(s.userRates).values({ id: newId(), userId, kind: "cost", amountCents: 6000 });

    const rates = await db.select().from(s.userRates);
    expect(rates).toHaveLength(2);
  });
});

describe("uniqueness among the living", () => {
  it("refuses two active clients with the same name, case-insensitively", async () => {
    await makeClient("Acme Corporation");

    await expectConstraintViolation(
      db.insert(s.clients).values({ id: newId(), name: "acme corporation" }),
      "clients_name_unique"
    );
  });

  it("lets an archived name be reused", async () => {
    const first = await makeClient("Acme Corporation");
    await db.update(s.clients).set({ archivedAt: new Date() }).where(eq(s.clients.id, first));

    await db.insert(s.clients).values({ id: newId(), name: "Acme Corporation" });

    const rows = await db.select().from(s.clients);
    expect(rows).toHaveLength(2);
  });
});

describe("projects", () => {
  it("refuses a budget expressed in both hours and fees", async () => {
    const clientId = await makeClient();

    await expectConstraintViolation(
      db.insert(s.projects).values({
        id: newId(), clientId, name: "Both budgets", billingType: "time_and_materials",
        budgetSeconds: 3600, budgetFeeCents: 100000,
      }),
      "budget_one_kind"
    );
  });
});

describe("invoice payments", () => {
  it("refuses a payment of zero or less", async () => {
    const clientId = await makeClient();
    const invoiceId = newId();
    await db.insert(s.invoices).values({
      id: invoiceId, clientId, number: "1", issueDate: "2026-08-01", dueDate: "2026-08-31",
    });

    await expectConstraintViolation(
      db.insert(s.invoicePayments).values({
        id: newId(), invoiceId, amountCents: 0, paidAt: new Date(),
      }),
      "invoice_payments_positive"
    );
  });
});

describe("dates", () => {
  it("round-trips a calendar day without moving it", async () => {
    const base = await timeFixture();
    await db.insert(s.timeEntries).values({ id: newId(), ...base, spentOn: "2026-01-01", durationSeconds: 3600 });

    const [row] = await db.select({ spentOn: s.timeEntries.spentOn }).from(s.timeEntries);
    expect(row!.spentOn).toBe("2026-01-01");
  });
});

describe("referential integrity across projects", () => {
  it("refuses a time entry whose task belongs to a different project", async () => {
    const userId = await makeUser({ profileId: profiles.member! });
    const clientId = await makeClient();
    const projectA = await makeProject(clientId, { name: "Project A" });
    const projectB = await makeProject(clientId, { name: "Project B" });
    const taskId = await makeTask();
    const taskOnB = await makeProjectTask(projectB, taskId);

    // Billing project A while using project B's task, rate, and budget is the
    // kind of corruption that produces plausible-looking wrong numbers.
    await expectConstraintViolation(
      db.insert(s.timeEntries).values({
        id: newId(), userId, projectId: projectA, projectTaskId: taskOnB,
        spentOn: "2026-08-14", isBillable: true, durationSeconds: 3600,
      }),
      "time_entries_task_belongs_to_project"
    );
  });
});

describe("uniqueness across nullable columns", () => {
  it("refuses two client-wide retainers for one client", async () => {
    const clientId = await makeClient();
    await db.insert(s.retainers).values({ id: newId(), clientId, projectId: null });

    await expectConstraintViolation(
      db.insert(s.retainers).values({ id: newId(), clientId, projectId: null }),
      "retainers_client_project_unique"
    );
  });

  it("refuses two account-scope connections for one provider", async () => {
    await db.insert(s.integrationConnections).values({ id: newId(), provider: "google", scope: "account" });

    await expectConstraintViolation(
      db.insert(s.integrationConnections).values({ id: newId(), provider: "google", scope: "account" }),
      "integration_connections_unique"
    );
  });

  it("refuses an account-scope connection that names a user", async () => {
    const userId = await makeUser({ profileId: profiles.member! });

    await expectConstraintViolation(
      db.insert(s.integrationConnections).values({ id: newId(), provider: "slack", scope: "account", userId }),
      "integration_scope_coherent"
    );
  });
});

describe("enum-like columns", () => {
  it("refuses an unknown billing type", async () => {
    const clientId = await makeClient();
    await expectConstraintViolation(
      db.insert(s.projects).values({ id: newId(), clientId, name: "Bad", billingType: "hourly" }),
      "projects_billing_type_valid"
    );
  });

  it("refuses an unknown rate kind", async () => {
    const userId = await makeUser({ profileId: profiles.member! });
    await expectConstraintViolation(
      db.insert(s.userRates).values({ id: newId(), userId, kind: "overtime", amountCents: 1000 }),
      "user_rates_kind_valid"
    );
  });

  it("refuses a reimbursement state on a non-reimbursable expense", async () => {
    const userId = await makeUser({ profileId: profiles.member! });
    const clientId = await makeClient();
    const projectId = await makeProject(clientId);
    const categoryId = newId();
    await db.insert(s.expenseCategories).values({ id: categoryId, name: "Meals" });

    await expectConstraintViolation(
      db.insert(s.expenses).values({
        id: newId(), userId, projectId, categoryId, spentOn: "2026-08-14",
        totalCents: 1000, isReimbursable: false, reimbursementState: "pending",
      }),
      "expenses_reimbursement_coherent"
    );
  });

  it("refuses an invoice due before it is issued", async () => {
    const clientId = await makeClient();
    await expectConstraintViolation(
      db.insert(s.invoices).values({
        id: newId(), clientId, number: "X-1", issueDate: "2026-08-10", dueDate: "2026-08-01",
      }),
      "invoices_dates_ordered"
    );
  });
});

describe("money columns", () => {
  it("refuses to write a value that would lose cents", async () => {
    const clientId = await makeClient();
    await expect(
      db.insert(s.invoices).values({
        id: newId(), clientId, number: "X-2", issueDate: "2026-08-01", dueDate: "2026-08-31",
        totalCents: Number.MAX_SAFE_INTEGER + 2,
      })
    ).rejects.toThrow(/safe whole number of cents/);
  });
});
