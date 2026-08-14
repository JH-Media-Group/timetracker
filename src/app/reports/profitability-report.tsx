"use client";

/**
 * Profitability report.
 *
 * Revenue on the tracked-time basis minus internal cost. A project with no
 * billable rate on it cannot have a margin, so it is flagged rather than shown
 * as 100% profitable, which is what a silent zero would imply.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import type { ColDef } from "ag-grid-community";
import { cn } from "@/lib/cn";
import { formatMoney, formatPercent } from "@/lib/format";
import { profitFor, projectCost, projectRevenue } from "@/lib/derive";
import type { Expense, Invoice, TimeEntry } from "@/lib/types";
import { Badge, Card, Segmented, Tooltip } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { DataGrid } from "@/components/app/data-grid";
import { HBarChart } from "@/components/app/charts";
import { Kpi, KpiRow } from "@/components/app/kpi";
import { useApp } from "@/components/app/providers";
import { useUrlState } from "@/components/app/page-chrome";
import type { GridRow } from "@/components/ui/grid";

type GroupBy = "project" | "client";

interface Row {
  _id: string; _kind: "data";
  id: string; name: string; sub: string;
  revenue: number; cost: number; profit: number;
  margin: number | null; roc: number | null;
  missingRate: boolean;
}

export function ProfitabilityReport({
  entries, expenses, invoices,
}: {
  entries: TimeEntry[]; expenses: Expense[]; invoices: Invoice[];
}) {
  const router = useRouter();
  const toast = useToast();
  const { params, set } = useUrlState();
  const { projects, clientById } = useApp();

  const groupBy = (params.get("by") as GroupBy) || "project";

  const perProject = React.useMemo(() => {
    const timeByProject = new Map<string, TimeEntry[]>();
    for (const e of entries) {
      const l = timeByProject.get(e.projectId); if (l) l.push(e); else timeByProject.set(e.projectId, [e]);
    }
    const expByProject = new Map<string, Expense[]>();
    for (const x of expenses) {
      const l = expByProject.get(x.projectId); if (l) l.push(x); else expByProject.set(x.projectId, [x]);
    }

    return projects
      .map((p) => {
        const mine = timeByProject.get(p.id) ?? [];
        const myExp = expByProject.get(p.id) ?? [];
        if (!mine.length && !myExp.length) return null;
        const revenue = projectRevenue(p, mine, myExp);
        const cost = projectCost(mine, myExp);
        const billableWithoutRate = mine.some((e) => e.isBillable && e.billableRateCents === 0);
        return {
          project: p, revenue, cost,
          ...profitFor(revenue, cost),
          missingRate: p.billingType !== "non_billable" && billableWithoutRate,
        };
      })
      .filter((r): r is NonNullable<typeof r> => !!r);
  }, [projects, entries, expenses]);

  const totals = React.useMemo(() => {
    const revenue = perProject.reduce((a, r) => a + r.revenue, 0);
    const cost = perProject.reduce((a, r) => a + r.cost, 0);
    const invoiced = invoices
      .filter((i) => i.state !== "draft")
      .reduce((a, i) => a + i.totalCents, 0);
    return { revenue, cost, invoiced, ...profitFor(revenue, cost) };
  }, [perProject, invoices]);

  const rows = React.useMemo<GridRow<Row>[]>(() => {
    if (groupBy === "project") {
      return perProject
        .map((r) => ({
          _id: r.project.id, _kind: "data" as const, id: r.project.id,
          name: r.project.name, sub: clientById.get(r.project.clientId)?.name ?? "",
          revenue: r.revenue, cost: r.cost, profit: r.profitCents,
          margin: r.marginPct, roc: r.returnOnCostPct, missingRate: r.missingRate,
        }))
        .sort((a, b) => b.profit - a.profit);
    }

    const byClient = new Map<string, { revenue: number; cost: number; missingRate: boolean }>();
    for (const r of perProject) {
      const cur = byClient.get(r.project.clientId) ?? { revenue: 0, cost: 0, missingRate: false };
      cur.revenue += r.revenue; cur.cost += r.cost;
      cur.missingRate = cur.missingRate || r.missingRate;
      byClient.set(r.project.clientId, cur);
    }
    return [...byClient.entries()]
      .map(([id, v]) => ({
        _id: id, _kind: "data" as const, id,
        name: clientById.get(id)?.name ?? "Unknown client", sub: "",
        revenue: v.revenue, cost: v.cost, ...profitFor(v.revenue, v.cost),
        missingRate: v.missingRate,
      }))
      .map((r) => ({
        ...r, profit: r.profitCents, margin: r.marginPct, roc: r.returnOnCostPct,
      }))
      .sort((a, b) => b.profit - a.profit);
  }, [perProject, groupBy, clientById]);

  /* The ten biggest contributors and the three worst, so a loss-maker cannot
     hide behind nine profitable projects. */
  const chart = React.useMemo(() => {
    const top = rows.slice(0, 10);
    const losses = rows.filter((r) => r.profit < 0).slice(-3).filter((r) => !top.includes(r));
    return [...top, ...losses].map((r) => ({ label: r.name, value: r.profit / 100 }));
  }, [rows]);

  const columns = React.useMemo<ColDef[]>(() => [
    {
      colId: "name", field: "name", headerName: groupBy === "project" ? "Project" : "Client",
      flex: 1, minWidth: 240,
      cellRenderer: (p: { data?: Row }) => p.data && (
        <span className="flex min-w-0 items-center gap-2">
          <span className="flex min-w-0 flex-col justify-center leading-tight">
            <span className="truncate font-medium text-ink">{p.data.name}</span>
            {p.data.sub && <span className="truncate text-sm text-ink-tertiary">{p.data.sub}</span>}
          </span>
          {p.data.missingRate && (
            <Tooltip content="Billable time on this project has no rate, so revenue is understated.">
              <span className="shrink-0"><Badge variant="warning">No rate</Badge></span>
            </Tooltip>
          )}
        </span>
      ),
    },
    { colId: "revenue", field: "revenue", headerName: "Revenue", type: "money", width: 150 },
    { colId: "cost", field: "cost", headerName: "Internal cost", type: "money", width: 150 },
    {
      colId: "profit", field: "profit", headerName: "Profit", type: "money", width: 150,
      cellRenderer: (p: { value: number }) => (
        <span className={cn("font-medium tabular-nums", p.value < 0 ? "text-danger" : "text-ink")}>{formatMoney(p.value)}</span>
      ),
    },
    {
      colId: "margin", field: "margin", headerName: "Margin", width: 110, type: "numeric",
      cellRenderer: (p: { value: number | null }) =>
        p.value == null
          ? <span className="text-ink-tertiary">Not billable</span>
          : <span className={cn("tabular-nums", p.value < 0 && "text-danger")}>{formatPercent(p.value)}</span>,
    },
    {
      colId: "roc", field: "roc", headerName: "Return on cost", width: 150, type: "numeric",
      cellRenderer: (p: { value: number | null }) =>
        p.value == null
          ? <span className="text-ink-tertiary">No cost</span>
          : <span className={cn("tabular-nums", p.value < 0 && "text-danger")}>{formatPercent(p.value)}</span>,
    },
  ], [groupBy]);

  const gridTotals = React.useMemo(() => ({
    name: "Total", revenue: totals.revenue, cost: totals.cost, profit: totals.profitCents,
  }), [totals]);

  return (
    <>
      <div className="mb-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Kpi label="Revenue" value={formatMoney(totals.revenue)}>
          <div className="mt-2 flex flex-col gap-1">
            <KpiRow label="Invoiced to date" value={formatMoney(totals.invoiced)} />
          </div>
        </Kpi>
        <Kpi label="Internal cost" value={formatMoney(totals.cost)} />
        <Kpi label="Profit" value={formatMoney(totals.profitCents)} danger={totals.profitCents < 0} />
        <Kpi label="Margin" value={totals.marginPct == null ? "Not billable" : formatPercent(totals.marginPct)} danger={(totals.marginPct ?? 0) < 0} />
      </div>

      {chart.length > 1 && (
        <Card className="mb-4">
          <h2 className="mb-3 text-md font-semibold text-ink">
            Profit by {groupBy === "project" ? "project" : "client"}
          </h2>
          <HBarChart
            data={chart}
            color="var(--viz-1)"
            ariaLabel={`Profit by ${groupBy}`}
            labelWidth={240}
            format={(v) => `${v < 0 ? "-" : ""}$${Math.abs(v) >= 1000 ? `${Math.round(Math.abs(v) / 1000)}k` : Math.round(Math.abs(v))}`}
            tipRows={(p, i) => ({
              title: rows[i]?.name ?? p.label,
              rows: [
                { color: "var(--viz-2)", label: "Profit", value: formatMoney((rows[i]?.profit ?? 0)) },
                { label: "Revenue", value: formatMoney(rows[i]?.revenue ?? 0) },
                { label: "Cost", value: formatMoney(rows[i]?.cost ?? 0) },
              ],
              foot: { label: "Margin", value: rows[i]?.margin == null ? "Not billable" : formatPercent(rows[i]!.margin!) },
            })}
          />
        </Card>
      )}

      <DataGrid<Row>
        label="Profitability report"
        tableId="report-profit"
        rows={rows}
        columns={columns}
        totals={gridTotals}
        height={560}
        onRowOpen={(r) => router.push(groupBy === "project" ? `/projects/${r.id}` : `/clients/${r.id}`)}
        filters={
          <Segmented
            value={groupBy}
            onChange={(v) => set({ by: v === "project" ? null : v })}
            options={[{ value: "project", label: "Project" }, { value: "client", label: "Client" }]}
            aria-label="Group profitability by"
          />
        }
      />
    </>
  );
}
