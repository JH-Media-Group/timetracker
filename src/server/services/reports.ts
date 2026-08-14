/**
 * Reports.
 *
 * Two rules run through everything here.
 *
 * First, money aggregates sum `seconds * rate_cents` and divide by 3600 exactly
 * once, at the end. Dividing per row truncates per row, and the error only ever
 * goes one direction, so a year of entries drifts measurably against a
 * migration that has to reconcile to the cent.
 *
 * Second, group rows and totals are computed **here**, not in the browser. The
 * client grid is AG Grid Community, which has no aggregation, and a total
 * computed client-side could not honour the permission scoping or the rounding
 * rules. `meta.totals` always covers the whole result set, never the page.
 */

import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { assertCan, assertCanAny, type Ctx } from "@/server/ctx";
import * as s from "@/server/db/schema";
import { clientScope, projectScope, timeEntryScope } from "@/server/auth/scope";
import { toNumber } from "@/server/db/sql-money";
import { roundSeconds, type RoundingRule } from "@/domain/rounding";
import { profitFrom, recogniseFee } from "@/domain/profitability";
import { displayState, type InvoiceState } from "@/domain/invoices";
import { dayIn, type IsoDate } from "@/domain/calendar";
import { getSettings, roundingRule } from "./settings";

export interface Period {
  from: IsoDate;
  to: IsoDate;
}

export type TimeGroupBy = "client" | "project" | "task" | "user";

/* ============================================================= time report */

export interface TimeReportRow {
  id: string;
  name: string;
  sub: string | null;
  totalSeconds: number;
  billableSeconds: number;
  nonBillableSeconds: number;
  billableCents: number;
  share: number;
}

export interface TimeReport {
  rows: TimeReportRow[];
  totals: {
    totalSeconds: number;
    billableSeconds: number;
    nonBillableSeconds: number;
    billableCents: number;
  };
  /** Weekly buckets for the chart, billable and non-billable. */
  series: { label: string; weekStart: string; billableSeconds: number; nonBillableSeconds: number }[];
  rounding: RoundingRule;
}

