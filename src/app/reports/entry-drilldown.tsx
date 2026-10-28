"use client";

/**
 * The time entries behind one row of the time report (t-7nyUE8).
 *
 * A report row is a sum, and the first question anybody asks of a sum they do
 * not believe is "made of what?". A project's report valued a month of hours at
 * a third of what the rate implied, and the only way to see which hours were
 * worth nothing was to leave the report and rebuild the same filter elsewhere.
 *
 * Opens on the row, with the same period and the same scope the report was
 * showing, so the rows here add up to the row that was clicked. It is the
 * standard grid, so its Export button writes these entries to CSV, which opens
 * in Excel; a native .xlsx export is an Enterprise feature of the grid this
 * product deliberately does not license.
 */

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import type { ColDef } from "ag-grid-community";
import * as api from "@/lib/api";
import { formatDayShort } from "@/lib/format";
import { Button, Dialog, DialogContent, EmptyState } from "@/components/ui/primitives";
import { DataGrid } from "@/components/app/data-grid";
import { useApp, useCan } from "@/components/app/providers";
import type { GridRow } from "@/components/ui/grid";

export type DrillDimension = "client" | "project" | "task" | "person";

export interface DrillTarget {
  dimension: DrillDimension;
  id: string;
  name: string;
}

interface Row {
  _id: string; _kind: "data";
  spentOn: string; person: string; project: string; task: string; notes: string;
  seconds: number; billable: string; rateCents?: number; amountCents?: number;
}

/** Where the "open this" link goes, for the dimensions that have a page. */
const pageFor = (t: DrillTarget): string | null =>
  t.dimension === "client" ? `/clients/${t.id}`
    : t.dimension === "project" ? `/projects/${t.id}`
      : t.dimension === "person" ? `/team/${t.id}`
        : null;

export function EntryDrilldown({
  target, from, to, scope, onClose,
}: {
  target: DrillTarget | null;
  from: string;
  to: string;
  /** The report's own filters, which the entries must respect to add up to the row. */
  scope: { userId?: string; projectId?: string };
  onClose: () => void;
}) {
  const { userById, projectById, taskById } = useApp();
  const can = useCan();
  const seesMoney = can("rates:view_billable");

  const query = React.useMemo(() => {
    if (!target) return null;
    return {
      from, to,
      userId: target.dimension === "person" ? target.id : scope.userId,
      projectId: target.dimension === "project" ? target.id : scope.projectId,
      clientId: target.dimension === "client" ? target.id : undefined,
      taskId: target.dimension === "task" ? target.id : undefined,
    };
  }, [target, from, to, scope.userId, scope.projectId]);

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ["time", "drilldown", query],
    queryFn: ({ signal }) => api.listAllTimeEntries(query!, signal),
    enabled: !!query,
  });

  const rows = React.useMemo<GridRow<Row>[]>(
    () =>
      (data ?? [])
        // A running timer has no settled duration yet, and the report does
        // not count it either, so neither does its breakdown.
        .filter((e) => !e.timerStartedAt)
        .sort((a, b) => a.spentOn.localeCompare(b.spentOn))
        .map((e) => {
          const user = userById.get(e.userId);
          const rate = e.isBillable ? e.billableRateCents : 0;
          return {
            _id: e.id, _kind: "data" as const,
            spentOn: e.spentOn,
            person: [user?.firstName, user?.lastName].filter(Boolean).join(" "),
            project: projectById.get(e.projectId)?.name ?? "",
            task: taskById.get(e.taskId)?.name ?? "",
            notes: e.notes ?? "",
            seconds: e.durationSeconds,
            billable: e.isBillable ? "Yes" : "No",
            // Absent means "you may not see this", so it stays absent rather
            // than becoming a zero that looks like a missing rate.
            rateCents: rate,
            amountCents: rate == null ? undefined : Math.round((e.durationSeconds * rate) / 3600),
          };
        }),
    [data, userById, projectById, taskById]
  );

  const totals = React.useMemo(() => {
    const seconds = rows.reduce((a, r) => a + r.seconds, 0);
    // Aggregate first, divide last (BACKEND_PRD 3.6), so this total matches the
    // report row rather than the sum of rounded lines.
    const centSeconds = rows.reduce((a, r) => a + r.seconds * (r.rateCents ?? 0), 0);
    return { spentOn: "Total", seconds, ...(seesMoney ? { amountCents: Math.round(centSeconds / 3600) } : {}) };
  }, [rows, seesMoney]);

  const columns = React.useMemo<ColDef[]>(() => [
    {
      colId: "spentOn", field: "spentOn", headerName: "Date", width: 110,
      valueFormatter: (p: { value?: string; node?: { rowPinned?: string | null } | null }) =>
        p.node?.rowPinned || !p.value ? p.value ?? "" : formatDayShort(p.value),
    },
    { colId: "person", field: "person", headerName: "Person", width: 160 },
    { colId: "project", field: "project", headerName: "Project", width: 200 },
    { colId: "task", field: "task", headerName: "Task", width: 170 },
    { colId: "notes", field: "notes", headerName: "Notes", flex: 1, minWidth: 220 },
    { colId: "seconds", field: "seconds", headerName: "Hours", type: "duration", width: 100 },
    { colId: "billable", field: "billable", headerName: "Billable", width: 100 },
    ...(seesMoney ? [
      { colId: "rateCents", field: "rateCents", headerName: "Rate", type: "money", width: 110 } as ColDef,
      { colId: "amountCents", field: "amountCents", headerName: "Amount", type: "money", width: 120 } as ColDef,
    ] : []),
  ], [seesMoney]);

  const page = target ? pageFor(target) : null;

  return (
    <Dialog open={!!target} onOpenChange={(open) => { if (!open) onClose(); }}>
      {target && (
        <DialogContent
          size="xl"
          title={target.name || "Time entries"}
          description={`${formatDayShort(from)} to ${formatDayShort(to)}, every entry behind this row.`}
        >
          {page && (
            <div className="mb-3 text-base">
              <Link href={page} className="text-link underline">
                Open the {target.dimension === "person" ? "person" : target.dimension} page
              </Link>
            </div>
          )}
          {error ? (
            <EmptyState title="Could not load all time entries"
              action={<Button type="button" variant="secondary" size="sm" loading={isFetching} onClick={() => void refetch()}>Try again</Button>}>
              The breakdown and export are unavailable until every entry loads.
            </EmptyState>
          ) : <DataGrid<Row>
            label={`Time entries for ${target.name}`}
            tableId="report-time-drilldown"
            rows={rows}
            columns={columns}
            loading={isLoading}
            totals={totals}
            height={480}
            density="compact"
          />}
        </DialogContent>
      )}
    </Dialog>
  );
}
