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
  elapsedMinutes, formatClockTime, formatDuration, implausibleSpanWarning,
  minutesOfDay, parseDuration, resolveClockTime,
} from "@/lib/format";
import { dayIn } from "@/domain/calendar";
import { timeEntryClockValues } from "@/lib/time-entry-clock";

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
  const [spentOn, setSpentOn] = React.useState(entry?.spentOn ?? defaults?.spentOn ?? dayIn(zone));
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
    /*
      The start settles itself, then the end settles against it. Not the other
      way around, and not both against each other.

      Resolving the start against the end first looked symmetrical and was
      wrong twice over. It made the answer depend on which field you left last,
      so "1" to "7" was 1am to 7am leaving the start field and 1pm to 7pm
      leaving the end field. And it inverted the office-day rule it was supposed
      to respect: the end "7" resolved with no context to 7am, which then
      dragged the start to 1am, so somebody typing an ordinary afternoon got the
      small hours. Both reviewers found this from different directions.

      One direction only, so there is one answer. The start uses the office-day
      rule, which is what a lone time means. The end then takes whichever
      reading falls soonest after it, which is what makes an overnight shift
      work: from 8pm, "12" is midnight.
    */
    const a = resolveClockTime(s);
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
    // No modulo here: `formatClockTime` already floors and takes `% 24` itself,
    // so minutes past 1440 wrap correctly. A reviewer pointed out that the
    // modulo this line used to carry changed nothing, under a comment saying it
    // prevented a bug that could not happen.
    if (secs != null && a != null) setEndText(formatClockTime(a + Math.round(secs / 60)));
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
      const { start: startMin, end: endMin } = readTimes(startText, endText);
      const base = {
        projectId, taskId, spentOn, notes: notes.trim() || undefined,
        isBillable: !nonBillable,
      };
      const clock = timeEntryClockValues({
        existing: entry,
        initialStartMinutes: initialStart,
        initialEndMinutes: initialEnd,
        spentOn,
        startMinutes: startMin,
        endMinutes: endMin,
        durationSeconds: parseDuration(durationText) ?? 0,
        timezone: zone,
      });

      if (entry) {
        /*
          Send only clock fields the person actually changed.

          One imported entry runs to 26.46 hours, which Harvest recorded and the
          import preserved faithfully. `timeEntryPatchSchema` caps
          durationSeconds at 24 hours, so sending it unchanged on every save
          made that entry uneditable: correcting so much as a note came back
          422 for a field nobody had touched.

          More importantly, a running timer's timestamps are live state. Rewriting
          an unchanged start from a stale calendar day inflated a 38 minute timer
          to 24.64 hours. The helper omits those timestamps unless the date or a
          clock field changed. Omitting an unchanged field is what PATCH means.
        */
        return api.updateTimeEntry(entry.id, {
          ...base,
          ...clock,
        });
      }
      return api.createTimeEntry({
        ...base,
        ...clock,
        userId: defaults?.userId,
        durationSeconds: clock.durationSeconds ?? 0,
        start: opts.start,
      });
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
                onChange={(e) => {
                  setStartText(e.target.value);
                  // As you type, not when you leave. The total only appeared on
                  // blur, so somebody who filled both times and looked at the
                  // row saw it empty and assumed the app had not done the
                  // arithmetic (t-QANtWe). `syncFromTimes` ignores anything it
                  // cannot parse, so a half-typed time leaves the last good
                  // answer alone.
                  syncFromTimes(e.target.value, endText);
                }}
                onBlur={(e) => {
                  // Same direction as `readTimes`: the start settles itself.
                  const { start } = readTimes(e.target.value, endText);
                  if (start != null) setStartText(formatClockTime(start));
                  syncFromTimes(e.target.value, endText);
                }} />
              <span className="text-ink-tertiary">to</span>
              <Input className="w-[92px]" placeholder="End" value={endText}
                onChange={(e) => {
                  setEndText(e.target.value);
                  syncFromTimes(startText, e.target.value);
                }}
                onBlur={(e) => {
                  const { end } = readTimes(startText, e.target.value);
                  if (end != null) setEndText(formatClockTime(end));
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

      {/*
        Save is the primary action, always.

        These two used to swap prominence on whether the duration field parsed:
        with no duration, "Start timer" was the dark button and Save was not.
        Combined with a total that only filled in on blur, somebody who typed a
        start and an end saw an empty total, pressed the button that looked like
        the one to press, and started a timer instead of saving their entry.
        Then they typed the total by hand, the buttons quietly changed places,
        and the same gesture saved. That is the whole of "sometimes it works"
        (t-QANtWe).

        A dialog's primary action is a fact about the dialog, not about how far
        through the form somebody has got.
      */}
      <div className="mt-1 flex items-center gap-2">
        {!entry && (
          <Button type="button" variant="secondary"
            disabled={!projectId || !taskId} loading={save.isPending}
            onClick={() => save.mutate({ start: true })}>
            <Play className="size-3.5 fill-current" />Start timer
          </Button>
        )}
        <Button type="submit" variant="primary"
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