export async function timeReport(
  ctx: Ctx,
  input: Period & { groupBy?: TimeGroupBy; userId?: string; projectId?: string; clientId?: string }
): Promise<TimeReport> {
  assertCan(ctx, "report:view_own");
  const groupBy = input.groupBy ?? "client";

  const where = and(
    isNull(s.timeEntries.deletedAt),
    isNull(s.timeEntries.timerStartedAt),
    sql`${s.timeEntries.spentOn} >= ${input.from}`,
    sql`${s.timeEntries.spentOn} <= ${input.to}`,
    timeEntryScope(ctx, { requestedUserId: input.userId }),
    input.userId ? eq(s.timeEntries.userId, input.userId) : sql`true`,
    input.projectId ? eq(s.timeEntries.projectId, input.projectId) : sql`true`,
    input.clientId ? eq(s.projects.clientId, input.clientId) : sql`true`
  );

  // Every dimension is expressed as SQL rather than as a column reference, so
  // the four shapes share one type and one query.
  const dimension: Record<TimeGroupBy, { id: SQL<string>; name: SQL<string>; sub: SQL<string | null> }> = {
    client: {
      id: sql<string>`${s.clients.id}`,
      name: sql<string>`${s.clients.name}`,
      sub: sql<string | null>`NULL::text`,
    },
    project: {
      id: sql<string>`${s.projects.id}`,
      name: sql<string>`${s.projects.name}`,
      // Aggregated rather than grouped: Postgres refuses a bare NULL in GROUP BY,
      // and every row in a project group shares one client name anyway.
      sub: sql<string | null>`MIN(${s.clients.name})`,
    },
    task: {
      id: sql<string>`${s.tasks.id}`,
      name: sql<string>`${s.tasks.name}`,
      sub: sql<string | null>`NULL::text`,
    },
    user: {
      id: sql<string>`${s.users.id}`,
      name: sql<string>`${s.users.firstName} || ' ' || ${s.users.lastName}`,
      sub: sql<string | null>`NULL::text`,
    },
  };

  const dim = dimension[groupBy];

  const rows = await ctx.db
    .select({
      id: dim.id,
      name: dim.name,
      sub: dim.sub,
      totalSeconds: sql<string>`COALESCE(SUM(${s.timeEntries.durationSeconds}), 0)::text`,
      billableSeconds: sql<string>`COALESCE(SUM(CASE WHEN ${s.timeEntries.isBillable} THEN ${s.timeEntries.durationSeconds} ELSE 0 END), 0)::text`,
      // Sum the products, divide once. See the file header.
      billableCents: sql<string>`COALESCE(ROUND(SUM(${s.timeEntries.durationSeconds}::bigint * ${s.timeEntries.billableRateCents})::numeric / 3600), 0)::text`,
    })
    .from(s.timeEntries)
    .innerJoin(s.projects, eq(s.projects.id, s.timeEntries.projectId))
    .innerJoin(s.clients, eq(s.clients.id, s.projects.clientId))
    .innerJoin(s.projectTasks, eq(s.projectTasks.id, s.timeEntries.projectTaskId))
    .innerJoin(s.tasks, eq(s.tasks.id, s.projectTasks.taskId))
    .innerJoin(s.users, eq(s.users.id, s.timeEntries.userId))
    .where(where)
    .groupBy(dim.id, dim.name)
    .orderBy(sql`SUM(${s.timeEntries.durationSeconds}) DESC NULLS LAST`);

  const parsed = rows.map((r) => ({
    id: String(r.id),
    name: r.name,
    sub: r.sub,
    totalSeconds: toNumber(r.totalSeconds, "totalSeconds"),
    billableSeconds: toNumber(r.billableSeconds, "billableSeconds"),
    billableCents: toNumber(r.billableCents, "billableCents"),
  }));

  const totalSeconds = parsed.reduce((a, r) => a + r.totalSeconds, 0);
  const billableSeconds = parsed.reduce((a, r) => a + r.billableSeconds, 0);
  const billableCents = parsed.reduce((a, r) => a + r.billableCents, 0);

  // Weekly buckets for the chart, from one extra grouped query rather than by
  // re-reading every entry.
  const weekly = await ctx.db
    .select({
      weekStart: sql<string>`to_char(date_trunc('week', ${s.timeEntries.spentOn}::date), 'YYYY-MM-DD')`,
      billableSeconds: sql<string>`COALESCE(SUM(CASE WHEN ${s.timeEntries.isBillable} THEN ${s.timeEntries.durationSeconds} ELSE 0 END), 0)::text`,
      nonBillableSeconds: sql<string>`COALESCE(SUM(CASE WHEN ${s.timeEntries.isBillable} THEN 0 ELSE ${s.timeEntries.durationSeconds} END), 0)::text`,
    })
    .from(s.timeEntries)
    .innerJoin(s.projects, eq(s.projects.id, s.timeEntries.projectId))
    .where(where)
    .groupBy(sql`date_trunc('week', ${s.timeEntries.spentOn}::date)`)
    .orderBy(sql`date_trunc('week', ${s.timeEntries.spentOn}::date)`);

  return {
    rows: parsed.map((r) => ({
      ...r,
      nonBillableSeconds: r.totalSeconds - r.billableSeconds,
      share: totalSeconds ? r.totalSeconds / totalSeconds : 0,
    })),
    totals: {
      totalSeconds,
      billableSeconds,
      nonBillableSeconds: totalSeconds - billableSeconds,
      billableCents,
    },
    series: weekly.map((w) => ({
      label: w.weekStart,
      weekStart: w.weekStart,
      billableSeconds: toNumber(w.billableSeconds),
      nonBillableSeconds: toNumber(w.nonBillableSeconds),
    })),
    rounding: await roundingRule(ctx),
  };
}

/* ==================================================== profitability report */

export interface ProfitRow {
  id: string;
  name: string;
  sub: string | null;
  revenueCents: number;
  costCents: number;
  profitCents: number;
  marginPct: number | null;
  returnOnCostPct: number | null;
  missingBillableRate: boolean;
}

export interface ProfitabilityReport {
  rows: ProfitRow[];
  totals: { revenueCents: number; costCents: number; profitCents: number; marginPct: number | null };
  flags: { kind: string; message: string; entityIds: string[] }[];
  invoicedCents: number;
}

