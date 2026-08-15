"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColDef } from "ag-grid-community";
import { Plus, Download, Upload } from "lucide-react";
import * as api from "@/lib/api";
import { projectBudget, sumValue } from "@/lib/derive";
import { formatDuration, formatHoursUnit, formatMoney, formatPercent } from "@/lib/format";
import type { Project, TimeEntry } from "@/lib/types";
import { Badge, Button, EmptyState, Meter, Select } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { PageBody, PageHeader, Toolbar, useUrlState } from "@/components/app/page-chrome";
import { DataGrid } from "@/components/app/data-grid";
import { useApp, useCan } from "@/components/app/providers";
import type { GridRow } from "@/components/ui/grid";

type Status = "active" | "budgeted" | "archived";

interface Row {
  _id: string; _kind: "group" | "data";
  _group?: { label: string; sublabel?: string };
  id?: string; name?: string; client?: string; type?: string;
  budget?: number | null; budgetKind?: "hours" | "fees" | "none";
  spent?: number; remaining?: number | null; pct?: number | null;
  health?: string; costs?: number; monthly?: boolean;
}

export default function ProjectsPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const { params, set } = useUrlState();
  const { projects, clientById, userById, projectById } = useApp();
  const can = useCan();

  const status = (params.get("status") as Status) || "active";
  const clientFilter = params.get("client") || "";

  const { data: entries = [], isLoading } = useQuery({
    queryKey: ["time", "all"],
    queryFn: () => api.listTimeEntries({}),
  });

  const byProject = React.useMemo(() => {
    const m = new Map<string, TimeEntry[]>();
    for (const e of entries) { const l = m.get(e.projectId); if (l) l.push(e); else m.set(e.projectId, [e]); }
    return m;
  }, [entries]);

  const counts = React.useMemo(() => ({
    active: projects.filter((p) => !p.archivedAt).length,
    budgeted: projects.filter((p) => !p.archivedAt && p.budgetBy !== "none").length,
    archived: projects.filter((p) => !!p.archivedAt).length,
  }), [projects]);

  const rows = React.useMemo<GridRow<Row>[]>(() => {
    let list = projects.filter((p) =>
      status === "archived" ? !!p.archivedAt
      : status === "budgeted" ? !p.archivedAt && p.budgetBy !== "none"
      : !p.archivedAt
    );
    if (clientFilter) list = list.filter((p) => p.clientId === clientFilter);

    // Group by client, in client-name order, with a group header row per client.
    // Community AG Grid has no row grouping, so the rows arrive pre-grouped.
    const groups = new Map<string, Project[]>();
    for (const p of list) {
      const name = clientById.get(p.clientId)?.name ?? "Unknown client";
      const g = groups.get(name); if (g) g.push(p); else groups.set(name, [p]);
    }

    const out: GridRow<Row>[] = [];
    for (const [client, list2] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      out.push({ _id: `g-${client}`, _kind: "group", _group: { label: client } } as GridRow<Row>);
      for (const p of list2.sort((a, b) => a.name.localeCompare(b.name))) {
        const mine = byProject.get(p.id) ?? [];
        const b = projectBudget(p, mine);
        const costs = sumValue(mine, (e) => e.durationSeconds, (e) => e.costRateCents ?? 0);
        out.push({
          _id: p.id, _kind: "data", id: p.id, name: p.name, client,
          type: p.billingType === "fixed_fee" ? "Fixed Fee" : p.billingType === "non_billable" ? "Non-Billable" : "Time & Materials",
          budget: b.budget, budgetKind: b.kind, spent: b.spent,
          remaining: b.remaining, pct: b.percentUsed, health: b.health,
          costs, monthly: p.budgetResetsMonthly,
        } as GridRow<Row>);
      }
    }
    return out;
  }, [projects, status, clientFilter, clientById, byProject]);

  const columns = React.useMemo<ColDef[]>(() => [
    {
      colId: "name", field: "name", headerName: "Project", flex: 1, minWidth: 260,
      cellRenderer: (p: { data?: Row }) => {
        if (!p.data?.name) return null;
        return (
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate font-medium text-ink">{p.data.name}</span>
            <span className="shrink-0"><Badge variant="outline">{p.data.type}</Badge></span>
          </span>
        );
      },
    },
    {
      colId: "budget", headerName: "Budget", width: 130, type: "numeric",
      valueGetter: (p: { data?: Row }) => p.data?.budget ?? null,
      valueFormatter: (p: { data?: Row; value: number | null }) =>
        p.value == null ? "—" : p.data?.budgetKind === "fees" ? formatMoney(p.value) : formatHoursUnit(p.value),
    },
    {
      colId: "spent", headerName: "Spent", width: 130, type: "numeric",
      /*
        Null, not 0, when there is nothing to show.
        The pinned totals row carries no `spent`, and `?? 0` made it read
        "$0.00" across every project on the page: a total that is not merely
        absent but wrong, and wrong in the direction someone would act on.
        Budget and Remaining beside it already return null here.

        The total stays the no-value glyph rather than becoming a sum, because
        this column holds hours on an hours-budgeted row and money on a
        fee-budgeted one. Adding them would produce a number with no unit.
      */
      valueGetter: (p: { data?: Row }) => p.data?.spent ?? null,
      valueFormatter: (p: { data?: Row; value: number | null }) =>
        p.value == null ? "—" : p.data?.budgetKind === "hours" ? formatHoursUnit(p.value) : formatMoney(p.value),
    },
    {
      colId: "progress", headerName: "Progress", width: 170, sortable: false,
      cellRenderer: (p: { data?: Row }) => {
        if (!p.data || p.data.pct == null) return <span className="text-ink-tertiary">—</span>;
        const pct = p.data.pct;
        const tone = pct > 1 ? "near" : pct >= 0.8 ? "near" : "ok";
        return (
          <span className="tly-meter-row flex w-full min-w-0 flex-1 items-center gap-2">
            <span className="tly-meter min-w-8 flex-1">
              <Meter segments={pct > 1
                ? [{ value: 1 / Math.max(pct, 1), tone: "near" }, { value: Math.min((pct - 1) / pct, 0.5), tone: "over" }]
                : [{ value: pct, tone: tone as "ok" | "near" }]} />
            </span>
            <span className="w-10 shrink-0 text-right text-sm tabular-nums text-ink-secondary">{formatPercent(pct)}</span>
          </span>
        );
      },
    },
    {
      colId: "remaining", headerName: "Remaining", width: 140, type: "numeric",
      valueGetter: (p: { data?: Row }) => p.data?.remaining ?? null,
      cellRenderer: (p: { data?: Row; value: number | null }) => {
        if (p.value == null) return <span className="text-ink-tertiary">—</span>;
        const neg = p.value < 0;
        const txt = p.data?.budgetKind === "fees" ? formatMoney(p.value) : formatHoursUnit(p.value);
        return <span className={neg ? "font-medium text-danger" : ""}>{txt}</span>;
      },
    },
    ...(can("rates:view_cost") ? [{
      colId: "costs", field: "costs", headerName: "Costs", width: 130, type: "money",
    } as ColDef] : []),
  ], [can]);

  const totals = React.useMemo(() => {
    const data = rows.filter((r) => r._kind === "data");
    return { name: "Total", costs: data.reduce((a, r) => a + (r.costs ?? 0), 0) };
  }, [rows]);

  return (
    <>
      <PageHeader
        title="Projects"
        actions={
          <>
            {can("project:manage") && (
              <Button variant="primary" onClick={() => router.push("/projects/new")}>
                <Plus className="size-4" />New project
              </Button>
            )}
            <Button variant="secondary" onClick={() => router.push("/settings?tab=data")}>
              <Upload className="size-3.5" />Import
            </Button>
          </>
        }
      />
      <PageBody className="pt-4">
        <DataGrid<Row>
          label="Projects"
          tableId="projects"
          rows={rows}
          columns={columns}
          loading={isLoading}
          totals={totals}
          height={620}
          selectable={can("project:manage")}
          onRowOpen={(r) => r.id && router.push(`/projects/${r.id}`)}
          filters={
            <>
              <Select value={status} onChange={(e) => set({ status: e.target.value })} className="w-[200px]" aria-label="Project status">
                <option value="active">Active projects ({counts.active})</option>
                <option value="budgeted">Budgeted projects ({counts.budgeted})</option>
                <option value="archived">Archived projects ({counts.archived})</option>
              </Select>
              <Select value={clientFilter} onChange={(e) => set({ client: e.target.value })} className="w-[220px]" aria-label="Filter by client">
                <option value="">All clients</option>
                {[...clientById.values()].sort((a, b) => a.name.localeCompare(b.name)).map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </Select>
            </>
          }
          bulkActions={[
            {
              key: "tags", label: "Add tags", input: "inline",
              inlineLabel: "Tags", inlinePlaceholder: "retainer, priority",
              run: async (sel, value) => {
                const added = (value ?? "").split(",").map((t) => t.trim()).filter(Boolean);
                if (!added.length) { toast.push({ tone: "danger", title: "Type one or more tags, separated by commas." }); return; }
                const ids = (sel as Row[]).map((r) => r.id!).filter(Boolean);
                for (const id of ids) {
                  const current = projectById.get(id)?.tags ?? [];
                  await api.updateProject(id, { tags: [...new Set([...current, ...added])] });
                }
                qc.invalidateQueries({ queryKey: ["bootstrap"] });
                toast.push({ tone: "success", title: `Tagged ${ids.length} ${ids.length === 1 ? "project" : "projects"}.` });
              },
            },
            { key: "archive", label: "Archive", input: "immediate", end: true, run: async (sel) => {
              const ids = (sel as Row[]).map((r) => r.id!).filter(Boolean);
              for (const id of ids) await api.archiveProject(id, true);
              qc.invalidateQueries({ queryKey: ["bootstrap"] });
              toast.push({
                tone: "success", title: `Archived ${ids.length} ${ids.length === 1 ? "project" : "projects"}.`,
                undo: async () => { for (const id of ids) await api.archiveProject(id, false); qc.invalidateQueries({ queryKey: ["bootstrap"] }); },
              });
            }},
            {
              key: "delete", label: "Delete", intent: "danger", input: "modal", end: true,
              // Archive, not delete: a project carries tracked hours and
              // invoices, and removing it would take the history of work that
              // was really done and really billed with it.
              run: async (sel) => {
                const ids = (sel as Row[]).map((r) => r.id!).filter(Boolean);
                for (const id of ids) await api.archiveProject(id, true);
                qc.invalidateQueries({ queryKey: ["bootstrap"] });
                toast.push({
                  tone: "danger",
                  title: `Archived ${ids.length} ${ids.length === 1 ? "project" : "projects"}. Projects are archived rather than deleted, because their hours and invoices are real.`,
                  undo: async () => { for (const id of ids) await api.archiveProject(id, false); qc.invalidateQueries({ queryKey: ["bootstrap"] }); },
                });
              },
            },
          ]}
          empty={
            <EmptyState title="No projects here." action={<Button variant="primary" onClick={() => router.push("/projects/new")}>New project</Button>}>
              {status === "archived" ? "Archived projects will appear here." : "Projects you create will appear here, grouped by client."}
            </EmptyState>
          }
        />
      </PageBody>
    </>
  );
}
