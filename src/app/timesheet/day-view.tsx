"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Copy, Lock, MoreHorizontal, Play, Square } from "lucide-react";
import * as api from "@/lib/api";
import { cn } from "@/lib/cn";
import { entryRowVariants } from "@/components/ui/recipes";
import { Button, Card, EmptyState, Menu, MenuItem, MenuSeparator, Skeleton, Badge } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { useApp } from "@/components/app/providers";
import { useTimer } from "@/components/app/timer";
import { EntryForm } from "@/components/app/entry-editor";
import { useEntryDialog } from "@/components/app/entry-editor";
import type { TimeEntry } from "@/lib/types";
import { formatClock, formatClockTime, formatDuration, minutesOfDay, addDays, isoDate, toDate, formatDayLong } from "@/lib/format";
import { liveSeconds } from "@/lib/derive";

const QUOTES = [
  ["It is the time you have wasted for your rose that makes your rose so important.", "Antoine de Saint-Exupéry"],
  ["At some time in our lives we all experience a moment when you become the person you are.", "Toni Morrison"],
  ["How we spend our days is, of course, how we spend our lives.", "Annie Dillard"],
  ["Time is the coin of your life. You spend it. Do not allow others to spend it for you.", "Carl Sandburg"],
];

export function DayView({ date, userId, entries, loading }: {
  date: string; userId: string; entries: TimeEntry[]; loading: boolean;
}) {
  const { settings } = useApp();
  const dayEntries = React.useMemo(
    () => entries.filter((e) => e.spentOn === date).sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? "")),
    [entries, date]
  );
  const entry = useEntryDialog();
  const qc = useQueryClient();
  const toast = useToast();
  const [expanded, setExpanded] = React.useState<string | null>(null);

  const copy = useMutation({
    mutationFn: async (withDurations: boolean) => {
      // Most recent day with entries, looking back up to two weeks.
      let from: string | null = null;
      for (let i = 1; i <= 14; i++) {
        const d = isoDate(addDays(toDate(date), -i));
        const rows = await api.listTimeEntries({ userId, from: d, to: d });
        if (rows.length) { from = d; break; }
      }
      if (!from) throw new Error("No previous day with entries to copy.");
      return api.copyDay(from, date, userId, withDurations);
    },
    onSuccess: (made) => {
      qc.invalidateQueries({ queryKey: ["time"] });
      toast.push({ tone: "success", title: `Copied ${made.length} ${made.length === 1 ? "entry" : "entries"}.` });
    },
    onError: (e: Error) => toast.push({ tone: "danger", title: e.message }),
  });

  const total = dayEntries.reduce((a, e) => a + e.durationSeconds, 0);
  const quote = QUOTES[toDate(date).getDate() % QUOTES.length]!;

  if (loading) {
    return <Card padded={false} className="divide-y divide-border">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 p-3">
          <Skeleton className="h-9 w-[76px]" />
          <div className="flex-1 space-y-1.5"><Skeleton className="h-3 w-1/2" /><Skeleton className="h-3 w-1/3" /></div>
          <Skeleton className="h-4 w-14" />
        </div>
      ))}
    </Card>;
  }

  if (!dayEntries.length) {
    return (
      <div className="flex flex-col gap-4">
        <div className="rounded-lg bg-bg-muted px-6 py-16 text-center text-base leading-relaxed text-ink-secondary">
          &ldquo;{quote[0]}&rdquo;<br />&ndash; {quote[1]}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" loading={copy.isPending} onClick={() => copy.mutate(false)}>
            <Copy className="size-3.5" />Copy from the most recent day (projects only)
          </Button>
          <Menu trigger={<Button variant="secondary" size="icon" aria-label="Copy options"><ChevronDown className="size-4" /></Button>}>
            <MenuItem onSelect={() => copy.mutate(true)}>Copy with durations</MenuItem>
          </Menu>
          <Button variant="primary" onClick={() => entry.open({ spentOn: date, userId })}>Add your first entry</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Card padded={false}>
        {dayEntries.map((e) => (
          <EntryRow key={e.id} entry={e} expanded={expanded === e.id}
            onToggle={() => setExpanded((x) => (x === e.id ? null : e.id))} />
        ))}
        <div className="flex items-center justify-end gap-6 px-4 py-3">
          <span className="text-base text-ink-secondary">Total</span>
          <span className="text-lg font-semibold tabular-nums text-ink">{formatDuration(total, settings.timeDisplay)}</span>
        </div>
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" loading={copy.isPending} onClick={() => copy.mutate(false)}>
          <Copy className="size-3.5" />Copy from the most recent day (projects only)
        </Button>
        <Menu trigger={<Button variant="secondary" size="icon" aria-label="Copy options"><ChevronDown className="size-4" /></Button>}>
          <MenuItem onSelect={() => copy.mutate(true)}>Copy with durations</MenuItem>
        </Menu>
      </div>
    </div>
  );
}