export async function profitabilityReport(
  ctx: Ctx,
  input: Period & { groupBy?: "project" | "client" }
): Promise<ProfitabilityReport> {
  assertCan(ctx, "report:view_financial");
  const groupBy = input.groupBy ?? "project";

  // Per project first, because fixed-fee recognition is a per-project rule that
  // cannot be expressed as a GROUP BY.
  const perProject = await ctx.db
    .select({
      projectId: s.projects.id,
      projectName: s.projects.name,
      clientId: s.clients.id,
      clientName: s.clients.name,
      billingType: s.projects.billingType,
      feeCents: s.projects.feeCents,
      feeCadence: s.projects.feeCadence,
      startsOn: s.projects.startsOn,
      endsOn: s.projects.endsOn,
      billableCents: sql<string>`COALESCE(ROUND(SUM(CASE WHEN ${s.timeEntries.isBillable} THEN ${s.timeEntries.durationSeconds}::bigint * ${s.timeEntries.billableRateCents} ELSE 0 END)::numeric / 3600), 0)::text`,
      costCents: sql<string>`COALESCE(ROUND(SUM(${s.timeEntries.durationSeconds}::bigint * ${s.timeEntries.costRateCents})::numeric / 3600), 0)::text`,
      seconds: sql<string>`COALESCE(SUM(${s.timeEntries.durationSeconds}), 0)::text`,
      missingRate: sql<boolean>`BOOL_OR(${s.timeEntries.isBillable} AND ${s.timeEntries.billableRateCents} = 0)`,
    })
    .from(s.projects)
    .innerJoin(s.clients, eq(s.clients.id, s.projects.clientId))
    .leftJoin(
      s.timeEntries,
      and(
        eq(s.timeEntries.projectId, s.projects.id),
        isNull(s.timeEntries.deletedAt),
        isNull(s.timeEntries.timerStartedAt),
        sql`${s.timeEntries.spentOn} >= ${input.from}`,
        sql`${s.timeEntries.spentOn} <= ${input.to}`
      )
    )
    .where(projectScope(ctx))
    .groupBy(
      s.projects.id, s.projects.name, s.clients.id, s.clients.name,
      s.projects.billingType, s.projects.feeCents, s.projects.feeCadence,
      s.projects.startsOn, s.projects.endsOn
    );

  // Expenses are a separate aggregate: joining them alongside time would
  // multiply the time rows by the expense rows and double every hour.
  const expenseRows = await ctx.db
    .select({
      projectId: s.expenses.projectId,
      billableCents: sql<string>`COALESCE(SUM(CASE WHEN ${s.expenses.isBillable} THEN ${s.expenses.totalCents} ELSE 0 END), 0)::text`,
      totalCents: sql<string>`COALESCE(SUM(${s.expenses.totalCents}), 0)::text`,
    })
    .from(s.expenses)
    .where(
      and(
        isNull(s.expenses.deletedAt),
        sql`${s.expenses.spentOn} >= ${input.from}`,
        sql`${s.expenses.spentOn} <= ${input.to}`
      )
    )
    .groupBy(s.expenses.projectId);

  const expenseByProject = new Map(
    expenseRows.map((e) => [e.projectId, { billable: toNumber(e.billableCents), total: toNumber(e.totalCents) }])
  );

  // Total hours per project across the project's whole life, for the
  // hours-prorated fixed-fee fallback.
  const lifetimeRows = await ctx.db
    .select({
      projectId: s.timeEntries.projectId,
      seconds: sql<string>`COALESCE(SUM(${s.timeEntries.durationSeconds}), 0)::text`,
    })
    .from(s.timeEntries)
    .where(and(isNull(s.timeEntries.deletedAt), isNull(s.timeEntries.timerStartedAt)))
    .groupBy(s.timeEntries.projectId);
  const lifetimeByProject = new Map(lifetimeRows.map((r) => [r.projectId, toNumber(r.seconds)]));

  const missingRates: string[] = [];
  const missingDates: string[] = [];

  const projectFigures = perProject.map((p) => {
    const seconds = toNumber(p.seconds);
    const expenses = expenseByProject.get(p.projectId) ?? { billable: 0, total: 0 };

    let revenueCents: number;
    if (p.billingType === "non_billable") {
      revenueCents = 0;
    } else if (p.billingType === "fixed_fee") {
      const recognition = recogniseFee({
        feeCents: p.feeCents ?? 0,
        cadence: (p.feeCadence as "single" | "monthly") ?? "single",
        startsOn: p.startsOn,
        endsOn: p.endsOn,
        period: { from: input.from, to: input.to },
        hoursInPeriod: seconds / 3600,
        hoursTotal: (lifetimeByProject.get(p.projectId) ?? 0) / 3600,
      });
      revenueCents = recognition.cents + expenses.billable;
      if (recognition.missingProjectDates && seconds > 0) missingDates.push(p.projectId);
    } else {
      revenueCents = toNumber(p.billableCents) + expenses.billable;
    }

    const costCents = toNumber(p.costCents) + expenses.total;
    if (p.missingRate) missingRates.push(p.projectId);

    return {
      projectId: p.projectId,
      projectName: p.projectName,
      clientId: p.clientId,
      clientName: p.clientName,
      revenueCents,
      costCents,
      missingRate: Boolean(p.missingRate),
      hasActivity: seconds > 0 || expenses.total > 0,
    };
  });

  const active = projectFigures.filter((p) => p.hasActivity);

  const grouped = new Map<string, { name: string; sub: string | null; revenue: number; cost: number; missingRate: boolean }>();
  for (const p of active) {
    const key = groupBy === "project" ? p.projectId : p.clientId;
    const existing = grouped.get(key);
    if (existing) {
      existing.revenue += p.revenueCents;
      existing.cost += p.costCents;
      existing.missingRate ||= p.missingRate;
    } else {
      grouped.set(key, {
        name: groupBy === "project" ? p.projectName : p.clientName,
        sub: groupBy === "project" ? p.clientName : null,
        revenue: p.revenueCents,
        cost: p.costCents,
        missingRate: p.missingRate,
      });
    }
  }

  const rows: ProfitRow[] = [...grouped.entries()]
    .map(([id, g]) => {
      const figures = profitFrom(g.revenue, g.cost);
      return {
        id,
        name: g.name,
        sub: g.sub,
        revenueCents: figures.revenueCents,
        costCents: figures.costCents,
        profitCents: figures.profitCents,
        marginPct: figures.marginPct,
        returnOnCostPct: figures.returnOnCostPct,
        missingBillableRate: g.missingRate,
      };
    })
    .sort((a, b) => b.profitCents - a.profitCents);

  const revenueCents = rows.reduce((a, r) => a + r.revenueCents, 0);
  const costCents = rows.reduce((a, r) => a + r.costCents, 0);
  const totals = profitFrom(revenueCents, costCents);

  const [invoiced] = await ctx.db
    .select({
      total: sql<string>`COALESCE(SUM(${s.invoices.totalCents}), 0)::text`,
    })
    .from(s.invoices)
    .where(and(isNull(s.invoices.deletedAt), sql`${s.invoices.state} <> 'draft'`));

  const flags: ProfitabilityReport["flags"] = [];
  if (missingRates.length) {
    flags.push({
      kind: "missing_billable_rate",
      message: "Some billable time has no rate, so revenue is understated.",
      entityIds: [...new Set(missingRates)],
    });
  }
  if (missingDates.length) {
    flags.push({
      kind: "missing_project_dates",
      message: "Some fixed-fee projects have no dates, so their fee is spread by hours instead.",
      entityIds: [...new Set(missingDates)],
    });
  }

  return {
    rows,
    totals: {
      revenueCents: totals.revenueCents,
      costCents: totals.costCents,
      profitCents: totals.profitCents,
      marginPct: totals.marginPct,
    },
    flags,
    invoicedCents: toNumber(invoiced?.total ?? "0"),
  };
}

