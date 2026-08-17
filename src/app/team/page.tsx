"use client";

/**
 * Team list.
 *
 * The one screen where "who is over capacity" and "who has not tracked anything
 * this week" have to be answerable at a glance, so utilization is a meter rather
 * than a number and the period is part of the URL.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColDef } from "ag-grid-community";
import { Plus } from "lucide-react";
import * as api from "@/lib/api";
import { cn } from "@/lib/cn";
import { utilization } from "@/lib/derive";
import { formatDuration, formatPercent, isoDate, startOfWeek } from "@/lib/format";
import type { TimeEntry } from "@/lib/types";
import { PROFILE_LABEL } from "@/lib/labels";
import { Avatar, Badge, Button, EmptyState, Meter, Select } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { PageBody, PageHeader, PeriodPicker, useUrlState, usePeriod } from "@/components/app/page-chrome";
import { DataGrid } from "@/components/app/data-grid";
import { useApp, useCan } from "@/components/app/providers";
import type { GridRow } from "@/components/ui/grid";

interface Row {
  _id: string; _kind: "data";
  id: string; name: string; email: string;
  photo?: string; firstName: string; lastName: string;
  profile: string; type: string; roles: string;
  tracked: number; billable: number; capacity: number; util: number;
  billableRate?: number; costRate?: number; archived: boolean;
}

export default function TeamPage() {
  const qc = useQueryClient();
  const router = useRouter();
  const toast = useToast();
  const { params, set } = useUrlState();
  const { users } = useApp();
  const can = useCan();
  const { granularity, anchor, period, onChange } = usePeriod("week", ["week", "month", "quarter", "year"]);

  const status = params.get("status") || "active";
  const type = params.get("type") || "";

  const { data: entries = [], isLoading } = useQuery({
    queryKey: ["time", "range", period.from, period.to],
    queryFn: () => api.listTimeEntries({ from: period.from, to: period.to }),
  });

  const weeks = React.useMemo(() => {
    const days = (new Date(period.to).getTime() - new Date(period.from).getTime()) / 86400000 + 1;
    return Math.max(1, Math.round(days / 7));
  }, [period.from, period.to]);

  const rows = React.useMemo<GridRow<Row>[]>(() => {
    const list = users.filter((u) => {
      if (status === "archived" ? !u.archivedAt : !!u.archivedAt) return false;
      if (type && u.employmentType !== type) return false;
      return true;
    });
    return utilization(list, entries as TimeEntry[], weeks)
      .sort((a, b) => a.user.firstName.localeCompare(b.user.firstName))
      .map((r) => ({
        _id: r.user.id, _kind: "data" as const,
        id: r.user.id, firstName: r.user.firstName, lastName: r.user.lastName,
        name: `${r.user.firstName} ${r.user.lastName}`, email: r.user.email, photo: r.user.photo,
        profile: PROFILE_LABEL[r.user.profile],
        type: r.user.employmentType === "contractor" ? "Contractor" : "Employee",
        roles: r.user.roles.join(", "),
        tracked: r.totalSeconds, billable: r.billableSeconds,
        capacity: r.capacitySeconds, util: r.utilization,
        billableRate: r.user.billableRateCents, costRate: r.user.costRateCents,
        archived: !!r.user.archivedAt,
      }));
  }, [users, entries, status, type, weeks]);

  const columns = React.useMemo<ColDef[]>(() => [
    {
      colId: "name", field: "name", headerName: "Person", flex: 1, minWidth: 240,
      cellRenderer: (p: { data?: Row }) => p.data && (
        <span className="flex min-w-0 items-center gap-2.5">
          <Avatar user={p.data} size="sm" />
          <span className="min-w-0">
            <span className="block truncate font-medium leading-tight text-ink">{p.data.name}</span>
            <span className="block truncate text-sm leading-tight text-ink-tertiary">{p.data.email}</span>
          </span>
          {p.data.archived && <Badge variant="neutral">Archived</Badge>}
        </span>
      ),
    },
    { colId: "profile", field: "profile", headerName: "Permissions", width: 170 },
    {
      colId: "type", field: "type", headerName: "Type", width: 130,
      cellRenderer: (p: { value: string }) => (
        <Badge variant={p.value === "Contractor" ? "warning" : "neutral"}>{p.value}</Badge>
      ),
    },
    { colId: "tracked", field: "tracked", headerName: "Tracked", type: "duration", width: 110 },
    { colId: "billable", field: "billable", headerName: "Billable", type: "duration", width: 110 },
    { colId: "capacity", field: "capacity", headerName: "Capacity", type: "duration", width: 110 },
    {
      colId: "util", headerName: "Utilization", width: 170, sortable: true,
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
          <span className={cn("w-10 shrink-0 text-right text-sm tabular-nums", p.value > 1 ? "font-medium text-danger" : "text-ink-secondary")}>
            {formatPercent(p.value)}
          </span>
        </span>
      ),
    },
    ...(can("rates:view_billable") ? [{ colId: "billableRate", field: "billableRate", headerName: "Billable rate", type: "money", width: 140 } as ColDef] : []),
    ...(can("rates:view_cost") ? [{ colId: "costRate", field: "costRate", headerName: "Cost rate", type: "money", width: 130 } as ColDef] : []),
  ], [can]);

  const totals = React.useMemo(() => ({
    name: "Total",
    tracked: rows.reduce((a, r) => a + r.tracked, 0),
    billable: rows.reduce((a, r) => a + r.billable, 0),
    capacity: rows.reduce((a, r) => a + r.capacity, 0),
  }), [rows]);

  const notTracked = rows.filter((r) => r.tracked === 0).length;

  return (
    <>
      <PageHeader
        title="Team"
        actions={can("people:manage") && (
          <Button variant="primary" onClick={() => router.push("/team/new")}>
            <Plus className="size-4" />Add person
          </Button>
        )}
      />
      <PageBody className="pt-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <PeriodPicker granularity={granularity} anchor={anchor} onChange={onChange} allowed={["week", "month", "quarter", "year"]} />
          <div className="text-base text-ink-secondary">
            {formatDuration(totals.tracked)} tracked by {rows.length} {rows.length === 1 ? "person" : "people"}
            {notTracked > 0 && <span className="text-warning"> · {notTracked} with no time in this period</span>}
          </div>
        </div>

        <DataGrid<Row>
          label="Team"
          tableId="team"
          rows={rows}
          columns={columns}
          loading={isLoading}
          totals={totals}
          height={620}
          selectable={can("people:manage")}
          onRowOpen={(r) => router.push(`/team/${r.id}`)}
          filters={
            <>
              <Select value={status} onChange={(e) => set({ status: e.target.value })} className="w-[170px]" aria-label="Person status">
                <option value="active">Active people</option>
                <option value="archived">Archived people</option>
              </Select>
              <Select value={type} onChange={(e) => set({ type: e.target.value })} className="w-[170px]" aria-label="Employment type">
                <option value="">All types</option>
                <option value="employee">Employees</option>
                <option value="contractor">Contractors</option>
              </Select>
            </>
          }
          bulkActions={[
            {
              key: "capacity", label: "Set capacity", input: "inline",
              inlineLabel: "Hours / week", inlinePlaceholder: "40",
              run: async (sel, v) => {
                const hours = Number((v ?? "").trim());
                if (!Number.isFinite(hours) || hours < 0 || hours > 168) {
                  toast.push({ tone: "danger", title: "Capacity is a number of hours between 0 and 168." });
                  return;
                }
                const ids = (sel as Row[]).map((r) => r.id);
                for (const id of ids) await api.updateUser(id, { weeklyCapacitySeconds: Math.round(hours * 3600) });
                qc.invalidateQueries({ queryKey: ["bootstrap"] });
                toast.push({ tone: "success", title: `Capacity set to ${hours} hours a week for ${ids.length} ${ids.length === 1 ? "person" : "people"}.` });
              },
            },
            {
              key: "remind", label: "Send reminder", input: "immediate",
              run: async (sel) => {
                // The reminder is about an unsubmitted timesheet, so it needs a
                // week. Last week is the one people are chased about.
                const monday = startOfWeek(new Date());
                monday.setDate(monday.getDate() - 7);
                const count = await api.remindToSubmit(isoDate(monday), (sel as Row[]).map((r) => r.id));
                toast.push({
                  title: count
                    ? `Reminded ${count} ${count === 1 ? "person" : "people"} about the week of ${isoDate(monday)}.`
                    : "Everybody selected has already submitted that week.",
                });
              },
            },
            {
              key: "archive", label: "Archive", input: "immediate", end: true,
              run: async (sel) => {
                const ids = (sel as Row[]).map((r) => r.id);
                for (const id of ids) await api.archiveUser(id, true);
                qc.invalidateQueries({ queryKey: ["bootstrap"] });
                toast.push({
                  tone: "danger",
                  title: `Archived ${ids.length} ${ids.length === 1 ? "person" : "people"}. Their tracked time is kept.`,
                  undo: async () => { for (const id of ids) await api.archiveUser(id, false); qc.invalidateQueries({ queryKey: ["bootstrap"] }); },
                });
              },
            },
          ]}
          empty={<EmptyState title="Nobody here.">Invite people from Settings, People.</EmptyState>}
        />
      </PageBody>
    </>
  );
}
