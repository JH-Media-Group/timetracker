"use client";

/**
 * Approvals queue.
 *
 * A reviewer's job is repetitive, so the page optimises for the repetition:
 * the whole queue can be approved from the action row without opening a single
 * row, and the flags that would make someone hesitate are on the row itself.
 */

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColDef } from "ag-grid-community";
import { Check } from "lucide-react";
import * as api from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatDateUS, formatDuration, formatWeekRange, relativeTime, toDate } from "@/lib/format";
import { SUBMISSION_LABEL } from "@/lib/labels";
import type { SubmissionState, TimeEntry, TimesheetSubmission } from "@/lib/types";
import {
  Avatar, Badge, Button, Card, EmptyState, Select, Spinner, Tooltip,
} from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { PageBody, PageHeader, useUrlState } from "@/components/app/page-chrome";
import { DataGrid } from "@/components/app/data-grid";
import { Kpi } from "@/components/app/kpi";
import { useApp, useCan } from "@/components/app/providers";
import type { GridRow } from "@/components/ui/grid";

const STATE_VARIANT: Record<SubmissionState, "neutral" | "info" | "success" | "warning"> = {
  draft: "neutral", submitted: "info", approved: "success", changes_requested: "warning",
};

interface Row {
  _id: string; _kind: "data";
  id: string; userId: string; firstName: string; lastName: string; photo?: string;
  name: string; period: string; periodStart: string; periodEnd: string;
  seconds: number; state: SubmissionState; submittedAt?: string; flags: string[];
  reviewNote?: string;
}