/* ============================================================= team report */

export interface TeamRow {
  userId: string;
  name: string;
  employmentType: string;
  trackedSeconds: number;
  billableSeconds: number;
  capacitySeconds: number;
  utilization: number;
  billableShare: number;
  costCents: number;
}

export async function teamReport(
  ctx: Ctx,
  input: Period & { employmentType?: "employee" | "contractor" }
): Promise<{ rows: TeamRow[]; totals: Omit<TeamRow, "userId" | "name" | "employmentType"> }> {
  // report:view_all is strictly wider, and an Executive Manager holds it
  // without holding report:view_team.
  assertCanAny(ctx, ["report:view_team", "report:view_all"]);

  const days =
    Math.round(
      (Date.UTC(+input.to.slice(0, 4), +input.to.slice(5, 7) - 1, +input.to.slice(8, 10)) -
        Date.UTC(+input.from.slice(0, 4), +input.from.slice(5, 7) - 1, +input.from.slice(8, 10))) /
        86_400_000
    ) + 1;
  const weeks = Math.max(days / 7, 0.001);

  const rows = await ctx.db
    .select({
      userId: s.users.id,
      firstName: s.users.firstName,
      lastName: s.users.lastName,
      employmentType: s.users.employmentType,
      weeklyCapacitySeconds: s.users.weeklyCapacitySeconds,
      trackedSeconds: sql<string>`COALESCE(SUM(${s.timeEntries.durationSeconds}), 0)::text`,
      billableSeconds: sql<string>`COALESCE(SUM(CASE WHEN ${s.timeEntries.isBillable} THEN ${s.timeEntries.durationSeconds} ELSE 0 END), 0)::text`,
      costCents: sql<string>`COALESCE(ROUND(SUM(${s.timeEntries.durationSeconds}::bigint * ${s.timeEntries.costRateCents})::numeric / 3600), 0)::text`,
    })
    .from(s.users)
    .leftJoin(
      s.timeEntries,
      and(
        eq(s.timeEntries.userId, s.users.id),
        isNull(s.timeEntries.deletedAt),
        isNull(s.timeEntries.timerStartedAt),
        sql`${s.timeEntries.spentOn} >= ${input.from}`,
        sql`${s.timeEntries.spentOn} <= ${input.to}`
      )
    )
    .where(
      and(
        isNull(s.users.archivedAt),
        input.employmentType ? eq(s.users.employmentType, input.employmentType) : sql`true`
      )
    )
    .groupBy(s.users.id, s.users.firstName, s.users.lastName, s.users.employmentType, s.users.weeklyCapacitySeconds);

  const canSeeCost = ctx.actor.capabilities.has("rates:view_cost") || ctx.actor.kind === "system";

  const parsed: TeamRow[] = rows
    .map((r) => {
      const trackedSeconds = toNumber(r.trackedSeconds);
      const billableSeconds = toNumber(r.billableSeconds);
      const capacitySeconds = Math.round(r.weeklyCapacitySeconds * weeks);
      return {
        userId: r.userId,
        name: `${r.firstName} ${r.lastName}`,
        employmentType: r.employmentType,
        trackedSeconds,
        billableSeconds,
        capacitySeconds,
        utilization: capacitySeconds ? trackedSeconds / capacitySeconds : 0,
        billableShare: trackedSeconds ? billableSeconds / trackedSeconds : 0,
        costCents: canSeeCost ? toNumber(r.costCents) : 0,
      };
    })
    .sort((a, b) => b.utilization - a.utilization);

  const trackedSeconds = parsed.reduce((a, r) => a + r.trackedSeconds, 0);
  const billableSeconds = parsed.reduce((a, r) => a + r.billableSeconds, 0);
  const capacitySeconds = parsed.reduce((a, r) => a + r.capacitySeconds, 0);

  return {
    rows: parsed,
    totals: {
      trackedSeconds,
      billableSeconds,
      capacitySeconds,
      utilization: capacitySeconds ? trackedSeconds / capacitySeconds : 0,
      billableShare: trackedSeconds ? billableSeconds / trackedSeconds : 0,
      costCents: parsed.reduce((a, r) => a + r.costCents, 0),
    },
  };
}

