"use client";

/**
 * Week grid.
 *
 * Fully editable in BOTH timer modes. Harvest disables its week view entirely
 * when the account tracks start and end times; we infer times instead, appending
 * to that day's last entry, and mark the inferred cell with a corner dot. That
 * removes the single most confusing limitation of the tool this replaces.
 */

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import * as api from "@/lib/api";
import { cn } from "@/lib/cn";
import { Button, Card, Skeleton } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { useApp } from "@/components/app/providers";
import { ProjectPicker, TaskSelect, defaultTaskFor } from "@/components/app/project-picker";
import type { TimeEntry } from "@/lib/types";
import { addDays, formatDuration, isoDate, parseDuration } from "@/lib/format";

interface Row { key: string; projectId: string; taskId: string; notes?: string; cells: Record<string, TimeEntry[]> }

export function WeekView({ weekStart, userId, entries, loading }: {
  weekStart: Date; userId: string; entries: TimeEntry[]; loading: boolean;
}) {
  const { projectById, taskById, clientById, settings } = useApp();
  const qc = useQueryClient();
  const toast = useToast();
  const [adding, setAdding] = React.useState(false);
  const [draft, setDraft] = React.useState<{ projectId?: string; taskId?: string }>({});

  const days = React.useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);

  const rows = React.useMemo<Row[]>(() => {
    const map = new Map<string, Row>();
    for (const e of entries) {
      const key = `${e.projectId}|${e.taskId}|${e.notes ?? ""}`;
      let row = map.get(key);
      if (!row) { row = { key, projectId: e.projectId, taskId: e.taskId, notes: e.notes, cells: {} }; map.set(key, row); }
      (row.cells[e.spentOn] ??= []).push(e);
    }
    return [...map.values()];
  }, [entries]);

  const save = useMutation({
    mutationFn: (args: { projectId: string; taskId: string; notes?: string; spentOn: string; seconds: number }) =>
      api.saveWeekCell({ userId, ...args }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["time"] }),
  });

  const removeRow = useMutation({
    mutationFn: async (row: Row) => {
      const all = Object.values(row.cells).flat();
      const removed: { id: string }[] = [];
      for (const e of all) { removed.push(await api.deleteTimeEntry(e.id)); }
      return removed;
    },
    onSuccess: (removed) => {
      qc.invalidateQueries({ queryKey: ["time"] });
      toast.push({
        title: `Removed ${removed.length} ${removed.length === 1 ? "entry" : "entries"}.`,
        undo: async () => { for (const e of removed) await api.restoreTimeEntry(e); qc.invalidateQueries({ queryKey: ["time"] }); },
      });
    },
  });

  const dayTotal = (d: string) => rows.reduce((a, r) => a + (r.cells[d]?.reduce((x, e) => x + e.durationSeconds, 0) ?? 0), 0);
  const rowTotal = (r: Row) => Object.values(r.cells).flat().reduce((a, e) => a + e.durationSeconds, 0);
  const grand = rows.reduce((a, r) => a + rowTotal(r), 0);

  if (loading) return <Card padded={false}><div className="space-y-2 p-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div></Card>;

  return (
    <Card padded={false} className="overflow-x-auto">
      <table className="w-full border-collapse text-base">
        <thead>
          <tr className="border-b border-border bg-bg-muted">
            <th className="sticky left-0 z-10 min-w-[260px] bg-bg-muted px-3 py-2 text-left text-xs font-semibold uppercase tracking-[0.04em] text-ink-tertiary">Project / Task</th>
            {days.map((d) => (
              <th key={isoDate(d)} className="w-[90px] px-2 py-2 text-right text-xs font-semibold uppercase tracking-[0.04em] text-ink-tertiary">
                <div>{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][(d.getDay() + 6) % 7]}</div>
                <div className="font-normal normal-case text-ink-tertiary">{d.getDate()}</div>
              </th>
            ))}
            <th className="w-[90px] px-3 py-2 text-right text-xs font-semibold uppercase tracking-[0.04em] text-ink-tertiary">Total</th>
            <th className="w-10" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const project = projectById.get(row.projectId);
            const task = taskById.get(row.taskId);
            const client = project ? clientById.get(project.clientId) : undefined;
            return (
              <tr key={row.key} className="border-b border-border hover:bg-surface-hover">
                <td className="sticky left-0 z-10 bg-surface px-3 py-2">
                  <div className="truncate text-sm text-ink-secondary">{client?.name}</div>
                  <div className="truncate font-medium text-ink">{project?.name}</div>
                  <div className="truncate text-ink-secondary">{task?.name}{row.notes ? ` · ${row.notes}` : ""}</div>
                </td>
                {days.map((d) => {
                  const key = isoDate(d);
                  const cell = row.cells[key] ?? [];
                  const seconds = cell.reduce((a, e) => a + e.durationSeconds, 0);
                  const isRunning = cell.some((e) => e.timerStartedAt);
                  const inferred = cell.some((e) => !e.startedAt);
                  return (
                    <td key={key} className="px-1 py-1">
                      <WeekCell
                        seconds={seconds} running={isRunning} inferred={inferred}
                        onCommit={(secs) => save.mutate({ projectId: row.projectId, taskId: row.taskId, notes: row.notes, spentOn: key, seconds: secs })}
                      />
                    </td>
                  );
                })}
                <td className="px-3 py-2 text-right font-medium tabular-nums">{formatDuration(rowTotal(row), settings.timeDisplay)}</td>
                <td className="px-1">
                  <Button variant="ghost" size="icon-sm" aria-label="Remove row" onClick={() => removeRow.mutate(row)}>
                    <X className="size-3.5" />
                  </Button>
                </td>
              </tr>
            );
          })}

          <tr className="border-b border-border">
            <td colSpan={10} className="px-3 py-2">
              {adding ? (
                <div className="flex flex-wrap items-end gap-2">
                  <div className="w-[280px]">
                    <ProjectPicker projectId={draft.projectId} onChange={(pid) => {
                      const p = projectById.get(pid);
                      setDraft({ projectId: pid, taskId: p ? defaultTaskFor(pid, p.taskIds, taskById) : undefined });
                    }} />
                  </div>
                  <div className="w-[200px]">
                    <TaskSelect projectId={draft.projectId} taskId={draft.taskId} onChange={(t) => setDraft((d) => ({ ...d, taskId: t }))} />
                  </div>
                  <Button variant="primary" disabled={!draft.projectId || !draft.taskId}
                    onClick={() => {
                      if (!draft.projectId || !draft.taskId) return;
                      save.mutate({ projectId: draft.projectId, taskId: draft.taskId, spentOn: isoDate(days[0]!), seconds: 0 });
                      setAdding(false); setDraft({});
                    }}>Add row</Button>
                  <Button variant="ghost" onClick={() => { setAdding(false); setDraft({}); }}>Cancel</Button>
                </div>
              ) : (
                <button className="flex items-center gap-1.5 text-base text-ink-secondary hover:text-ink" onClick={() => setAdding(true)}>
                  <Plus className="size-4" />Add row
                </button>
              )}
            </td>
          </tr>

          <tr className="font-semibold">
            <td className="sticky left-0 z-10 bg-surface px-3 py-2">Daily total</td>
            {days.map((d) => (
              <td key={isoDate(d)} className="px-2 py-2 text-right tabular-nums">{formatDuration(dayTotal(isoDate(d)), settings.timeDisplay)}</td>
            ))}
            <td className="px-3 py-2 text-right tabular-nums">{formatDuration(grand, settings.timeDisplay)}</td>
            <td />
          </tr>
        </tbody>
      </table>
    </Card>
  );
}