function EntryRow({ entry, expanded, onToggle }: { entry: TimeEntry; expanded: boolean; onToggle: () => void }) {
  const { projectById, taskById, clientById, settings } = useApp();
  const { running, elapsed, stop, restart } = useTimer();
  const qc = useQueryClient();
  const toast = useToast();

  const project = projectById.get(entry.projectId);
  const task = taskById.get(entry.taskId);
  const client = project ? clientById.get(project.clientId) : undefined;
  const isRunning = !!entry.timerStartedAt;
  const locked = !!entry.invoiceId || !!entry.billedExternally;
  const duration = isRunning ? elapsed : entry.durationSeconds;

  const remove = useMutation({
    mutationFn: () => api.deleteTimeEntry(entry.id),
    onSuccess: (removed) => {
      qc.invalidateQueries({ queryKey: ["time"] });
      toast.push({
        title: "Entry deleted.",
        undo: async () => { if (removed) { await api.restoreTimeEntry(removed); qc.invalidateQueries({ queryKey: ["time"] }); } },
      });
    },
  });

  const duplicate = useMutation({
    mutationFn: (toDay: string) => api.createTimeEntry({
      userId: entry.userId, projectId: entry.projectId, taskId: entry.taskId,
      spentOn: toDay, durationSeconds: entry.durationSeconds, notes: entry.notes,
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["time"] }); toast.push({ tone: "success", title: "Entry duplicated." }); },
  });

  return (
    <div className={cn("border-b border-border last:border-b-0")}>
      <div className={entryRowVariants({ state: isRunning ? "running" : locked ? "locked" : "default" })}>
        <div className="w-[76px] shrink-0 font-mono text-sm text-ink-secondary">
          {entry.startedAt ? (
            <>
              <div>{formatClockTime(minutesOfDay(entry.startedAt))}</div>
              <div>{isRunning ? <span className="text-live">running</span> : entry.endedAt ? formatClockTime(minutesOfDay(entry.endedAt)) : "—"}</div>
            </>
          ) : <div className="text-ink-tertiary">—</div>}
        </div>

        <button className="min-w-0 flex-1 text-left" onClick={onToggle} aria-expanded={expanded}>
          {/*
            The client was --text-tertiary, which tokens.css calls the floor:
            "nothing smaller or lighter than this is allowed to carry meaning".
            At text-sm it was under that floor in practice and Jason could not
            read it at a glance (TALLY-47). One step up, still clearly secondary
            to the project name beside it.
          */}
          <div className="truncate">
            <span className="text-sm text-ink-secondary">{client?.name}</span>{" "}
            <span className="font-medium text-ink">{project?.name}</span>
          </div>
          <div className="truncate text-ink-secondary">
            {task?.name}
            {entry.notes && <><span className="mx-1.5 text-ink-tertiary">·</span>{entry.notes}</>}
            {!entry.isBillable && <Badge variant="outline" className="ml-2">Non-billable</Badge>}
          </div>
        </button>

        {locked && <Lock className="size-3 shrink-0 text-ink-tertiary" aria-label="Locked: on a sent invoice" />}

        <div className={cn("shrink-0 text-lg font-semibold tabular-nums", isRunning && "font-mono")}>
          {isRunning ? formatClock(duration) : formatDuration(duration, settings.timeDisplay)}
        </div>

        {isRunning ? (
          <Button variant="danger" size="icon-sm" aria-label="Stop timer" onClick={() => stop()}>
            <Square className="size-3 fill-current" />
          </Button>
        ) : (
          <Button variant="secondary" size="icon-sm" aria-label="Start a timer from this entry" onClick={() => restart(entry.id)}>
            <Play className="size-3 fill-current" />
          </Button>
        )}

        <Menu trigger={<Button variant="ghost" size="icon-sm" aria-label="Entry actions"><MoreHorizontal className="size-4" /></Button>}>
          <MenuItem onSelect={onToggle}>{expanded ? "Close editor" : "Edit"}</MenuItem>
          <MenuItem onSelect={() => duplicate.mutate(entry.spentOn)}>Duplicate</MenuItem>
          <MenuItem onSelect={() => duplicate.mutate(isoDate(addDays(toDate(entry.spentOn), 1)))}>
            Duplicate to {formatDayLong(addDays(toDate(entry.spentOn), 1))}
          </MenuItem>
          <MenuSeparator />
          <MenuItem danger disabled={locked} onSelect={() => remove.mutate()}>Delete</MenuItem>
        </Menu>
      </div>

      {expanded && (
        <div className="border-t border-border bg-bg-subtle px-4 py-4">
          <EntryForm entry={entry} onDone={onToggle} compact />
        </div>
      )}
    </div>
  );
}
