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
import type { ColDef } from "ag-grid-community";
import { formatDuration, formatMoney, formatPercent, isoDate, startOfWeek, toDate } from "@/lib/format";
import type { TimeEntry } from "@/lib/types";
import { ValueAccumulator } from "@/lib/derive";
import { Card, Meter, Segmented } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { DataGrid } from "@/components/app/data-grid";
import { StackedBarChart, Legend } from "@/components/app/charts";
import { Kpi } from "@/components/app/kpi";
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

export function TimeReport({
  entries, loading, period,
}: {
  entries: TimeEntry[]; loading: boolean; period: Period;
}) {
  const router = useRouter();
  const toast = useToast();
  const { params, set } = useUrlState();
  const { projectById, clientById, taskById, userById } = useApp();
  const can = useCan();

  const groupBy = (params.get("by") as GroupBy) || "client";

  const totals = React.useMemo(() => {
    let total = 0, billable = 0;
    const value = new ValueAccumulator();
    for (const e of entries) {
      total += e.durationSeconds;
      if (e.isBillable) {
        billable += e.durationSeconds;
        value.add(e.durationSeconds, e.billableRateCents ?? 0);
      }
    }
    return { total, billable, nonBillable: total - billable, amount: value.cents };
  }, [entries]);

  const rows = React.useMemo<GridRow<Row>[]>(() => {
    const buckets = new Map<string, { name: string; sub: string; total: number; billable: number; value: ValueAccumulator }>();

    for (const e of entries) {
      const project = projectById.get(e.projectId);
      let key: string, name: string, sub: string;

      if (groupBy === "client") {
        const client = project ? clientById.get(project.clientId) : undefined;
        key = client?.id ?? "unknown"; name = client?.name ?? "Unknown client"; sub = "";
      } else if (groupBy === "project") {
        key = e.projectId; name = project?.name ?? "Unknown project";
        sub = project ? clientById.get(project.clientId)?.name ?? "" : "";
      } else if (groupBy === "task") {
        key = e.taskId; name = taskById.get(e.taskId)?.name ?? "Unknown task"; sub = "";
      } else {
        const u = userById.get(e.userId);
        key = e.userId; name = u ? `${u.firstName} ${u.lastName}` : "Unknown person";
        sub = u?.roles.join(", ") ?? "";
      }

      const cur = buckets.get(key) ?? { name, sub, total: 0, billable: 0, value: new ValueAccumulator() };
      cur.total += e.durationSeconds;
      if (e.isBillable) {
        cur.billable += e.durationSeconds;
        cur.value.add(e.durationSeconds, e.billableRateCents ?? 0);
      }
      buckets.set(key, cur);
    }

    return [...buckets.entries()]
      .map(([id, v]) => ({
        _id: id, _kind: "data" as const, id, name: v.name, sub: v.sub,
        total: v.total, billable: v.billable, nonBillable: v.total - v.billable,
        share: totals.total ? v.total / totals.total : 0,
        amount: v.value.cents,
      }))
      .sort((a, b) => b.total - a.total);
  }, [entries, groupBy, projectById, clientById, taskById, userById, totals.total]);

  /** Hours per week across the period, split billable and non-billable. */
  const series = React.useMemo(() => {
    const buckets = new Map<string, [number, number]>();
    for (const e of entries) {
      const key = isoDate(startOfWeek(toDate(e.spentOn)));
      const cur = buckets.get(key) ?? [0, 0];
      if (e.isBillable) cur[0] += e.durationSeconds; else cur[1] += e.durationSeconds;
      buckets.set(key, cur);
    }
    return [...buckets.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-16)
      .map(([key, v]) => ({
        label: toDate(key).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
        values: [v[0] / 3600, v[1] / 3600],
      }));
  }, [entries]);

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
        <Kpi label="Total hours" value={formatDuration(totals.total)} />
        <Kpi label="Billable hours" value={formatDuration(totals.billable)}>
          <div className="mt-2">
            <Meter segments={[
              { value: totals.total ? totals.billable / totals.total : 0, tone: "billable" },
              { value: totals.total ? totals.nonBillable / totals.total : 0, tone: "nonBillable" },
            ]} />
          </div>
        </Kpi>
        <Kpi label="Billable share" value={formatPercent(totals.total ? totals.billable / totals.total : 0)} />
        {can("rates:view_billable")
          ? <Kpi label="If billed hourly" value={formatMoney(totals.amount)} />
          : <Kpi label="Entries" value={String(entries.length)} />}
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
        }
      />
    </>
  );
}