/* ======================================================== invoicing report */

export interface InvoicingReport {
  rows: {
    id: string;
    number: string;
    clientName: string;
    issueDate: string;
    dueDate: string;
    state: string;
    displayState: string;
    totalCents: number;
    paidCents: number;
    balanceCents: number;
    daysLate: number;
    bucket: string;
  }[];
  totals: { issuedCents: number; collectedCents: number; outstandingCents: number; overdueCents: number };
  aging: { bucket: string; amountCents: number }[];
  monthly: { month: string; issuedCents: number; collectedCents: number }[];
  averageDaysToPay: number | null;
}

const BUCKETS = ["Current", "1 to 30 days", "31 to 60 days", "61 to 90 days", "Over 90 days"] as const;

const bucketFor = (daysLate: number): string =>
  daysLate <= 0 ? BUCKETS[0] : daysLate <= 30 ? BUCKETS[1] : daysLate <= 60 ? BUCKETS[2] : daysLate <= 90 ? BUCKETS[3] : BUCKETS[4];

export async function invoicingReport(ctx: Ctx, input: Period): Promise<InvoicingReport> {
  assertCan(ctx, "report:view_financial");

  const settings = await getSettings(ctx);
  const today = dayIn(settings.timezone, ctx.now());

  const rows = await ctx.db
    .select({
      id: s.invoices.id,
      number: s.invoices.number,
      clientName: s.clients.name,
      issueDate: s.invoices.issueDate,
      dueDate: s.invoices.dueDate,
      state: s.invoices.state,
      totalCents: s.invoices.totalCents,
      paidCents: s.invoices.paidCents,
      sentAt: s.invoices.sentAt,
      paidAt: s.invoices.paidAt,
    })
    .from(s.invoices)
    .innerJoin(s.clients, eq(s.clients.id, s.invoices.clientId))
    .where(and(isNull(s.invoices.deletedAt), clientScope(ctx)))
    .orderBy(sql`${s.invoices.dueDate} ASC`);

  const daysBetween = (a: string, b: string) =>
    Math.round(
      (Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) -
        Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) /
        86_400_000
    );

  const detailed = rows.map((r) => {
    const daysLate = Math.max(0, daysBetween(r.dueDate, today));
    return {
      id: r.id,
      number: r.number,
      clientName: r.clientName,
      issueDate: r.issueDate,
      dueDate: r.dueDate,
      state: r.state,
      displayState: displayState({
        state: r.state as InvoiceState,
        dueDate: r.dueDate,
        totalCents: r.totalCents,
        paidCents: r.paidCents,
        today,
      }),
      totalCents: r.totalCents,
      paidCents: r.paidCents,
      balanceCents: r.totalCents - r.paidCents,
      daysLate: r.state === "open" ? daysLate : 0,
      bucket: r.state === "open" ? bucketFor(daysBetween(r.dueDate, today)) : "Settled",
      sentAt: r.sentAt,
      paidAt: r.paidAt,
    };
  });

  const inPeriod = detailed.filter((r) => r.issueDate >= input.from && r.issueDate <= input.to);
  const open = detailed.filter((r) => r.state === "open");

  const aging = BUCKETS.map((bucket) => ({
    bucket,
    amountCents: open.filter((r) => r.bucket === bucket).reduce((a, r) => a + r.balanceCents, 0),
  }));

  const monthlyMap = new Map<string, { issued: number; collected: number }>();
  for (const r of detailed) {
    const month = r.issueDate.slice(0, 7);
    const bucket = monthlyMap.get(month) ?? { issued: 0, collected: 0 };
    bucket.issued += r.totalCents;
    bucket.collected += r.paidCents;
    monthlyMap.set(month, bucket);
  }

  const paidInvoices = detailed.filter((r) => r.state === "paid" && r.paidAt && r.sentAt);
  const averageDaysToPay = paidInvoices.length
    ? Math.round(
        paidInvoices.reduce((a, r) => a + (r.paidAt!.getTime() - r.sentAt!.getTime()) / 86_400_000, 0) /
          paidInvoices.length
      )
    : null;

  return {
    rows: detailed.map(({ sentAt: _sentAt, paidAt: _paidAt, ...rest }) => rest),
    totals: {
      issuedCents: inPeriod.reduce((a, r) => a + r.totalCents, 0),
      collectedCents: inPeriod.reduce((a, r) => a + r.paidCents, 0),
      outstandingCents: open.reduce((a, r) => a + r.balanceCents, 0),
      overdueCents: open.filter((r) => r.daysLate > 0).reduce((a, r) => a + r.balanceCents, 0),
    },
    aging,
    monthly: [...monthlyMap.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([month, v]) => ({ month, issuedCents: v.issued, collectedCents: v.collected })),
    averageDaysToPay,
  };
}

