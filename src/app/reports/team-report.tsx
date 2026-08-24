"use client";

/**
 * Team report.
 *
 * Utilization against capacity, and the billable share inside it. Contractors
 * are separated because their capacity means something different: an employee
 * at 60% is underused, a contractor at 60% is just a contractor.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import type { ColDef } from "ag-grid-community";
import * as api from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatDuration, formatMoney, formatPercent } from "@/lib/format";
import { utilization } from "@/lib/derive";
import type { TimeEntry } from "@/lib/types";
import { CircleAlert, Clock, Gauge, PieChart } from "lucide-react";
import { Avatar, Badge, Card, Meter, Segmented } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { DataGrid } from "@/components/app/data-grid";
import { BarChart } from "@/components/app/charts";
import { Kpi, KpiHelpLabel } from "@/components/app/kpi";
import { useApp, useCan } from "@/components/app/providers";
import { useUrlState, type Period } from "@/components/app/page-chrome";
import type { GridRow } from "@/components/ui/grid";

type Scope = "all" | "employee" | "contractor";

interface Row {
  _id: string; _kind: "data";
  id: string; firstName: string; lastName: string; photo?: string;
  name: string; type: string;
  tracked: number; billable: number; capacity: number;
  util: number; billableShare: number; cost: number;
}

export function TeamReport({ period }: { period: Period }) {
  const router = useRouter();
  const { params, set } = useUrlState();
  const { userById } = useApp();
  const can = useCan();

  const scope = (params.get("who") as Scope) || "all";

  // From the endpoint, which scopes to the people this actor may see. Building
  // the list from the bootstrap roster showed a project manager everybody in
  // the account, most of them with zeros, which is a different report from the
  // one the API would answer.
  const { data } = useQuery({
    queryKey: ["report", "team", period.from, period.to, scope],
    queryFn: () =>
      api.teamReport({
        from: period.from,
        to: period.to,
        employmentType: scope === "all" ? undefined : scope,
      }),
  });

  const rows = React.useMemo<GridRow<Row>[]>(
    () =>
      (data?.rows ?? []).map((r) => {
        const id = String(r.userId);
        const person = userById.get(id);
        return {
          _id: id, _kind: "data" as const, id,
          firstName: person?.firstName ?? String(r.name ?? "").split(" ")[0] ?? "",
          lastName: person?.lastName ?? "",
          photo: person?.photo,
          name: String(r.name ?? ""),
          type: r.employmentType === "contractor" ? "Contractor" : "Employee",
          tracked: Number(r.trackedSeconds ?? 0),
          billable: Number(r.billableSeconds ?? 0),
          capacity: Number(r.capacitySeconds ?? 0),
          util: Number(r.utilization ?? 0),
          billableShare: Number(r.billableShare ?? 0),
          cost: Number(r.costCents ?? 0),
        };
      }),
    [data, userById]
  );

  const totals = React.useMemo(() => {
    const t = data?.totals ?? {};
    return {
      tracked: Number(t.trackedSeconds ?? 0),
      billable: Number(t.billableSeconds ?? 0),
      capacity: Number(t.capacitySeconds ?? 0),
      cost: Number(t.costCents ?? 0),
      util: Number(t.utilization ?? 0),
      billableShare: Number(t.billableShare ?? 0),
    };
  }, [data]);

  const chart = React.useMemo(
    () => rows.map((r) => ({ label: r.firstName, value: r.util * 100 })),
    [rows]
  );

  const columns = React.useMemo<ColDef[]>(() => [
    {
      colId: "name", field: "name", headerName: "Person", flex: 1, minWidth: 230,
      cellRenderer: (p: { data?: Row }) => p.data && (
        <span className="flex min-w-0 items-center gap-2.5">
          <Avatar user={p.data} size="sm" />
          <span className="truncate font-medium text-ink">{p.data.name}</span>
          {p.data.type === "Contractor" && <Badge variant="warning">Contractor</Badge>}
        </span>
      ),
    },
    { colId: "tracked", field: "tracked", headerName: "Tracked", type: "duration", width: 115 },
    { colId: "billable", field: "billable", headerName: "Billable", type: "duration", width: 115 },
    { colId: "capacity", field: "capacity", headerName: "Capacity", type: "duration", width: 115 },
    {
      colId: "util", headerName: "Utilization", width: 180, sortable: true,
      valueGetter: (p: { data?: Row }) => p.data?.util ?? 0,
      cellRenderer: (p: { data?: Row; value: number }) => p.data && (
        <span className="tly-meter-row flex w-full min-w-0 flex-1 items-center gap-2">
          <span className="tly-meter min-w-8 flex-1">
            <Meter segments={
              p.value > 1
                ? [{ value: 1 / p.value, tone: "near" }, { value: Math.min((p.value - 1) / p.value, 0.5), tone: "over" }]
                : [{ value: p.value, tone: p.value >= 0.75 ? "ok" : "near" }]
            } />
          </span>
          <span className={cn("w-11 shrink-0 text-right text-sm tabular-nums", p.value > 1 ? "font-medium text-danger" : "text-ink-secondary")}>
            {formatPercent(p.value)}
          </span>
        </span>
      ),
    },
    {
      colId: "billableShare", headerName: "Billable share", width: 150, type: "numeric",
      valueGetter: (p: { data?: Row }) => p.data?.billableShare ?? 0,
      cellRenderer: (p: { value: number }) => <span className="tabular-nums">{formatPercent(p.value)}</span>,
    },
    ...(can("rates:view_cost") ? [
      { colId: "cost", field: "cost", headerName: "Cost of time", type: "money", width: 150 } as ColDef,
    ] : []),
  ], [can]);

  const gridTotals = React.useMemo(() => ({
    name: "Total", tracked: totals.tracked, billable: totals.billable,
    capacity: totals.capacity, cost: totals.cost,
  }), [totals]);

  const under = rows.filter((r) => r.util < 0.6).length;
  const over = rows.filter((r) => r.util > 1).length;

  return (
    <>
      <div className="mb-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Kpi icon={<Gauge className="size-4" />} tone={totals.util > 1.15 ? "danger" : "success"} label="Utilization" value={formatPercent(totals.util)}>
          <div className="mt-2">
            <Meter segments={[{ value: Math.min(totals.util, 1), tone: totals.util >= 0.75 ? "ok" : "near" }]} />
          </div>
        </Kpi>
        <Kpi icon={<Clock className="size-4" />} tone="info" label="Tracked" value={formatDuration(totals.tracked)}>
          <div className="mt-2 text-base text-ink-secondary">of {formatDuration(totals.capacity)} capacity</div>
        </Kpi>
        <Kpi
          icon={<PieChart className="size-4" />}
          tone="billable"
          label={<KpiHelpLabel label="Billable share" help="The percentage of tracked time in this period that is billable to clients." />}
          value={formatPercent(totals.billableShare)}
        />
        <Kpi icon={<CircleAlert className="size-4" />} tone={over + under ? "warning" : "neutral"} label="Attention" value={`${over + under}`} muted={over + under === 0}>
          <div className="mt-2 text-base text-ink-secondary">
            {over > 0 && `${over} over capacity`}
            {over > 0 && under > 0 && ", "}
            {under > 0 && `${under} under 60%`}
            {over + under === 0 && "Everyone is in range"}
          </div>
        </Kpi>
      </div>

      {chart.length > 1 && (
        <Card className="mb-4">
          <h2 className="mb-3 text-md font-semibold text-ink">Utilization by person</h2>
          <BarChart
            data={chart}
            height={210}
            ariaLabel="Utilization by person"
            format={(v) => `${Math.round(v)}%`}
            tipRows={(p, i) => ({
              title: rows[i]?.name ?? p.label,
              rows: [
                { color: "var(--viz-1)", label: "Utilization", value: formatPercent(rows[i]?.util ?? 0) },
                { label: "Tracked", value: formatDuration(rows[i]?.tracked ?? 0) },
                { label: "Capacity", value: formatDuration(rows[i]?.capacity ?? 0) },
              ],
              foot: { label: "Billable share", value: formatPercent(rows[i]?.billableShare ?? 0) },
            })}
          />
        </Card>
      )}

      <DataGrid<Row>
        label="Team report"
        tableId="report-team"
        rows={rows}
        columns={columns}
        totals={gridTotals}
        height={560}
        onRowOpen={(r) => router.push(`/team/${r.id}`)}
        filters={
          <Segmented
            value={scope}
            onChange={(v) => set({ who: v === "all" ? null : v })}
            options={[
              { value: "all", label: "Everyone" },
              { value: "employee", label: "Employees" },
              { value: "contractor", label: "Contractors" },
            ]}
            aria-label="Who to include"
          />
        }
      />
    </>
  );
}
