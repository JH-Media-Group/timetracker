"use client";

import * as React from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Pencil, Info } from "lucide-react";
import * as api from "@/lib/api";
import { cn } from "@/lib/cn";
import { budgetHealth, sumValue } from "@/lib/derive";
import {
  addDays, formatDuration, formatHours, formatMoney, formatMoneyShort, formatPercent,
  isoDate, startOfWeek, toDate,
} from "@/lib/format";
import type { TimeEntry } from "@/lib/types";
import {
  Avatar, Badge, Button, Card, EmptyState, Spinner, Menu, MenuItem, MenuSeparator,
  Meter, Segmented, Skeleton, Tooltip,
} from "@/components/ui/primitives";
import { PageBody, PageHeader } from "@/components/app/page-chrome";
import { BarChart, LineChart, Legend } from "@/components/app/charts";
import { useToast } from "@/components/ui/toast";
import { useApp, useCan } from "@/components/app/providers";
import { InvoiceBadge, Kpi, KpiRow } from "@/components/app/kpi";

export default function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { projectById, clientById, taskById, userById, settings, ready, pinnedProjectIds } = useApp();
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const pinned = pinnedProjectIds.includes(id);
  const [chart, setChart] = React.useState<"progress" | "hours">("progress");
  const [tab, setTab] = React.useState<"tasks" | "team" | "invoices">("tasks");
  const [expanded, setExpanded] = React.useState<string | null>(null);

  const project = projectById.get(id);

  const { data: entries = [], isLoading } = useQuery({
    queryKey: ["time", "project", id],
    queryFn: () => api.listTimeEntries({ projectId: id }),
  });
  const { data: expenses = [] } = useQuery({ queryKey: ["expenses", "project", id], queryFn: () => api.listExpenses({ projectId: id }) });
  const { data: invoices = [] } = useQuery({ queryKey: ["invoices"], queryFn: api.listInvoices });

  // From the server, not from the entries in hand. The two used to compute
  // "invoiced" and "left to invoice" by different rules, and the project page
  // is where somebody decides whether to send a bill.
  const { data: summary, error: summaryError } = useQuery({
    queryKey: ["project-summary", id],
    queryFn: () => api.getProjectSummary(id),
    enabled: !!id,
    // A refused report is an answer, not a failure to retry.
    retry: (count, e) => count < 1 && !(api.isApiError(e) && e.status === 403),
  });

  // The project itself is readable, its report is not. Say which, rather than
  // rendering a row of zeros that reads as "this project has done nothing".
  const reportRestricted = api.isApiError(summaryError) && summaryError.status === 403;
  const showsMoney = summary != null && summary.billableCents !== undefined;

  const pin = useMutation({
    mutationFn: () => api.togglePin(id, !pinned),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bootstrap"] });
      toast.push({ title: pinned ? "Unpinned." : "Pinned to the top of your project list." });
    },
  });

  const archive = useMutation({
    mutationFn: () => api.archiveProject(id, !project?.archivedAt),
    onSuccess: async (updated) => {
      await qc.invalidateQueries({ queryKey: ["bootstrap"] });
      toast.push({
        tone: updated.archivedAt ? "danger" : "success",
        title: updated.archivedAt
          ? "Project archived. It stays in reports and on invoices."
          : "Project restored.",
        undo: async () => {
          await api.archiveProject(id, !updated.archivedAt);
          qc.invalidateQueries({ queryKey: ["bootstrap"] });
        },
      });
    },
    onError: (e) => toast.push({ tone: "danger", title: e instanceof Error ? e.message : "Could not archive that project." }),
  });

  // Weekly series for both charts, over the project's tracked window.
  const weekly = React.useMemo(() => {
    if (!entries.length) return [];
    const sorted = [...entries].sort((a, b) => a.spentOn.localeCompare(b.spentOn));
    const first = startOfWeek(toDate(sorted[0]!.spentOn));
    const last = startOfWeek(api.TODAY);
    // Cent-seconds while accumulating, cents at the end. The chart is a
    // cumulative line, so a cent of drift per week compounds all the way along
    // it and the last point disagrees with the KPI card above it.
    const buckets: { label: string; seconds: number; centSeconds: number }[] = [];
    for (let d = first; d <= last; d = addDays(d, 7)) {
      buckets.push({ label: `${d.getDate()}/${d.getMonth() + 1}`, seconds: 0, centSeconds: 0 });
    }
    for (const e of entries) {
      const wk = startOfWeek(toDate(e.spentOn));
      const idx = Math.round((wk.getTime() - first.getTime()) / (7 * 86400000));
      if (buckets[idx]) {
        buckets[idx].seconds += e.durationSeconds;
        buckets[idx].centSeconds += e.durationSeconds * (e.billableRateCents ?? 0);
      }
    }
    return buckets;
  }, [entries]);

  const cumulative = React.useMemo(() => {
    let acc = 0;
    const useHours = project?.budgetBy === "project_hours";
    return weekly.map((w, i) => {
      acc += useHours ? w.seconds : w.centSeconds;
      return {
        label: w.label,
        value: useHours ? acc / 3600 : Math.round(acc / 3600) / 100,
        partial: i === weekly.length - 1,
      };
    });
  }, [weekly, project]);

  const byTask = React.useMemo(() => {
    const m = new Map<string, TimeEntry[]>();
    for (const e of entries) { const l = m.get(e.taskId); if (l) l.push(e); else m.set(e.taskId, [e]); }
    return [...m.entries()]
      .map(([taskId, list]) => ({
        taskId, list,
        seconds: list.reduce((a, e) => a + e.durationSeconds, 0),
        billable: sumValue(list, (e) => e.durationSeconds, (e) => e.billableRateCents ?? 0),
        cost: sumValue(list, (e) => e.durationSeconds, (e) => e.costRateCents ?? 0),
      }))
      .sort((a, b) => b.seconds - a.seconds);
  }, [entries]);

  const byPerson = React.useMemo(() => {
    const m = new Map<string, TimeEntry[]>();
    for (const e of entries) { const l = m.get(e.userId); if (l) l.push(e); else m.set(e.userId, [e]); }
    return [...m.entries()]
      .map(([userId, list]) => ({
        userId, list,
        seconds: list.reduce((a, e) => a + e.durationSeconds, 0),
        billable: sumValue(list, (e) => e.durationSeconds, (e) => e.billableRateCents ?? 0),
        cost: sumValue(list, (e) => e.durationSeconds, (e) => e.costRateCents ?? 0),
      }))
      .sort((a, b) => b.seconds - a.seconds);
  }, [entries]);

  const projectInvoices = invoices.filter((i) => i.projectIds.includes(id));

  // The bootstrap fetch has to finish before "not found" is the truth.
  if (!project && !ready) {
    return (
      <PageBody className="pt-10">
        <div className="flex items-center gap-2 text-base text-ink-secondary"><Spinner className="size-4" />Loading the project…</div>
      </PageBody>
    );
  }

  if (!project) {
    return <PageBody className="pt-10"><EmptyState title="Project not found." action={<Button onClick={() => router.push("/projects")}>Back to projects</Button>} /></PageBody>;
  }

  const client = clientById.get(project.clientId);
  // The server reports the budget as a number and a unit; the health band and
  // the "hours or fees" label are presentation, so they stay here.
  const b = React.useMemo(() => {
    const raw = summary?.budget;
    if (!raw) return undefined;
    return {
      ...raw,
      kind: raw.by.endsWith("_hours") ? ("hours" as const) : raw.by === "none" ? ("none" as const) : ("fees" as const),
      health: budgetHealth(raw.percentUsed),
    };
  }, [summary]);
  const typeLabel = project.billingType === "fixed_fee" ? "Fixed Fee" : project.billingType === "non_billable" ? "Non-Billable" : "Time & Materials";

  return (
    <>
      <PageHeader
        breadcrumb={[{ label: "Projects", href: "/projects" }, { label: client?.name ?? "" }]}
        title={project.name}
        badge={<Badge variant="outline">{typeLabel}</Badge>}
        actions={
          <>
            {can("project:manage") && (
              <Button variant="secondary" onClick={() => router.push(`/projects/${id}/edit`)}>
                <Pencil className="size-3.5" />Edit project
              </Button>
            )}
            <Menu trigger={<Button variant="secondary">Actions<ChevronDown className="size-3.5" /></Button>}>
              <MenuItem onSelect={() => router.push(`/reports?by=project&project=${id}`)}>View time report</MenuItem>
              <MenuItem onSelect={() => router.push(`/invoices?project=${id}`)}>New invoice</MenuItem>
              <MenuItem onSelect={() => pin.mutate()}>{pinned ? "Unpin" : "Pin"}</MenuItem>
              <MenuSeparator />
              <MenuItem
                danger
                disabled={!can("project:manage") || archive.isPending}
                onSelect={() => archive.mutate()}
              >
                {project.archivedAt ? "Restore" : "Archive"}
              </MenuItem>
            </Menu>
          </>
        }
      />

      <PageBody className="pt-5">
        {/* Chart card */}
        <Card className="mb-4" padded={false}>
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <Segmented
              value={chart} onChange={setChart} aria-label="Chart"
              options={[{ value: "progress", label: "Project progress" }, { value: "hours", label: "Hours per week" }]}
            />
            <Legend items={
              chart === "progress"
                ? [{ label: "Tracked", color: "var(--viz-1)" }, ...(b?.budget ? [{ label: "Over budget", color: "var(--danger)" }] : [])]
                : [{ label: "Hours", color: "var(--viz-1)" }]
            } />
          </div>
          <div className="p-3">
            {isLoading ? <Skeleton className="h-[220px] w-full" /> : weekly.length === 0 ? (
              <div className="grid h-[220px] place-items-center text-base text-ink-secondary">No time tracked yet.</div>
            ) : chart === "progress" ? (
              <LineChart
                data={cumulative}
                ariaLabel={`Cumulative ${project.budgetBy === "project_hours" ? "hours" : "billable value"} for ${project.name}.`}
                format={(v) => (project.budgetBy === "project_hours" ? v.toFixed(0) : formatMoneyShort(v * 100))}
                threshold={b?.budget ? {
                  value: b.kind === "hours" ? b.budget / 3600 : b.budget / 100,
                  label: `Budget: ${b.kind === "hours" ? `${formatHours(b.budget)} hrs` : formatMoney(b.budget)}`,
                } : undefined}
                tipRows={(p, i, prev) => ({
                  title: `Week of ${p.label}`,
                  rows: [
                    { color: "var(--viz-1)", label: "Cumulative", value: project.budgetBy === "project_hours" ? `${p.value.toFixed(2)} hrs` : formatMoney(p.value * 100) },
                    ...(prev ? [{ label: "This week", value: `+${(p.value - prev.value).toFixed(2)}` }] : []),
                  ],
                  foot: b?.budget ? {
                    label: p.value > (b.kind === "hours" ? b.budget / 3600 : b.budget / 100) ? "Over budget" : "Budget remaining",
                    value: b.kind === "hours"
                      ? `${(b.budget / 3600 - p.value).toFixed(2)} hrs`
                      : formatMoney(b.budget - p.value * 100),
                  } : undefined,
                })}
              />
            ) : (
              <BarChart
                data={weekly.map((w, i) => ({ label: w.label, value: w.seconds / 3600, partial: i === weekly.length - 1 }))}
                ariaLabel={`Hours per week for ${project.name}.`}
                format={(v) => v.toFixed(0)}
                tipRows={(p) => ({
                  title: `Week of ${p.label}`,
                  rows: [{ color: "var(--viz-1)", label: "Hours", value: p.value.toFixed(2) }],
                  foot: p.partial ? { label: "Week in progress", value: "partial" } : undefined,
                })}
              />
            )}
          </div>
        </Card>

        {/* KPI row */}
        {reportRestricted && (
          <Card className="mb-6">
            <p className="text-base text-ink-secondary">
              This project&apos;s reports are limited to its managers. You can still see the project,
              its tasks, and your own time on it.
            </p>
          </Card>
        )}
        <div className={cn("mb-6 grid gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5", reportRestricted && "hidden")}>
          <Kpi label="Total hours" value={formatDuration(summary?.totalSeconds ?? 0, settings.timeDisplay)}>
            <KpiRow label="Billable" value={formatDuration(summary?.billableSeconds ?? 0, settings.timeDisplay)} />
            <KpiRow label="Non-billable" value={formatDuration(summary?.nonBillableSeconds ?? 0, settings.timeDisplay)} />
          </Kpi>

          <Kpi
            label={<span className="flex items-center gap-1">Budget remaining {b?.percentUsed != null && `(${formatPercent(b.percentUsed)})`}
              <Tooltip content={b?.kind === "hours" ? "Hours tracked against the project's hour budget." : "Billable value against the project's fee budget."}>
                <Info className="size-3.5 text-ink-tertiary" /></Tooltip></span>}
            value={b?.remaining == null ? "—" : b.kind === "fees" ? formatMoney(b.remaining) : formatHours(b.remaining)}
            danger={(b?.remaining ?? 0) < 0}
          >
            {b?.budget != null && (
              <>
                <KpiRow label="Total budget" value={b.kind === "fees" ? formatMoney(b.budget) : formatHours(b.budget)} />
                <div className="pt-1.5">
                  <Meter segments={(b.percentUsed ?? 0) > 1
                    ? [{ value: 1 / (b.percentUsed ?? 1), tone: "near" }, { value: 0.35, tone: "over" }]
                    : [{ value: b.percentUsed ?? 0, tone: (b.health === "near" ? "near" : "ok") as "ok" | "near" }]} />
                </div>
              </>
            )}
          </Kpi>

          {can("rates:view_cost") && (
            <Kpi label="Internal costs" value={formatMoney(summary?.costCents ?? 0)}>
              <KpiRow label="Time" value={formatMoney((summary?.costCents ?? 0) - (summary?.expenseCents ?? 0))} />
              <KpiRow label="Expenses" value={formatMoney(summary?.expenseCents ?? 0)} />
            </Kpi>
          )}

          {showsMoney && <Kpi label="Invoiced amount" value={formatMoney(summary?.invoicedCents ?? 0)} />}

          {showsMoney && (
          <Kpi label="Uninvoiced amount" value={formatMoney(summary?.uninvoicedCents ?? 0)}>
            {project.feeCents != null && showsMoney && <KpiRow label="Total project fees" value={formatMoney(project.feeCents)} />}
            {summary?.feesToDateCents != null && summary.feesToDateCents !== project.feeCents && (
              <KpiRow label="Earned so far" value={formatMoney(summary.feesToDateCents)} />
            )}
            {(summary?.overbilledCents ?? 0) > 0 && (
              <KpiRow label="Billed ahead" value={formatMoney(summary!.overbilledCents)} />
            )}
            <Link href={`/invoices?project=${id}`} className="text-base text-link underline">New invoice</Link>
          </Kpi>
          )}
        </div>

        {/* Tabs */}
        <div className="mb-4 flex gap-4 border-b border-border">
          {(["tasks", "team", "invoices"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={cn("relative -mb-px border-b-2 px-0.5 py-2 text-base capitalize transition-colors",
                tab === t ? "border-ink font-medium text-ink" : "border-transparent text-ink-secondary hover:text-ink")}>
              {t}
            </button>
          ))}
        </div>

        {tab === "tasks" && (
          <Card padded={false}>
            <BreakdownHeader cols={["Billable tasks", "Hours", ...(showsMoney ? ["If billed hourly"] : []), ...(can("rates:view_cost") ? ["Costs"] : [])]} />
            {byTask.map((row) => {
              const task = taskById.get(row.taskId);
              const open = expanded === row.taskId;
              const people = new Map<string, number>();
              row.list.forEach((e) => people.set(e.userId, (people.get(e.userId) ?? 0) + e.durationSeconds));
              return (
                <div key={row.taskId} className="border-b border-border last:border-b-0">
                  <button onClick={() => setExpanded(open ? null : row.taskId)}
                    className="flex w-full items-center px-4 py-2.5 text-left hover:bg-surface-hover">
                    <span className="flex min-w-0 flex-1 items-center gap-1.5">
                      <ChevronRight className={cn("size-4 shrink-0 text-ink-tertiary transition-transform", open && "rotate-90")} />
                      <span className="truncate">{task?.name}</span>
                    </span>
                    <span className="w-24 text-right tabular-nums">{formatDuration(row.seconds, settings.timeDisplay)}</span>
                    {showsMoney && <span className="w-36 text-right tabular-nums">{formatMoney(row.billable)}</span>}
                    {can("rates:view_cost") && <span className="w-32 text-right tabular-nums">{formatMoney(row.cost)}</span>}
                  </button>
                  {open && (
                    <div className="bg-bg-subtle">
                      {[...people.entries()].sort((a, b) => b[1] - a[1]).map(([uid, secs]) => {
                        const u = userById.get(uid);
                        return (
                          <div key={uid} className="flex items-center px-4 py-2 pl-11">
                            <span className="flex min-w-0 flex-1 items-center gap-2">
                              {u && <Avatar user={u} size="xs" />}
                              <span className="truncate text-ink-secondary">{u?.firstName} {u?.lastName}</span>
                            </span>
                            <span className="w-24 text-right tabular-nums text-ink-secondary">{formatDuration(secs, settings.timeDisplay)}</span>
                            <span className="w-36" />
                            {can("rates:view_cost") && <span className="w-32" />}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
            <TotalRow
              cols={[
                formatDuration(summary?.totalSeconds ?? 0, settings.timeDisplay),
                ...(showsMoney ? [formatMoney(summary?.billableCents ?? 0)] : []),
                ...(can("rates:view_cost") ? [formatMoney((summary?.costCents ?? 0) - (summary?.expenseCents ?? 0))] : []),
              ]}
            />
          </Card>
        )}

        {tab === "team" && (
          <Card padded={false}>
            <BreakdownHeader cols={["Team", "Hours", ...(showsMoney ? ["If billed hourly"] : []), ...(can("rates:view_cost") ? ["Costs"] : [])]} />
            {byPerson.map((row) => {
              const u = userById.get(row.userId);
              return (
                <div key={row.userId} className="flex items-center border-b border-border px-4 py-2.5 last:border-b-0">
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    {u && <Avatar user={u} size="sm" />}
                    <Link href={`/team/${row.userId}`} className="truncate hover:underline">{u?.firstName} {u?.lastName}</Link>
                    {project.managerIds.includes(row.userId) && <Badge variant="outline">Manager</Badge>}
                  </span>
                  <span className="w-24 text-right tabular-nums">{formatDuration(row.seconds, settings.timeDisplay)}</span>
                  {showsMoney && <span className="w-36 text-right tabular-nums">{formatMoney(row.billable)}</span>}
                  {can("rates:view_cost") && <span className="w-32 text-right tabular-nums">{formatMoney(row.cost)}</span>}
                </div>
              );
            })}
          </Card>
        )}

        {tab === "invoices" && (
          <Card padded={false}>
            {projectInvoices.length === 0 ? (
              <div className="p-4"><EmptyState title="No invoices linked to this project.">Invoices you create from this project will appear here.</EmptyState></div>
            ) : (
              <>
                <BreakdownHeader cols={["Invoice", "Issue date", "Status", "Amount"]} />
                {projectInvoices.map((i) => (
                  <div key={i.id} className="flex items-center border-b border-border px-4 py-2.5 last:border-b-0">
                    <Link href={`/invoices/${i.id}`} className="min-w-0 flex-1 truncate font-mono text-base hover:underline">{i.number}</Link>
                    <span className="w-28 text-right tabular-nums text-ink-secondary">{i.issueDate}</span>
                    <span className="w-28 text-right"><InvoiceBadge state={i.state} /></span>
                    <span className="w-32 text-right tabular-nums">{formatMoney(i.totalCents)}</span>
                  </div>
                ))}
              </>
            )}
          </Card>
        )}
      </PageBody>
    </>
  );
}

function BreakdownHeader({ cols }: { cols: string[] }) {
  const [first, ...rest] = cols;
  return (
    <div className="flex items-center border-b border-border bg-bg-muted px-4 py-2 text-xs font-semibold uppercase tracking-[0.04em] text-ink-tertiary">
      <span className="flex-1">{first}</span>
      {rest.map((c, i) => <span key={c} className={i === 0 ? "w-24 text-right" : i === 1 ? "w-36 text-right" : "w-32 text-right"}>{c}</span>)}
    </div>
  );
}
function TotalRow({ cols }: { cols: string[] }) {
  return (
    <div className="flex items-center border-t border-border-strong px-4 py-2.5 font-semibold">
      <span className="flex-1">Total</span>
      {cols.map((c, i) => <span key={i} className={cn("text-right tabular-nums", i === 0 ? "w-24" : i === 1 ? "w-36" : "w-32")}>{c}</span>)}
    </div>
  );
}
