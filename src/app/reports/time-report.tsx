"use client";

/**
 * Time report.
 *
 * Hours over the period, split by whatever dimension you pick. The stacked bars
 * carry the billable split because that is the question behind almost every
 * "how many hours" question anyone actually asks.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import type { ColDef } from "ag-grid-community";
import * as api from "@/lib/api";
import { formatDuration, formatMoney, formatPercent, toDate } from "@/lib/format";
import { BriefcaseBusiness, CircleDollarSign, Clock, ListTree, PieChart, X } from "lucide-react";
import { Badge, Card, Meter, Segmented, Select } from "@/components/ui/primitives";
import { DataGrid } from "@/components/app/data-grid";
import { StackedBarChart, Legend } from "@/components/app/charts";
import { Kpi, KpiHelpLabel } from "@/components/app/kpi";
import { useApp, useCan } from "@/components/app/providers";
import { useUrlState, type Period } from "@/components/app/page-chrome";
import type { GridRow } from "@/components/ui/grid";

type GroupBy = "client" | "project" | "task" | "person";

interface Row {
  _id: string; _kind: "data";
  id: string; name: string; sub: string;
  total: number; billable: number; nonBillable: number;
  share: number; amount: number;
}

export function TimeReport({ period }: { period: Period }) {
  const router = useRouter();
  const { params, set } = useUrlState();
  const can = useCan();

  /**
   * Scope filters, read from the URL (TALLY-41, TALLY-16).
   *
   * The endpoint has taken `userId` and `projectId` since it was written and
   * the seam has always passed them; the screen simply never read them. That is
   * why "My time report" showed everybody: the menu linked to
   * `?by=person&user=<id>`, the grouping was honoured and the person was not.
   */
  const userId = params.get("user") ?? undefined;
  const projectId = params.get("project") ?? undefined;

  /**
   * Grouping people by person when the report is already one person is a
   * one-row table. Scoped to somebody, the useful default is what they worked
   * on, so the link needs no grouping of its own.
   */
  const groupBy = (params.get("by") as GroupBy) || (userId ? "project" : "client");
  // The server calls the fourth dimension "user"; the button says "person",
  // because that is the word somebody would use.
  const dimension = groupBy === "person" ? "user" : groupBy;

  const { userById, projectById, projects } = useApp();

  const scopedTo = [
    userId ? [userById.get(userId)?.firstName, userById.get(userId)?.lastName].filter(Boolean).join(" ") : null,
    projectId ? projectById.get(projectId)?.name : null,
  ].filter(Boolean).join(" · ") || null;

  const { data, isLoading: loading } = useQuery({
    queryKey: ["report", "time", period.from, period.to, dimension, userId, projectId],
    queryFn: () =>
      api.timeReport({ from: period.from, to: period.to, groupBy: dimension, userId, projectId }),
  });

  const totals = React.useMemo(() => {
    const t = data?.totals ?? {};
    const total = Number(t.totalSeconds ?? 0);
    const billable = Number(t.billableSeconds ?? 0);
    return { total, billable, nonBillable: total - billable, amount: Number(t.billableCents ?? 0) };
  }, [data]);

  const rows = React.useMemo<GridRow<Row>[]>(
    () =>
      (data?.rows ?? []).map((r) => ({
        _id: String(r.id), _kind: "data" as const, id: String(r.id),
        name: String(r.name ?? ""), sub: String(r.sub ?? ""),
        total: Number(r.totalSeconds ?? 0),
        billable: Number(r.billableSeconds ?? 0),
        nonBillable: Number(r.nonBillableSeconds ?? 0),
        share: Number(r.share ?? 0),
        amount: Number(r.billableCents ?? 0),
      })),
    [data]
  );

  /** Hours per week across the period, split billable and non-billable. */
  const series = React.useMemo(() => {
    const weekly = (data?.meta.series ?? []) as {
      weekStart: string; billableSeconds: number; nonBillableSeconds: number;
    }[];
    return weekly.slice(-16).map((w) => ({
      label: toDate(w.weekStart).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      values: [w.billableSeconds / 3600, w.nonBillableSeconds / 3600],
    }));
  }, [data]);

  const columns = React.useMemo<ColDef[]>(() => [
    {
      colId: "name", field: "name", headerName:
        groupBy === "client" ? "Client" : groupBy === "project" ? "Project" : groupBy === "task" ? "Task" : "Person",
      flex: 1, minWidth: 240,
      cellRenderer: (p: { data?: Row }) => p.data && (
        <span className="flex min-w-0 flex-col justify-center leading-tight">
          <span className="truncate font-medium text-ink">{p.data.name}</span>
          {p.data.sub && <span className="truncate text-sm text-ink-tertiary">{p.data.sub}</span>}
        </span>
      ),
    },
    {
      colId: "share", headerName: "Share", width: 180, sortable: true,
      valueGetter: (p: { data?: Row }) => p.data?.share ?? 0,
      cellRenderer: (p: { data?: Row; value: number }) => p.data && (
        <span className="tly-meter-row flex w-full min-w-0 flex-1 items-center gap-2">
          <span className="tly-meter min-w-8 flex-1"><Meter segments={[{ value: p.value, tone: "billable" }]} /></span>
          <span className="w-10 shrink-0 text-right text-sm tabular-nums text-ink-secondary">{formatPercent(p.value)}</span>
        </span>
      ),
    },
    { colId: "billable", field: "billable", headerName: "Billable", type: "duration", width: 120 },
    { colId: "nonBillable", field: "nonBillable", headerName: "Non-billable", type: "duration", width: 140 },
    { colId: "total", field: "total", headerName: "Total hours", type: "duration", width: 130 },
    ...(can("rates:view_billable") ? [
      { colId: "amount", field: "amount", headerName: "If billed hourly", type: "money", width: 160 } as ColDef,
    ] : []),
  ], [groupBy, can]);

  const gridTotals = React.useMemo(() => ({
    name: "Total",
    billable: totals.billable, nonBillable: totals.nonBillable,
    total: totals.total, amount: totals.amount,
  }), [totals]);

  const open = (r: Row) => {
    if (groupBy === "client") router.push(`/clients/${r.id}`);
    else if (groupBy === "project") router.push(`/projects/${r.id}`);
    else if (groupBy === "person") router.push(`/team/${r.id}`);
  };

  return (
    <>
      <div className="mb-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Kpi icon={<Clock className="size-4" />} tone="info" label="Total hours" value={formatDuration(totals.total)} />
        <Kpi icon={<BriefcaseBusiness className="size-4" />} tone="billable" label="Billable hours" value={formatDuration(totals.billable)}>
          <div className="mt-2">
            <Meter segments={[
              { value: totals.total ? totals.billable / totals.total : 0, tone: "billable" },
              { value: totals.total ? totals.nonBillable / totals.total : 0, tone: "nonBillable" },
            ]} />
          </div>
        </Kpi>
        <Kpi
          icon={<PieChart className="size-4" />}
          tone="billable"
          label={<KpiHelpLabel label="Billable share" help="The percentage of tracked time in this period that is billable to clients." />}
          value={formatPercent(totals.total ? totals.billable / totals.total : 0)}
        />
        {can("rates:view_billable")
          ? <Kpi icon={<CircleDollarSign className="size-4" />} tone="warning" label="If billed hourly" value={formatMoney(totals.amount)} />
          : <Kpi
              icon={<ListTree className="size-4" />}
              tone="info"
              label={groupBy === "client" ? "Clients" : groupBy === "project" ? "Projects" : groupBy === "task" ? "Tasks" : "People"}
              value={String(rows.length)}
            />}
      </div>

      {series.length > 1 && (
        <Card className="mb-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-md font-semibold text-ink">Hours per week</h2>
            <Legend items={[
              { label: "Billable", color: "var(--billable)" },
              { label: "Non-billable", color: "var(--non-billable)" },
            ]} />
          </div>
          <StackedBarChart
            data={series}
            height={220}
            ariaLabel={`Billable and non-billable hours per week, ${period.label}`}
            format={(v) => (v >= 1 ? `${Math.round(v)}h` : "0")}
            series={[
              { name: "Billable", color: "var(--billable)" },
              { name: "Non-billable", color: "var(--non-billable)" },
            ]}
          />
        </Card>
      )}

      <DataGrid<Row>
        label="Time report"
        tableId="report-time"
        rows={rows}
        columns={columns}
        loading={loading}
        totals={gridTotals}
        height={560}
        onRowOpen={groupBy === "task" ? undefined : open}
        filters={
          <>
          {/* Who and what this is scoped to, and how to get out of it. */}
          {scopedTo && (
            <Badge variant="neutral" className="gap-1.5">
              {scopedTo}
              <button
                type="button"
                aria-label="Clear this filter"
                onClick={() => set({ user: null, project: null, by: null })}
                className="text-ink-tertiary hover:text-ink"
              >
                <X className="size-3" />
              </button>
            </Badge>
          )}
          <Select
            aria-label="Project"
            value={projectId ?? ""}
            onChange={(e) => set({ project: e.target.value || null })}
            className="w-[190px]"
          >
            <option value="">All projects</option>
            {projects.filter((p) => !p.archivedAt).map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </Select>
          <Segmented
            value={groupBy}
            onChange={(v) => set({ by: v === "client" ? null : v })}
            options={[
              { value: "client", label: "Client" },
              { value: "project", label: "Project" },
              { value: "task", label: "Task" },
              { value: "person", label: "Person" },
            ]}
            aria-label="Group time by"
          />
          </>
        }
      />
    </>
  );
}
