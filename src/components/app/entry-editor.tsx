"use client";

/**
 * Time entry editor.
 *
 * One component, three presentations: a modal (from N or the plus menu), an
 * inline row expansion (Day view), and a popover (Calendar view). Same fields,
 * same validation, same shortcuts in all three.
 */

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Play, Trash2 } from "lucide-react";
import * as api from "@/lib/api";
import { createStore } from "@/lib/store";
import type { TimeEntry } from "@/lib/types";
import {
  Button, Checkbox, Dialog, DialogContent, Field, Input, Textarea,
} from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { ProjectPicker, TaskSelect, defaultTaskFor, pushRecent } from "./project-picker";
import { useApp } from "./providers";
import {
  formatClockTime, formatDuration, isoDate, minutesOfDay, parseClockTime, parseDuration,
} from "@/lib/format";

/* ------------------------------------------------------------------ store */

interface EntryDialogState {
  open: boolean;
  entry?: TimeEntry;
  defaults?: { spentOn?: string; projectId?: string; taskId?: string; userId?: string; startMinutes?: number; endMinutes?: number };
}
const store = createStore<EntryDialogState>({ open: false });

export function useEntryDialog() {
  return {
    open: (defaults: EntryDialogState["defaults"], entry?: TimeEntry) => store.set({ open: true, defaults, entry }),
    close: () => store.set({ open: false, entry: undefined, defaults: undefined }),
  };
}

