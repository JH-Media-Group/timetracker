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
  crossesMidnight, elapsedMinutes, formatClockTime, formatDuration, implausibleSpanWarning,
  instantAt, isoDate, minutesOfDay, nextIsoDay, parseDuration, resolveClockTime,
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
  const { projectById, taskById, settings, me, userById } = useApp();
  /*
    The zone the entry belongs to, which is the owner's, not the editor's.
    Whoever is typing may not be the person the time is for: a manager
    entering time on somebody's behalf must not silently record it against
    their own clock.
  */
  const zone = userById.get(entry?.userId ?? defaults?.userId ?? me?.id ?? "")?.timezone ?? settings.timezone;
  const startEndMode = settings.timerMode === "start_end";

  const [projectId, setProjectId] = React.useState(entry?.projectId ?? defaults?.projectId);
  const [taskId, setTaskId] = React.useState(entry?.taskId ?? defaults?.taskId);
  const [spentOn, setSpentOn] = React.useState(entry?.spentOn ?? defaults?.spentOn ?? isoDate(new Date()));
  const [notes, setNotes] = React.useState(entry?.notes ?? "");
  const [nonBillable, setNonBillable] = React.useState(entry ? !entry.isBillable : false);

  const initialStart = entry?.startedAt ? minutesOfDay(entry.startedAt, zone) : defaults?.startMinutes;
  const initialEnd = entry?.endedAt ? minutesOfDay(entry.endedAt, zone) : defaults?.endMinutes;
  const [startText, setStartText] = React.useState(initialStart != null ? formatClockTime(initialStart) : "");
  const [endText, setEndText] = React.useState(initialEnd != null ? formatClockTime(initialEnd) : "");
  const [durationText, setDurationText] = React.useState(
    entry?.durationSeconds ? formatDuration(entry.durationSeconds, settings.timeDisplay) : ""
  );
  const [error, setError] = React.useState<string | null>(null);

  const project = projectId ? projectById.get(projectId) : undefined;

  /*
    Any two of start / end / duration drive the third.

    Both times resolve against each other rather than in isolation, so a bare
    hour lands on the reading that makes sense for the entry: from 8pm, "12" is
    midnight. That is also what makes an overnight shift work at all. See
    `resolveClockTime`.

    The duration used to be filled only when the end was strictly after the
    start on the clock, which meant that entering 8pm to 12am left it at zero
    and reported nothing wrong.
  */
  const readTimes = (s: string, e: string) => {
    const a = resolveClockTime(s, { before: resolveClockTime(e) });
    const b = resolveClockTime(e, { after: a });
    return { start: a, end: b };
  };

  const syncFromTimes = (s: string, e: string) => {
    const { start, end } = readTimes(s, e);
    if (start == null || end == null) return;
    setDurationText(formatDuration(elapsedMinutes(start, end) * 60, settings.timeDisplay));
  };

  const syncFromDuration = (d: string) => {
    const secs = parseDuration(d);
    const a = resolveClockTime(startText);
    // Modulo, because a duration added to a start time can run past midnight,
    // and `formatClockTime` would otherwise be handed minutes past 1440.
    if (secs != null && a != null) setEndText(formatClockTime((a + Math.round(secs / 60)) % (24 * 60)));
  };

  /*
    A span long enough to be worth a second look, shown but never blocking.

    Computed on every render rather than memoised: it is two string parses on
    fields nobody types into quickly, and a memo would need `readTimes` in its
    dependency list, which changes identity on every render anyway.
  */
  const spanWarning = (() => {
    if (!startEndMode) return null;
    const { start, end } = readTimes(startText, endText);
    return start != null && end != null ? implausibleSpanWarning(start, end) : null;
  })();

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
      const { start: startMin, end: endMin } = readTimes(startText, endText);
      const base = {
        projectId, taskId, spentOn, notes: notes.trim() || undefined,
        isBillable: !nonBillable,
        /*
          A real instant, built in the owner's zone.

          What was here concatenated the date part of the reader's midnight
          expressed in UTC with the typed clock, and produced a string carrying
          no zone designator. z.string().datetime() rejects that, so saving any
          entry with a start time returned 422, verified against a production
          build. It also took the previous day anywhere east of UTC.
        */
        startedAt: startMin != null ? instantAt(spentOn, startMin, zone) : undefined,
        /*
          An end before its start belongs to the next day.

          Without this, 8pm to 12am built both instants on `spentOn`, the end
          landed twenty hours before the start, and the database refused it with
          `time_entries_clock_ordered` shown raw to whoever was typing. Late
          finishes are ordinary here, so the fix is to record the day the clock
          says, not to refuse the entry.
        */
        endedAt: endMin != null
          ? instantAt(
              startMin != null && crossesMidnight(startMin, endMin) ? nextIsoDay(spentOn) : spentOn,
              endMin,
              zone
            )
          : undefined,
      };
      if (entry) {
        /*
          Send the duration only when it changed.

          One imported entry runs to 26.46 hours, which Harvest recorded and the
          import preserved faithfully. `timeEntryPatchSchema` caps
          durationSeconds at 24 hours, so sending it unchanged on every save
          made that entry uneditable: correcting so much as a note came back
          422 for a field nobody had touched.

          Omitting an unchanged field is what PATCH means anyway. The cap still
          applies to anybody actually typing a duration, which is what it is for.
        */
        const durationChanged = seconds !== entry.durationSeconds;
        return api.updateTimeEntry(entry.id, {
          ...base,
          ...(durationChanged ? { durationSeconds: seconds } : {}),
        });
      }
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
                onBlur={(e) => {
                  const m = resolveClockTime(e.target.value, { before: resolveClockTime(endText) });
                  if (m != null) setStartText(formatClockTime(m));
                  syncFromTimes(e.target.value, endText);
                }} />
              <span className="text-ink-tertiary">to</span>
              <Input className="w-[92px]" placeholder="End" value={endText}
                onChange={(e) => setEndText(e.target.value)}
                onBlur={(e) => {
                  const m = resolveClockTime(e.target.value, { after: resolveClockTime(startText) });
                  if (m != null) setEndText(formatClockTime(m));
                  syncFromTimes(startText, e.target.value);
                }} />
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
        {spanWarning && !error && (
          <div className="mt-1.5 text-sm text-warning" role="status">{spanWarning}</div>
        )}
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
