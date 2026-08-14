"use client";

/**
 * Task library.
 *
 * Tasks are shared across every project, so this page is small but consequential:
 * the two defaults set here (billable, and added to new projects) decide what
 * most people see in the timer dropdown for the next year.
 */

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColDef } from "ag-grid-community";
import { Plus } from "lucide-react";
import * as api from "@/lib/api";
import type { Task, TimeEntry } from "@/lib/types";
import {
  Badge, Button, Checkbox, Dialog, DialogContent, EmptyState, Field, Input, Select,
} from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { PageBody, PageHeader, useUrlState } from "@/components/app/page-chrome";
import { DataGrid } from "@/components/app/data-grid";
import { useApp, useCan } from "@/components/app/providers";
import type { GridRow } from "@/components/ui/grid";

interface Row {
  _id: string; _kind: "data";
  id: string; name: string; billable: boolean; common: boolean;
  seconds: number; projects: number; archived: boolean;
}

export default function TasksPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { params, set } = useUrlState();
  const { tasks, projects } = useApp();
  const can = useCan();

  const status = params.get("status") || "active";
  const [creating, setCreating] = React.useState(false);

  const { data: entries = [], isLoading } = useQuery({
    queryKey: ["time", "all"], queryFn: () => api.listTimeEntries({}),
  });

  const secondsByTask = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const e of entries as TimeEntry[]) m.set(e.taskId, (m.get(e.taskId) ?? 0) + e.durationSeconds);
    return m;
  }, [entries]);

  const projectsByTask = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const p of projects) {
      if (p.archivedAt) continue;
      for (const t of p.taskIds) m.set(t, (m.get(t) ?? 0) + 1);
    }
    return m;
  }, [projects]);

  const counts = React.useMemo(() => ({
    active: tasks.filter((t) => !t.archivedAt).length,
    archived: tasks.filter((t) => !!t.archivedAt).length,
  }), [tasks]);

  const rows = React.useMemo<GridRow<Row>[]>(() =>
    tasks
      .filter((t) => (status === "archived" ? !!t.archivedAt : !t.archivedAt))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => ({
        _id: t.id, _kind: "data" as const, id: t.id, name: t.name,
        billable: t.defaultBillable, common: t.isCommon,
        seconds: secondsByTask.get(t.id) ?? 0,
        projects: projectsByTask.get(t.id) ?? 0,
        archived: !!t.archivedAt,
      })),
  [tasks, status, secondsByTask, projectsByTask]);

  const setFlag = async (id: string, patch: Partial<Task>) => {
    await api.updateTask(id, patch);
    qc.invalidateQueries({ queryKey: ["bootstrap"] });
  };

  const columns = React.useMemo<ColDef[]>(() => [
    {
      colId: "name", field: "name", headerName: "Task", flex: 1, minWidth: 240,
      cellRenderer: (p: { data?: Row }) => p.data && (
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium text-ink">{p.data.name}</span>
          {p.data.archived && <Badge variant="neutral">Archived</Badge>}
        </span>
      ),
    },
    {
      colId: "billable", headerName: "Billable by default", width: 180, sortable: true,
      valueGetter: (p: { data?: Row }) => !!p.data?.billable,
      cellRenderer: (p: { data?: Row }) => p.data && (
        <label className="flex h-full items-center gap-2" onClick={(e) => e.stopPropagation()}>
          <Checkbox
            checked={p.data.billable}
            disabled={!can("task:manage")}
            aria-label={`Billable by default: ${p.data.name}`}
            onCheckedChange={(v) => setFlag(p.data!.id, { defaultBillable: v })}
          />
        </label>
      ),
    },
    {
      colId: "common", headerName: "Added to new projects", width: 200, sortable: true,
      valueGetter: (p: { data?: Row }) => !!p.data?.common,
      cellRenderer: (p: { data?: Row }) => p.data && (
        <label className="flex h-full items-center gap-2" onClick={(e) => e.stopPropagation()}>
          <Checkbox
            checked={p.data.common}
            disabled={!can("task:manage")}
            aria-label={`Added to new projects: ${p.data.name}`}
            onCheckedChange={(v) => setFlag(p.data!.id, { isCommon: v })}
          />
        </label>
      ),
    },
    { colId: "projects", field: "projects", headerName: "Projects", type: "numeric", width: 110 },
    {
      colId: "seconds", field: "seconds", headerName: "Hours tracked", type: "duration", width: 150,
    },
  ], [can, qc]); // eslint-disable-line react-hooks/exhaustive-deps

  const totals = React.useMemo(() => ({
    name: "Total",
    projects: rows.reduce((a, r) => a + r.projects, 0),
    seconds: rows.reduce((a, r) => a + r.seconds, 0),
  }), [rows]);

  return (
    <>
      <PageHeader
        title="Tasks"
        actions={can("task:manage") && (
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus className="size-4" />New task
          </Button>
        )}
      />
      <PageBody className="pt-4">
        <p className="mb-3 max-w-[70ch] text-base text-ink-secondary">
          Every project draws from this one list. Renaming a task here renames it everywhere,
          including on time already tracked, so the totals in reports stay comparable.
        </p>

        <DataGrid<Row>
          label="Tasks"
          tableId="tasks"
          rows={rows}
          columns={columns}
          loading={isLoading}
          totals={totals}
          height={560}
          selectable={can("task:manage")}
          filters={
            <Select value={status} onChange={(e) => set({ status: e.target.value })} className="w-[190px]" aria-label="Task status">
              <option value="active">Active tasks ({counts.active})</option>
              <option value="archived">Archived tasks ({counts.archived})</option>
            </Select>
          }
          bulkActions={[
            {
              key: "billable", label: "Mark billable", input: "immediate",
              run: async (sel) => {
                for (const r of sel as Row[]) await api.updateTask(r.id, { defaultBillable: true });
                qc.invalidateQueries({ queryKey: ["bootstrap"] });
                toast.push({ tone: "success", title: `Marked ${sel.length} tasks billable by default.` });
              },
            },
            {
              key: "nonbillable", label: "Mark non-billable", input: "immediate",
              run: async (sel) => {
                for (const r of sel as Row[]) await api.updateTask(r.id, { defaultBillable: false });
                qc.invalidateQueries({ queryKey: ["bootstrap"] });
                toast.push({ tone: "success", title: `Marked ${sel.length} tasks non-billable by default.` });
              },
            },
            {
              key: "archive", label: status === "archived" ? "Restore" : "Archive", input: "immediate", end: true,
              run: async (sel) => {
                const archiving = status !== "archived";
                const ids = (sel as Row[]).map((r) => r.id);
                for (const id of ids) await api.updateTask(id, { archivedAt: archiving ? new Date().toISOString() : undefined });
                qc.invalidateQueries({ queryKey: ["bootstrap"] });
                toast.push({
                  tone: "success",
                  title: `${archiving ? "Archived" : "Restored"} ${ids.length} ${ids.length === 1 ? "task" : "tasks"}.`,
                  undo: async () => {
                    for (const id of ids) await api.updateTask(id, { archivedAt: archiving ? undefined : new Date().toISOString() });
                    qc.invalidateQueries({ queryKey: ["bootstrap"] });
                  },
                });
              },
            },
            {
              key: "delete", label: "Delete", intent: "danger", input: "modal", end: true,
              run: () => { toast.push({ tone: "danger", title: "Tasks with tracked time cannot be deleted. Archive them instead." }); },
            },
          ]}
          empty={
            <EmptyState title="No tasks here." action={can("task:manage") && <Button variant="primary" onClick={() => setCreating(true)}>New task</Button>}>
              {status === "archived" ? "Archived tasks will appear here." : "Add the work types your team tracks against."}
            </EmptyState>
          }
        />
      </PageBody>

      <NewTaskDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}

function NewTaskDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = React.useState("");
  const [billable, setBillable] = React.useState(true);
  const [common, setCommon] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => { if (open) { setName(""); setBillable(true); setCommon(false); } }, [open]);

  const create = async () => {
    if (!name.trim()) return;
    setSaving(true);
    await api.createTask({ name: name.trim(), defaultBillable: billable, isCommon: common });
    setSaving(false);
    qc.invalidateQueries({ queryKey: ["bootstrap"] });
    toast.push({ tone: "success", title: `Task "${name.trim()}" created.` });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="New task"
        description="Tasks are shared by every project."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button variant="primary" disabled={!name.trim()} loading={saving} onClick={create}>Create task</Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="Task name" required>
            <Input
              autoFocus value={name} onChange={(e) => setName(e.target.value)}
              placeholder="Design" onKeyDown={(e) => { if (e.key === "Enter") create(); }}
            />
          </Field>
          <label className="flex cursor-pointer items-start gap-2.5">
            <Checkbox checked={billable} onCheckedChange={setBillable} className="mt-0.5" />
            <span>
              <span className="block text-base text-ink">Billable by default</span>
              <span className="block text-sm text-ink-tertiary">New time on this task is billable unless the project says otherwise.</span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2.5">
            <Checkbox checked={common} onCheckedChange={setCommon} className="mt-0.5" />
            <span>
              <span className="block text-base text-ink">Add to new projects</span>
              <span className="block text-sm text-ink-tertiary">Every project created from now on starts with this task.</span>
            </span>
          </label>
        </div>
      </DialogContent>
    </Dialog>
  );
}