export function EntryDialog() {
  const state = store.useStore();
  const dialog = useEntryDialog();
  if (!state.open) return null;
  return (
    <Dialog open onOpenChange={(v) => !v && dialog.close()}>
      <DialogContent title={state.entry ? "Edit time entry" : "New time entry"} size="sm">
        <EntryForm entry={state.entry} defaults={state.defaults} onDone={dialog.close} />
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------- form */

export function EntryForm({
  entry, defaults, onDone, compact,
}: {
  entry?: TimeEntry;
  defaults?: EntryDialogState["defaults"];
  onDone?: () => void;
  compact?: boolean;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const { projectById, taskById, settings, me } = useApp();
  const startEndMode = settings.timerMode === "start_end";

  const [projectId, setProjectId] = React.useState(entry?.projectId ?? defaults?.projectId);
  const [taskId, setTaskId] = React.useState(entry?.taskId ?? defaults?.taskId);
  const [spentOn, setSpentOn] = React.useState(entry?.spentOn ?? defaults?.spentOn ?? isoDate(new Date()));
  const [notes, setNotes] = React.useState(entry?.notes ?? "");
  const [nonBillable, setNonBillable] = React.useState(entry ? !entry.isBillable : false);

  const initialStart = entry?.startedAt ? minutesOfDay(entry.startedAt) : defaults?.startMinutes;
  const initialEnd = entry?.endedAt ? minutesOfDay(entry.endedAt) : defaults?.endMinutes;
  const [startText, setStartText] = React.useState(initialStart != null ? formatClockTime(initialStart) : "");
  const [endText, setEndText] = React.useState(initialEnd != null ? formatClockTime(initialEnd) : "");
  const [durationText, setDurationText] = React.useState(
    entry?.durationSeconds ? formatDuration(entry.durationSeconds, settings.timeDisplay) : ""
  );
  const [error, setError] = React.useState<string | null>(null);

  const project = projectId ? projectById.get(projectId) : undefined;

  /** Any two of start / end / duration drive the third. */
  const syncFromTimes = (s: string, e: string) => {
    const a = parseClockTime(s), b = parseClockTime(e);
    if (a != null && b != null && b > a) setDurationText(formatDuration((b - a) * 60, settings.timeDisplay));
  };
  const syncFromDuration = (d: string) => {
    const secs = parseDuration(d);
    const a = parseClockTime(startText);
    if (secs != null && a != null) setEndText(formatClockTime(a + Math.round(secs / 60)));
  };

  const onProject = (pid: string) => {
    setProjectId(pid);
    const p = projectById.get(pid);
    const t = p ? defaultTaskFor(pid, p.taskIds, taskById) : undefined;
    setTaskId(t);
  };

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["time"] });
    qc.invalidateQueries({ queryKey: ["running"] });
    qc.invalidateQueries({ queryKey: ["summary"] });
  };

  const save = useMutation({
    mutationFn: async (opts: { start?: boolean }) => {
      if (!projectId || !taskId) throw new Error("Choose a project and a task.");
      const seconds = parseDuration(durationText) ?? 0;
      const startMin = parseClockTime(startText);
      const endMin = parseClockTime(endText);
      const base = {
        projectId, taskId, spentOn, notes: notes.trim() || undefined,
        isBillable: !nonBillable,
        startedAt: startMin != null ? new Date(`${spentOn}T00:00:00`).toISOString().slice(0, 11) + String(Math.floor(startMin / 60)).padStart(2, "0") + ":" + String(startMin % 60).padStart(2, "0") + ":00" : undefined,
        endedAt: endMin != null ? new Date(`${spentOn}T00:00:00`).toISOString().slice(0, 11) + String(Math.floor(endMin / 60)).padStart(2, "0") + ":" + String(endMin % 60).padStart(2, "0") + ":00" : undefined,
      };
      if (entry) return api.updateTimeEntry(entry.id, { ...base, durationSeconds: seconds });
      return api.createTimeEntry({ ...base, userId: defaults?.userId, durationSeconds: seconds, start: opts.start });
    },
    onSuccess: () => {
      if (projectId && taskId) pushRecent(projectId, taskId);
      invalidate();
      toast.push({ tone: "success", title: entry ? "Entry updated." : "Entry saved." });
      onDone?.();
    },
    onError: (e: Error) => setError(e.message),
  });

  const remove = useMutation({
    mutationFn: () => api.deleteTimeEntry(entry!.id),
    onSuccess: (removed) => {
      invalidate();
      toast.push({
        title: "Entry deleted.",
        undo: async () => { if (removed) { await api.restoreTimeEntry(removed); invalidate(); } },
      });
      onDone?.();
    },
  });

  const hasDuration = !!parseDuration(durationText);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); save.mutate({ start: false }); }
  };

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); save.mutate({ start: false }); }}
      onKeyDown={onKeyDown}
      className="flex flex-col gap-3"
    >
      {!compact && (
        <Field label="Date">
          <Input type="date" value={spentOn} onChange={(e) => setSpentOn(e.target.value)} />
        </Field>
      )}

      <Field label="Project">
        <ProjectPicker projectId={projectId} onChange={onProject} />
      </Field>

      <Field label="Task">
        <TaskSelect projectId={projectId} taskId={taskId} onChange={setTaskId} />
      </Field>

      <Field label="Notes">
        <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" className="min-h-[60px]" />
      </Field>

      <Field label="Time" error={error}>
        <div className="flex items-center gap-2">
          {startEndMode && (
            <>
              <Input className="w-[92px]" placeholder="Start" value={startText}
                onChange={(e) => setStartText(e.target.value)}
                onBlur={(e) => { const m = parseClockTime(e.target.value); if (m != null) setStartText(formatClockTime(m)); syncFromTimes(e.target.value, endText); }} />
              <span className="text-ink-tertiary">to</span>
              <Input className="w-[92px]" placeholder="End" value={endText}
                onChange={(e) => setEndText(e.target.value)}
                onBlur={(e) => { const m = parseClockTime(e.target.value); if (m != null) setEndText(formatClockTime(m)); syncFromTimes(startText, e.target.value); }} />
              <span className="text-ink-tertiary">=</span>
            </>
          )}
          <Input className="w-[92px]" align="right" placeholder="0:00" value={durationText}
            onChange={(e) => setDurationText(e.target.value)}
            onBlur={(e) => {
              const s = parseDuration(e.target.value);
              if (s != null) setDurationText(formatDuration(s, settings.timeDisplay));
              if (startEndMode) syncFromDuration(e.target.value);
            }} />
        </div>
      </Field>

      {project?.billingType !== "non_billable" && (
        <label className="flex items-center gap-2 text-base">
          <Checkbox checked={nonBillable} onCheckedChange={setNonBillable} aria-label="Non-billable" />
          Non-billable
        </label>
      )}

      <div className="mt-1 flex items-center gap-2">
        {!entry && (
          <Button type="button" variant={hasDuration ? "secondary" : "primary"}
            disabled={!projectId || !taskId} loading={save.isPending}
            onClick={() => save.mutate({ start: true })}>
            <Play className="size-3.5 fill-current" />Start timer
          </Button>
        )}
        <Button type="submit" variant={hasDuration || entry ? "primary" : "secondary"}
          disabled={!projectId || !taskId} loading={save.isPending}>
          Save
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>Cancel</Button>
        {entry && (
          <Button type="button" variant="danger-ghost" size="icon" className="ml-auto"
            aria-label="Delete entry" loading={remove.isPending} onClick={() => remove.mutate()}>
            <Trash2 className="size-4" />
          </Button>
        )}
      </div>
    </form>
  );
}