function WeekCell({ seconds, running, inferred, onCommit }: {
  seconds: number; running: boolean; inferred: boolean; onCommit: (seconds: number) => void;
}) {
  const { settings } = useApp();
  const [text, setText] = React.useState("");
  const [editing, setEditing] = React.useState(false);
  const display = seconds ? formatDuration(seconds, settings.timeDisplay) : "";

  return (
    <div className="relative">
      <input
        value={editing ? text : display}
        onFocus={() => { setEditing(true); setText(display); }}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          setEditing(false);
          const parsed = text.trim() === "" ? 0 : parseDuration(text);
          if (parsed != null && parsed !== seconds) onCommit(parsed);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.currentTarget.blur(); }
          if (e.key === "Escape") { setText(display); setEditing(false); e.currentTarget.blur(); }
        }}
        readOnly={running}
        placeholder="—"
        aria-label="Hours"
        className={cn(
          "h-9 w-full rounded-md border border-transparent bg-transparent px-2 text-right tabular-nums text-ink",
          "transition-[border-color,background-color] duration-(--dur-fast)",
          "placeholder:text-ink-tertiary hover:border-border",
          "focus:border-focus focus:bg-surface focus:shadow-[var(--focus-ring)] focus:outline-none",
          running && "bg-live-bg text-live-ink"
        )}
      />
      {inferred && !!seconds && (
        <span className="pointer-events-none absolute left-1 top-1 size-1 rounded-full bg-ink-tertiary"
          title="Start time inferred from the previous entry" aria-hidden />
      )}
    </div>
  );
}
