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
import type { ColDef } from "ag-grid-community";
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

export function InvoicingReport({ invoices, period }: { invoices: Invoice[]; period: Period }) {
  const router = useRouter();
  const toast = useToast();
  const { params, set } = useUrlState();
  const { clientById } = useApp();

  const view = (params.get("v") as View) || "aging";
  const today = React.useMemo(() => new Date(), []);

  const inPeriod = React.useMemo(
    () => invoices.filter((i) => i.issueDate >= period.from && i.issueDate <= period.to),
    [invoices, period.from, period.to]
  );

  const open = React.useMemo(
    () => invoices.filter((i) => i.state === "sent" || i.state === "partial" || i.state === "late"),
    [invoices]
  );

  const stats = React.useMemo(() => {
    const issued = inPeriod.reduce((a, i) => a + i.totalCents, 0);
    const collected = inPeriod.reduce((a, i) => a + i.paidCents, 0);
    const outstanding = open.reduce((a, i) => a + (i.totalCents - i.paidCents), 0);
    const overdue = open
      .filter((i) => toDate(i.dueDate) < today)
      .reduce((a, i) => a + (i.totalCents - i.paidCents), 0);

    // Average days to pay, over invoices that were actually paid.
    const paidInvoices = invoices.filter((i) => i.state === "paid" && i.paidAt && i.sentAt);
    const avgDays = paidInvoices.length
      ? Math.round(paidInvoices.reduce(
          (a, i) => a + (new Date(i.paidAt!).getTime() - new Date(i.sentAt!).getTime()) / 86400000, 0
        ) / paidInvoices.length)
      : null;

    return { issued, collected, outstanding, overdue, avgDays, count: inPeriod.length };
  }, [inPeriod, open, invoices, today]);

  const rows = React.useMemo<GridRow<Row>[]>(() => {
    const source = view === "aging" ? open : inPeriod;
    return source
      .map((i) => {
        const daysLate = Math.round((today.getTime() - toDate(i.dueDate).getTime()) / 86400000);
        return {
          _id: i.id, _kind: "data" as const, id: i.id, number: i.number,
          client: clientById.get(i.clientId)?.name ?? "Unknown client",
          issueDate: i.issueDate, dueDate: i.dueDate, state: i.state,
          amount: i.totalCents, paid: i.paidCents, balance: i.totalCents - i.paidCents,
          daysLate: Math.max(0, daysLate), bucket: bucketFor(daysLate),
        };
      })
      .sort((a, b) => (view === "aging" ? b.daysLate - a.daysLate : b.issueDate.localeCompare(a.issueDate)));
  }, [view, open, inPeriod, clientById, today]);

  const aging = React.useMemo(() => {
    const m = new Map<string, number>(BUCKETS.map((b) => [b, 0]));
    for (const r of rows) if (view === "aging") m.set(r.bucket, (m.get(r.bucket) ?? 0) + r.balance);
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    return { buckets: [...m.entries()], total };
  }, [rows, view]);

  /** Issued versus collected, by month of issue. */
  const monthly = React.useMemo(() => {
    const m = new Map<string, [number, number]>();
    for (const i of invoices) {
      const key = i.issueDate.slice(0, 7);
      const cur = m.get(key) ?? [0, 0];
      cur[0] += i.totalCents / 100;
      cur[1] += i.paidCents / 100;
      m.set(key, cur);
    }
    return [...m.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-12)
      .map(([key, v]) => ({
        label: toDate(`${key}-01`).toLocaleDateString(undefined, { month: "short" }),
        // Stacked as collected plus still-owed, so the bar height is the amount issued.
        values: [v[1], Math.max(0, v[0] - v[1])],
      }));
  }, [invoices]);

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

      <div className="mb-4 grid gap-4 xl:grid-cols-[1fr_340px]">
        {monthly.length > 1 && (
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