/* ======================================================== project summary */

export interface ProjectSummary {
  totalSeconds: number;
  billableSeconds: number;
  nonBillableSeconds: number;
  billableCents: number;
  costCents: number;
  expenseCents: number;
  invoicedCents: number;
  uninvoicedCents: number;
  budget: {
    by: string;
    budget: number | null;
    spent: number;
    remaining: number | null;
    percentUsed: number | null;
    monthly: boolean;
  };
}

/**
 * Everything the five KPI cards need, in one request.
 *
 * Built as one query set rather than seven, because the project page should
 * cost two round trips (summary and chart) rather than one per card.
 */
export async function projectSummary(ctx: Ctx, projectId: string): Promise<ProjectSummary> {
  const [project] = await ctx.db
    .select()
    .from(s.projects)
    .where(and(eq(s.projects.id, projectId), projectScope(ctx)))
    .limit(1);
  if (!project) throw new Error("not_found");

  const settings = await getSettings(ctx);
  const today = dayIn(settings.timezone, ctx.now());
  const monthStart = `${today.slice(0, 7)}-01`;

  // A monthly budget only counts this month's spend.
  const budgetWindow = project.budgetResetsMonthly
    ? and(sql`${s.timeEntries.spentOn} >= ${monthStart}`, sql`${s.timeEntries.spentOn} <= ${today}`)
    : sql`true`;

  const [time] = await ctx.db
    .select({
      totalSeconds: sql<string>`COALESCE(SUM(${s.timeEntries.durationSeconds}), 0)::text`,
      billableSeconds: sql<string>`COALESCE(SUM(CASE WHEN ${s.timeEntries.isBillable} THEN ${s.timeEntries.durationSeconds} ELSE 0 END), 0)::text`,
      billableCents: sql<string>`COALESCE(ROUND(SUM(CASE WHEN ${s.timeEntries.isBillable} THEN ${s.timeEntries.durationSeconds}::bigint * ${s.timeEntries.billableRateCents} ELSE 0 END)::numeric / 3600), 0)::text`,
      costCents: sql<string>`COALESCE(ROUND(SUM(${s.timeEntries.durationSeconds}::bigint * ${s.timeEntries.costRateCents})::numeric / 3600), 0)::text`,
      uninvoicedCents: sql<string>`COALESCE(ROUND(SUM(CASE WHEN ${s.timeEntries.isBillable} AND ${s.timeEntries.invoiceId} IS NULL AND NOT ${s.timeEntries.billedExternally} THEN ${s.timeEntries.durationSeconds}::bigint * ${s.timeEntries.billableRateCents} ELSE 0 END)::numeric / 3600), 0)::text`,
      budgetSeconds: sql<string>`COALESCE(SUM(CASE WHEN ${budgetWindow} THEN ${s.timeEntries.durationSeconds} ELSE 0 END), 0)::text`,
      budgetCents: sql<string>`COALESCE(ROUND(SUM(CASE WHEN ${budgetWindow} AND ${s.timeEntries.isBillable} THEN ${s.timeEntries.durationSeconds}::bigint * ${s.timeEntries.billableRateCents} ELSE 0 END)::numeric / 3600), 0)::text`,
    })
    .from(s.timeEntries)
    .where(and(eq(s.timeEntries.projectId, projectId), isNull(s.timeEntries.deletedAt), isNull(s.timeEntries.timerStartedAt)));

  const [expenses] = await ctx.db
    .select({
      totalCents: sql<string>`COALESCE(SUM(${s.expenses.totalCents}), 0)::text`,
      uninvoicedCents: sql<string>`COALESCE(SUM(CASE WHEN ${s.expenses.isBillable} AND ${s.expenses.invoiceId} IS NULL AND NOT ${s.expenses.billedExternally} THEN ${s.expenses.totalCents} ELSE 0 END), 0)::text`,
    })
    .from(s.expenses)
    .where(and(eq(s.expenses.projectId, projectId), isNull(s.expenses.deletedAt)));

  const [invoiced] = await ctx.db
    .select({ totalCents: sql<string>`COALESCE(SUM(${s.invoices.totalCents}), 0)::text` })
    .from(s.invoices)
    .innerJoin(s.invoiceProjects, eq(s.invoiceProjects.invoiceId, s.invoices.id))
    .where(
      and(
        eq(s.invoiceProjects.projectId, projectId),
        isNull(s.invoices.deletedAt),
        sql`${s.invoices.state} <> 'draft'`
      )
    );

  const totalSeconds = toNumber(time?.totalSeconds ?? "0");
  const billableSeconds = toNumber(time?.billableSeconds ?? "0");
  const expenseCents = toNumber(expenses?.totalCents ?? "0");
  const invoicedCents = toNumber(invoiced?.totalCents ?? "0");

  // Fixed fee bills the fee, not the hours, so what is left to invoice is the
  // fee minus what has been invoiced, floored at zero: over-billing shows zero
  // rather than a negative receivable.
  const uninvoicedCents =
    project.billingType === "fixed_fee"
      ? Math.max(0, (project.feeCents ?? 0) - invoicedCents)
      : toNumber(time?.uninvoicedCents ?? "0") + toNumber(expenses?.uninvoicedCents ?? "0");

  const budgetIsHours = project.budgetBy.endsWith("_hours");
  const budgetValue = budgetIsHours ? project.budgetSeconds : project.budgetFeeCents;
  const budgetSpent = budgetIsHours ? toNumber(time?.budgetSeconds ?? "0") : toNumber(time?.budgetCents ?? "0");

  return {
    totalSeconds,
    billableSeconds,
    nonBillableSeconds: totalSeconds - billableSeconds,
    billableCents: toNumber(time?.billableCents ?? "0"),
    costCents: toNumber(time?.costCents ?? "0") + expenseCents,
    expenseCents,
    invoicedCents,
    uninvoicedCents,
    budget: {
      by: project.budgetBy,
      budget: budgetValue ?? null,
      spent: budgetSpent,
      remaining: budgetValue == null ? null : budgetValue - budgetSpent,
      percentUsed: budgetValue ? budgetSpent / budgetValue : null,
      monthly: project.budgetResetsMonthly,
    },
  };
}