export default function ApprovalsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { params, set } = useUrlState();
  const { userById } = useApp();
  const can = useCan();

  const state = (params.get("state") as SubmissionState | "all") || "submitted";
  const [expanded, setExpanded] = React.useState<string | null>(null);

  const { data: submissions = [], isLoading } = useQuery({
    queryKey: ["submissions"], queryFn: api.listSubmissions,
  });

  const all = submissions as TimesheetSubmission[];

  const counts = React.useMemo(() => ({
    submitted: all.filter((s) => s.state === "submitted").length,
    approved: all.filter((s) => s.state === "approved").length,
    changes_requested: all.filter((s) => s.state === "changes_requested").length,
    all: all.length,
  }), [all]);

  const pendingSeconds = React.useMemo(
    () => all.filter((s) => s.state === "submitted").reduce((a, s) => a + s.totalSeconds, 0),
    [all]
  );

  const oldest = React.useMemo(() => {
    const waiting = all.filter((s) => s.state === "submitted" && s.submittedAt);
    if (!waiting.length) return null;
    return waiting.reduce((a, b) => (a.submittedAt! < b.submittedAt! ? a : b));
  }, [all]);

  const rows = React.useMemo<GridRow<Row>[]>(() =>
    all
      .filter((s) => (state === "all" ? true : s.state === state))
      .sort((a, b) => (b.submittedAt ?? "").localeCompare(a.submittedAt ?? "") || b.periodStart.localeCompare(a.periodStart))
      .map((s) => {
        const u = userById.get(s.userId);
        return {
          _id: s.id, _kind: "data" as const, id: s.id, userId: s.userId,
          firstName: u?.firstName ?? "?", lastName: u?.lastName ?? "",
          photo: u?.photo, name: u ? `${u.firstName} ${u.lastName}` : "Unknown",
          period: formatWeekRange(toDate(s.periodStart)),
          periodStart: s.periodStart, periodEnd: s.periodEnd,
          seconds: s.totalSeconds, state: s.state, submittedAt: s.submittedAt,
          flags: s.flags, reviewNote: s.reviewNote,
        };
      }),
  [all, state, userById]);

  const review = React.useCallback(async (ids: string[], next: "approved" | "changes_requested", note?: string) => {
    for (const id of ids) await api.reviewSubmission(id, next, note);
    qc.invalidateQueries({ queryKey: ["submissions"] });
    toast.push({
      tone: next === "approved" ? "success" : "default",
      title: next === "approved"
        ? `Approved ${ids.length} ${ids.length === 1 ? "timesheet" : "timesheets"}.`
        : `Changes requested on ${ids.length} ${ids.length === 1 ? "timesheet" : "timesheets"}.`,
    });
  }, [qc, toast]);

  const columns = React.useMemo<ColDef[]>(() => [
    {
      colId: "name", field: "name", headerName: "Person", flex: 1, minWidth: 220,
      cellRenderer: (p: { data?: Row }) => p.data && (
        <span className="flex min-w-0 items-center gap-2.5">
          <Avatar user={p.data} size="sm" />
          <span className="truncate font-medium text-ink">{p.data.name}</span>
        </span>
      ),
    },
    { colId: "period", field: "period", headerName: "Week", width: 180 },
    { colId: "seconds", field: "seconds", headerName: "Hours", type: "duration", width: 110 },
    {
      colId: "flags", headerName: "Flags", width: 230, sortable: false,
      valueGetter: (p: { data?: Row }) => p.data?.flags?.join(", ") ?? "",
      cellRenderer: (p: { data?: Row }) => {
        if (!p.data?.flags?.length) return <span className="text-ink-tertiary">None</span>;
        return (
          <span className="flex items-center gap-1.5">
            {p.data.flags.slice(0, 2).map((f) => <Badge key={f} variant="warning">{f}</Badge>)}
            {p.data.flags.length > 2 && (
              <Tooltip content={p.data.flags.slice(2).join(", ")}>
                <span className="text-sm text-ink-tertiary">+{p.data.flags.length - 2}</span>
              </Tooltip>
            )}
          </span>
        );
      },
    },
    {
      colId: "submittedAt", headerName: "Submitted", width: 150,
      valueGetter: (p: { data?: Row }) => p.data?.submittedAt ?? "",
      cellRenderer: (p: { data?: Row }) =>
        p.data?.submittedAt
          ? <span className="text-ink-secondary">{relativeTime(p.data.submittedAt)}</span>
          : <span className="text-ink-tertiary">Not submitted</span>,
    },
    {
      colId: "state", field: "state", headerName: "Status", width: 170,
      cellRenderer: (p: { data?: Row }) => p.data?.state && (
        <Badge variant={STATE_VARIANT[p.data.state]} dot={p.data.state !== "draft"}>
          {SUBMISSION_LABEL[p.data.state]}
        </Badge>
      ),
    },
  ], []);

  const totals = React.useMemo(() => ({
    name: "Total", seconds: rows.reduce((a, r) => a + r.seconds, 0),
  }), [rows]);

  if (!can("approval:review")) {
    return (
      <>
        <PageHeader title="Approvals" />
        <PageBody className="pt-6">
          <EmptyState title="You do not review timesheets.">
            Your own submissions live at the top of the Timesheet page.
          </EmptyState>
        </PageBody>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Approvals"
        actions={counts.submitted > 0 && (
          <Button
            variant="primary"
            onClick={() => review(all.filter((s) => s.state === "submitted").map((s) => s.id), "approved")}
          >
            <Check className="size-4" />Approve all {counts.submitted}
          </Button>
        )}
      />

      <PageBody className="pt-4">
        <div className="mb-4 grid gap-4 md:grid-cols-3">
          <Kpi label="Awaiting approval" value={String(counts.submitted)} muted={counts.submitted === 0}>
            <div className="mt-2 text-base text-ink-secondary">{formatDuration(pendingSeconds)} hours in the queue</div>
          </Kpi>
          <Kpi label="Waiting longest" value={oldest?.submittedAt ? relativeTime(oldest.submittedAt) : "Nothing"} muted={!oldest}>
            <div className="mt-2 truncate text-base text-ink-secondary">
              {oldest
                ? `${userById.get(oldest.userId)?.firstName ?? "Someone"}, week of ${formatDateUS(oldest.periodStart)}`
                : "The queue is clear"}
            </div>
          </Kpi>
          <Kpi label="Changes requested" value={String(counts.changes_requested)} muted={counts.changes_requested === 0}>
            <div className="mt-2 text-base text-ink-secondary">Sent back and not yet resubmitted</div>
          </Kpi>
        </div>

        <DataGrid<Row>
          label="Timesheet approvals"
          tableId="approvals"
          rows={rows}
          columns={columns}
          loading={isLoading}
          totals={totals}
          height={520}
          selectable
          onRowOpen={(r) => setExpanded((cur) => (cur === r.id ? null : r.id))}
          onExport={() => toast.push({ title: "Export queued. You will get an email when it is ready." })}
          filters={
            <Select value={state} onChange={(e) => set({ state: e.target.value })} className="w-[230px]" aria-label="Approval status">
              <option value="submitted">Awaiting approval ({counts.submitted})</option>
              <option value="changes_requested">Changes requested ({counts.changes_requested})</option>
              <option value="approved">Approved ({counts.approved})</option>
              <option value="all">All submissions ({counts.all})</option>
            </Select>
          }
          bulkActions={[
            {
              key: "approve", label: "Approve", input: "immediate",
              run: async (sel) => { await review((sel as Row[]).map((r) => r.id), "approved"); },
            },
            {
              key: "changes", label: "Request changes", input: "inline",
              inlineLabel: "Reason", inlinePlaceholder: "Missing Friday",
              run: async (sel, note) => { await review((sel as Row[]).map((r) => r.id), "changes_requested", note); },
            },
          ]}
          empty={
            <EmptyState title={state === "submitted" ? "Nothing to approve." : "Nothing here."}>
              {state === "submitted"
                ? "Timesheets appear here the moment someone submits a week."
                : "Try a different status."}
            </EmptyState>
          }
        />

        {expanded && <SubmissionDetail id={expanded} rows={rows} onClose={() => setExpanded(null)} onReview={review} />}
      </PageBody>
    </>
  );
}

