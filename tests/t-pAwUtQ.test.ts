import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, s, closeDb, raw } from "./helpers";
import { newId } from "@/server/db/ids";
import { timeEditFixture } from "./support/time-edit-fixture";
import { timeRollups } from "@/server/services/time-rollups";
import { projectBudgetFromTotals, projectBudget } from "@/lib/derive";
import type { Project, TimeEntry } from "@/lib/types";

let f: Awaited<ReturnType<typeof timeEditFixture>>;
beforeEach(async () => { f = await timeEditFixture(); });
afterAll(closeDb);

describe("t-pAwUtQ complete scoped list totals", () => {
  it("aggregates 60,001 records in SQL, rounds once, and never returns entry bodies", async () => {
    await db.execute(raw`INSERT INTO time_entries (id,user_id,project_id,project_task_id,spent_on,duration_seconds,billable_rate_cents,cost_rate_cents,is_billable)
      SELECT gen_random_uuid(), ${f.owner}::uuid, ${f.projectId}::uuid, ${f.projectTaskId}::uuid, '2026-11-05'::date, 1, 100, 50, true FROM generate_series(1,60000)`);
    for (const group of ["project", "client", "task"] as const) {
      const result = await timeRollups(f.administrator, group);
      expect(result).toEqual([{ id: group === "project" ? f.projectId : group === "client" ? f.clientId : f.taskId, seconds: 63600, billableCents: 13667, uninvoicedCents: 13667, costCents: 4833 }]);
      expect(JSON.stringify(result).length).toBeLessThan(250);
    }
  });

  it("preserves own-row visibility, cost redaction, and exclusions from uninvoiced totals", async () => {
    await db.insert(s.timeEntries).values([
      { id: newId(), userId: f.admin, projectId: f.projectId, projectTaskId: f.projectTaskId, spentOn: "2026-11-05", durationSeconds: 3600, billableRateCents: 20000, costRateCents: 8000, isBillable: true },
      { id: newId(), userId: f.owner, projectId: f.projectId, projectTaskId: f.projectTaskId, spentOn: "2026-11-05", durationSeconds: 3600, billableRateCents: 12000, isBillable: true, billedExternally: true },
      { id: newId(), userId: f.owner, projectId: f.projectId, projectTaskId: f.projectTaskId, spentOn: "2026-11-05", durationSeconds: 3600, billableRateCents: 12000, isBillable: true, deletedAt: new Date() },
    ]);
    expect(await timeRollups(f.member, "client")).toEqual([{ id: f.clientId, seconds: 7200, billableCents: 24000, uninvoicedCents: 12000 }]);
    expect((await timeRollups(f.administrator, "client"))[0]).toMatchObject({ seconds: 10800, uninvoicedCents: 32000, costCents: 12000 });
  });

  it("keeps budget calculations identical when using server totals", () => {
    for (const budgetBy of ["none", "project_hours", "project_fees"] as const) {
      const project = { budgetBy, budgetSeconds: 7200, budgetFeeCents: 20000, budgetResetsMonthly: false, budgetAlertPercent: 70 } as Project;
      const entries = [{ durationSeconds: 3600, billableRateCents: 12000 }] as TimeEntry[];
      expect(projectBudgetFromTotals(project, { seconds: 3600, billableCents: 12000 })).toEqual(projectBudget(project, entries));
    }
  });
});
