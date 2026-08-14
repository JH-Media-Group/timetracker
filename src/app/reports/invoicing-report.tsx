"use client";

/**
 * Invoicing report.
 *
 * What we billed, what came back, and what is still out there by how late it is.
 * Aging is bucketed the way a collections conversation runs: current, then the
 * three thresholds where the tone of the follow-up changes.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import type { ColDef } from "ag-grid-community";
import * as api from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatDateUS, formatMoney, formatPercent, toDate } from "@/lib/format";
import type { Invoice } from "@/lib/types";
import { Card, Meter, Segmented } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { DataGrid } from "@/components/app/data-grid";
import { StackedBarChart, Legend } from "@/components/app/charts";
import { InvoiceBadge, Kpi, KpiRow } from "@/components/app/kpi";
import { useApp } from "@/components/app/providers";
import { useUrlState, type Period } from "@/components/app/page-chrome";
import type { GridRow } from "@/components/ui/grid";

type View = "aging" | "issued";

interface Row {
  _id: string; _kind: "data";
  id: string; number: string; client: string;
  issueDate: string; dueDate: string; state: Invoice["state"];
  amount: number; paid: number; balance: number; daysLate: number; bucket: string;
}

const BUCKETS = ["Current", "1 to 30 days", "31 to 60 days", "61 to 90 days", "Over 90 days"] as const;

function bucketFor(daysLate: number): string {
  if (daysLate <= 0) return BUCKETS[0];
  if (daysLate <= 30) return BUCKETS[1];
  if (daysLate <= 60) return BUCKETS[2];
  if (daysLate <= 90) return BUCKETS[3];
  return BUCKETS[4];
}

export function InvoicingReport({ period }: { period: Period }) {
  const router = useRouter();
  const { params, set } = useUrlState();

  const view = (params.get("v") as View) || "aging";

  // From the endpoint. The client version attributed collections to the month
  // the invoice was raised rather than the month the money arrived, which is a
  // different question and the wrong one for a figure labelled "Collected".
  const { data } = useQuery({
    queryKey: ["report", "invoicing", period.from, period.to],
    queryFn: () => api.invoicingReport({ from: period.from, to: period.to }),
  });

  const detailed = React.useMemo<GridRow<Row>[]>(
    () =>
      (data?.rows ?? []).map((r) => ({
        _id: String(r.id), _kind: "data" as const, id: String(r.id),
        number: String(r.number ?? ""),
        client: String(r.clientName ?? "Unknown client"),
        issueDate: String(r.issueDate ?? ""),
        dueDate: String(r.dueDate ?? ""),
        state: String(r.displayState ?? r.state) as Invoice["state"],
        amount: Number(r.totalCents ?? 0),
        paid: Number(r.paidCents ?? 0),
        balance: Number(r.balanceCents ?? 0),
        daysLate: Number(r.daysLate ?? 0),
        bucket: String(r.bucket ?? "Settled"),
      })),
    [data]
  );

  const stats = React.useMemo(() => {
    const t = data?.totals ?? {};
    return {
      issued: Number(t.issuedCents ?? 0),
      collected: Number(t.collectedCents ?? 0),
      outstanding: Number(t.outstandingCents ?? 0),
      overdue: Number(t.overdueCents ?? 0),
      avgDays: (data?.meta.averageDaysToPay as number | null) ?? null,
      count: detailed.filter((r) => r.issueDate >= period.from && r.issueDate <= period.to).length,
    };
  }, [data, detailed, period.from, period.to]);

  const rows = React.useMemo<GridRow<Row>[]>(() => {
    const source =
      view === "aging"
        ? detailed.filter((r) => r.bucket !== "Settled")
        : detailed.filter((r) => r.issueDate >= period.from && r.issueDate <= period.to);
    return [...source].sort((a, b) =>
      view === "aging" ? b.daysLate - a.daysLate : b.issueDate.localeCompare(a.issueDate)
    );
  }, [view, detailed, period.from, period.to]);

  const aging = React.useMemo(() => {
    const server = (data?.meta.aging ?? []) as { bucket: string; amountCents: number }[];
    const m = new Map<string, number>(BUCKETS.map((b) => [b, 0]));
    for (const b of server) if (m.has(b.bucket)) m.set(b.bucket, b.amountCents);
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    return { buckets: [...m.entries()], total };
  }, [data]);

  /**
   * Who to call, biggest first (TALLY-17).
   *
   * A different cut from both neighbours: Aging says how much is late, the grid
   * below sorts by how long it has been late, and this says where the money is.
   * The largest overdue invoice is usually worth more than the oldest one.
   */
  const topOutstanding = React.useMemo(
    () => detailed.filter((r) => r.balance > 0).sort((a, b) => b.balance - a.balance).slice(0, 6),
    [detailed]
  );

  /** Issued against collected, by month: raised then, and cash arriving then. */
  const monthly = React.useMemo(() => {
    const server = (data?.meta.monthly ?? []) as {
      month: string; issuedCents: number; collectedCents: number;
    }[];
    return server.slice(-12).map((m) => ({
      label: toDate(`${m.month}-01`).toLocaleDateString(undefined, { month: "short" }),
      // Stacked as collected plus still-owed, so the bar height is what was issued.
      values: [m.collectedCents / 100, Math.max(0, (m.issuedCents - m.collectedCents) / 100)],
    }));
  }, [data]);

  /** What the wide column holds, or nothing when there is neither. */
  const wide: "chart" | "outstanding" | null =
    monthly.length > 1 ? "chart" : topOutstanding.length > 0 ? "outstanding" : null;

  const columns = React.useMemo<ColDef[]>(() => [
    { colId: "number", field: "number", headerName: "Invoice", width: 170 },
    { colId: "client", field: "client", headerName: "Client", flex: 1, minWidth: 220 },
    { colId: "issueDate", field: "issueDate", headerName: "Issued", type: "date", width: 120 },
    {
      colId: "dueDate", headerName: "Due", width: 150,
      valueGetter: (p: { data?: Row }) => p.data?.dueDate ?? "",
      cellRenderer: (p: { data?: Row }) => p.data && (
        <span className="flex min-w-0 flex-col justify-center leading-tight">
          <span className="tabular-nums text-ink">{formatDateUS(p.data.dueDate)}</span>
          {p.data.daysLate > 0 && <span className="text-sm text-danger">{p.data.daysLate} days overdue</span>}
        </span>
      ),
    },
    { colId: "amount", field: "amount", headerName: "Amount", type: "money", width: 140 },
    { colId: "paid", field: "paid", headerName: "Paid", type: "money", width: 130 },
    {
      colId: "balance", field: "balance", headerName: "Balance", type: "money", width: 140,
      cellRenderer: (p: { data?: Row; value: number }) => (
        <span className={cn("tabular-nums", p.data && p.data.daysLate > 0 && "font-medium text-danger")}>
          {formatMoney(p.value)}
        </span>
      ),
    },
    ...(view === "aging"
      ? [{ colId: "bucket", field: "bucket", headerName: "Age", width: 140 } as ColDef]
      : [{
          colId: "state", field: "state", headerName: "Status", width: 140,
          cellRenderer: (p: { data?: Row }) => p.data?.state && <InvoiceBadge state={p.data.state} />,
        } as ColDef]),
  ], [view]);

  const gridTotals = React.useMemo(() => ({
    number: "Total",
    amount: rows.reduce((a, r) => a + r.amount, 0),
    paid: rows.reduce((a, r) => a + r.paid, 0),
    balance: rows.reduce((a, r) => a + r.balance, 0),
  }), [rows]);

  return (
    <>
      <div className="mb-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Kpi label={`Issued in ${period.label}`} value={formatMoney(stats.issued)}>
          <div className="mt-2 text-base text-ink-secondary">{stats.count} invoices</div>
        </Kpi>
        <Kpi label="Collected" value={formatMoney(stats.collected)}>
          <div className="mt-2">
            <Meter segments={[{ value: stats.issued ? stats.collected / stats.issued : 0, tone: "ok" }]} />
          </div>
        </Kpi>
        <Kpi label="Outstanding" value={formatMoney(stats.outstanding)}>
          <div className="mt-2 flex flex-col gap-1">
            <KpiRow label="Overdue" value={formatMoney(stats.overdue)} danger={stats.overdue > 0} />
          </div>
        </Kpi>
        <Kpi label="Average days to pay" value={stats.avgDays == null ? "No data" : `${stats.avgDays}`} muted={stats.avgDays == null} />
      </div>

      {/*
        Aging is the 340px column. The wide one holds the monthly chart when
        there is more than a month of history to draw, and otherwise the
        largest outstanding balances.

        The two-column definition is conditional because the wide column used
        to be a hole: with one month of data the chart did not render, Aging
        took the 1fr column, and 340px of nothing sat beside it (TALLY-17).
        When neither has anything to show, Aging spans the row instead.
      */}
      <div className={cn("mb-4 grid gap-4", wide && "xl:grid-cols-[1fr_340px]")}>
        {wide === "chart" && (
          <Card>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-md font-semibold text-ink">Issued and collected by month</h2>
              <Legend items={[
                { label: "Collected", color: "var(--viz-1)" },
                { label: "Still owed", color: "var(--viz-4)" },
              ]} />
            </div>
            <StackedBarChart
              data={monthly}
              height={210}
              ariaLabel="Amount issued and collected by month"
              format={(v) => `${v < 0 ? "-" : ""}$${Math.abs(v) >= 1000 ? `${Math.round(Math.abs(v) / 1000)}k` : Math.round(Math.abs(v))}`}
              series={[
                { name: "Collected", color: "var(--viz-1)" },
                { name: "Still owed", color: "var(--viz-4)" },
              ]}
            />
          </Card>
        )}

        {wide === "outstanding" && (
          <Card>
            <h2 className="mb-3 text-md font-semibold text-ink">Largest outstanding</h2>
            <div className="flex flex-col">
              {topOutstanding.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => router.push(`/invoices/${r.id}`)}
                  className="flex items-center gap-3 rounded-md px-2 py-2 text-left text-base transition-colors hover:bg-surface-hover"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-ink">{r.client}</span>
                    <span className="block truncate text-sm text-ink-tertiary">{r.number}</span>
                  </span>
                  {r.daysLate > 0 && (
                    <span className="shrink-0 text-sm text-danger">{r.daysLate} days overdue</span>
                  )}
                  <span className="shrink-0 tabular-nums font-medium text-ink">
                    {formatMoney(r.balance)}
                  </span>
                </button>
              ))}
            </div>
          </Card>
        )}

        <Card>
          <h2 className="mb-3 text-md font-semibold text-ink">Aging</h2>
          <div className="flex flex-col gap-2.5">
            {aging.buckets.map(([label, value]) => (
              <div key={label}>
                <div className="flex items-center justify-between text-base">
                  <span className={cn(label === "Current" ? "text-ink-secondary" : "text-ink")}>{label}</span>
                  <span className="tabular-nums font-medium">{formatMoney(value)}</span>
                </div>
                <div className="mt-1">
                  <Meter
                    height="h-1.5"
                    segments={[{
                      value: aging.total ? value / aging.total : 0,
                      tone: label === "Current" ? "ok" : label === "Over 90 days" ? "over" : "near",
                    }]}
                  />
                </div>
              </div>
            ))}
            <div className="mt-1 flex items-center justify-between border-t border-border pt-2 font-semibold">
              <span>Outstanding</span>
              <span className="tabular-nums">{formatMoney(aging.total)}</span>
            </div>
            {aging.total > 0 && (
              <p className="text-sm text-ink-tertiary">
                {formatPercent((aging.total - (aging.buckets[0]?.[1] ?? 0)) / aging.total)} of what is outstanding is past due.
              </p>
            )}
          </div>
        </Card>
      </div>

      <DataGrid<Row>
        label="Invoicing report"
        tableId="report-invoicing"
        rows={rows}
        columns={columns}
        totals={gridTotals}
        height={560}
        onRowOpen={(r) => router.push(`/invoices/${r.id}`)}
        filters={
          <Segmented
            value={view}
            onChange={(v) => set({ v: v === "aging" ? null : v })}
            options={[
              { value: "aging", label: "Outstanding" },
              { value: "issued", label: "Issued this period" },
            ]}
            aria-label="Invoicing view"
          />
        }
      />
    </>
  );
}