/** The week behind one submission, opened under the table rather than in a modal
 *  so the reviewer keeps the queue in view. */
function SubmissionDetail({
  id, rows, onClose, onReview,
}: {
  id: string;
  rows: Row[];
  onClose: () => void;
  onReview: (ids: string[], next: "approved" | "changes_requested", note?: string) => Promise<void>;
}) {
  const row = rows.find((r) => r.id === id);
  const { projectById, taskById } = useApp();
  const [note, setNote] = React.useState("");

  const { data: entries, isLoading } = useQuery({
    queryKey: ["time", "submission", row?.userId, row?.periodStart, row?.periodEnd],
    queryFn: () => api.listTimeEntries({ userId: row!.userId, from: row!.periodStart, to: row!.periodEnd }),
    enabled: !!row,
  });

  if (!row) return null;

  const byDay = new Map<string, TimeEntry[]>();
  for (const e of (entries ?? []) as TimeEntry[]) {
    const l = byDay.get(e.spentOn); if (l) l.push(e); else byDay.set(e.spentOn, [e]);
  }

  return (
    <Card className="mt-4" padded={false}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <Avatar user={row} size="sm" />
          <div className="min-w-0">
            <div className="truncate font-medium text-ink">{row.name}</div>
            <div className="truncate text-sm text-ink-tertiary">
              {row.period} · {formatDuration(row.seconds)} hours
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note for the person (optional)"
            className="h-8 w-[240px] rounded-md border border-border bg-surface px-2.5 text-base outline-none focus:border-focus focus:shadow-[var(--focus-ring)]"
          />
          <Button variant="secondary" size="sm" onClick={() => onReview([row.id], "changes_requested", note).then(onClose)}>
            Request changes
          </Button>
          <Button variant="primary" size="sm" onClick={() => onReview([row.id], "approved", note).then(onClose)}>
            <Check className="size-3.5" />Approve week
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 p-4 text-base text-ink-secondary"><Spinner className="size-4" />Loading the week…</div>
      ) : byDay.size === 0 ? (
        <div className="p-4"><EmptyState title="No time in this week.">There is nothing to approve.</EmptyState></div>
      ) : (
        [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, list]) => (
          <div key={day}>
            <div className="flex items-center justify-between border-b border-border bg-bg-muted px-4 py-1.5 text-sm font-medium text-ink-secondary">
              <span>{formatDateUS(day)}</span>
              <span className="tabular-nums">{formatDuration(list.reduce((a, e) => a + e.durationSeconds, 0))}</span>
            </div>
            {list.map((e) => (
              <div key={e.id} className="flex items-center border-b border-border px-4 py-2 text-base last:border-b-0">
                <span className="min-w-0 flex-1">
                  <span className="block truncate leading-tight text-ink">
                    {projectById.get(e.projectId)?.name} <span className="text-ink-tertiary">·</span> {taskById.get(e.taskId)?.name}
                  </span>
                  {e.notes && <span className="block truncate text-sm leading-tight text-ink-tertiary">{e.notes}</span>}
                </span>
                <span className={cn("w-24 text-right tabular-nums", !e.isBillable && "text-ink-tertiary")}>
                  {formatDuration(e.durationSeconds)}
                </span>
              </div>
            ))}
          </div>
        ))
      )}
    </Card>
  );
}