/** The project page chart: cumulative value or hours per week. */
export async function projectChart(
  ctx: Ctx,
  projectId: string,
  metric: "progress" | "hours" = "progress"
): Promise<{ label: string; value: number }[]> {
  const [project] = await ctx.db
    .select({ id: s.projects.id })
    .from(s.projects)
    .where(and(eq(s.projects.id, projectId), projectScope(ctx)))
    .limit(1);
  if (!project) throw new Error("not_found");

  const rows = await ctx.db
    .select({
      weekStart: sql<string>`to_char(date_trunc('week', ${s.timeEntries.spentOn}::date), 'YYYY-MM-DD')`,
      seconds: sql<string>`COALESCE(SUM(${s.timeEntries.durationSeconds}), 0)::text`,
      cents: sql<string>`COALESCE(ROUND(SUM(${s.timeEntries.durationSeconds}::bigint * ${s.timeEntries.billableRateCents})::numeric / 3600), 0)::text`,
    })
    .from(s.timeEntries)
    .where(and(eq(s.timeEntries.projectId, projectId), isNull(s.timeEntries.deletedAt), isNull(s.timeEntries.timerStartedAt)))
    .groupBy(sql`date_trunc('week', ${s.timeEntries.spentOn}::date)`)
    .orderBy(sql`date_trunc('week', ${s.timeEntries.spentOn}::date)`);

  if (metric === "hours") {
    return rows.map((r) => ({ label: r.weekStart, value: toNumber(r.seconds) / 3600 }));
  }

  // Progress is cumulative: the question is how close the project is to its
  // budget, not what happened in one week.
  let running = 0;
  return rows.map((r) => {
    running += toNumber(r.cents);
    return { label: r.weekStart, value: running };
  });
}

export { roundSeconds };
