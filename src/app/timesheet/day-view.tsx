"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Clock, Copy, Lock, MoreHorizontal, Play, Square } from "lucide-react";
import * as api from "@/lib/api";
import { cn } from "@/lib/cn";
import { entryRowVariants } from "@/components/ui/recipes";
import { Button, Card, EmptyState, Menu, MenuItem, MenuSeparator, Skeleton, Badge, Tooltip } from "@/components/ui/primitives";
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

  /**
   * What "the most recent day" actually is, found before the button is pressed.
   *
   * One request for the fortnight, not fourteen. The old code walked back a day
   * at a time asking the server about each one, up to fourteen sequential round
   * trips on every click, and it could not say anything about the source day
   * beforehand because it only looked once you had committed.
   *
   * Fetching it up front is what makes the tooltip possible (TALLY-44): the
   * button can name the day and the number of entries, so the decision happens
   * before the action rather than after it.
   */
  const { data: lookback = [] } = useQuery({
    queryKey: ["time", "copy-source", userId, date],
    queryFn: () =>
      api.listTimeEntries({
        userId,
        from: isoDate(addDays(toDate(date), -14)),
        to: isoDate(addDays(toDate(date), -1)),
      }),
  });

  const source = React.useMemo(() => {
    const days = lookback.map((e) => e.spentOn).sort();
    const day = days.at(-1);
    if (!day) return null;
    return { day, count: lookback.filter((e) => e.spentOn === day).length };
  }, [lookback]);

  const copy = useMutation({
    mutationFn: async (withDurations: boolean) => {
      if (!source) throw new Error("No previous day with entries to copy.");
      return api.copyDay(source.day, date, userId, withDurations);
    },
    onSuccess: (made) => {
      qc.invalidateQueries({ queryKey: ["time"] });
      toast.push({
        tone: "success",
        title: `Copied ${made.length} ${made.length === 1 ? "entry" : "entries"} from ${formatDayLong(toDate(source!.day))}.`,
        /**
         * Undo removes exactly what was just created, by id.
         *
         * Copied entries arrive with no duration, so there is normally nothing
         * to lose. If one has already been typed into, the delete still applies:
         * the toast is short and this is the price of an undo that is simple
         * enough to be trusted. Anything cleverer would have to guess which
         * edits were deliberate.
         */
        undo: async () => {
          await Promise.all(made.map((e) => api.deleteTimeEntry(e.id)));
          qc.invalidateQueries({ queryKey: ["time"] });
        },
      });
    },
    onError: (e: Error) => toast.push({ tone: "danger", title: e.message }),
  });

  /** What the button will do, in words, before it is pressed. */
  const copyLabel = source
    ? `Copy ${source.count} ${source.count === 1 ? "entry" : "entries"} from ${formatDayLong(toDate(source.day))}. Durations are left blank.`
    : "Nothing to copy: no time tracked in the previous fortnight.";

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
          <Tooltip content={copyLabel}>
            <Button variant="secondary" loading={copy.isPending} disabled={!source} onClick={() => copy.mutate(false)}>
              <Copy className="size-3.5" />Copy from the most recent day (projects only)
            </Button>
          </Tooltip>
          <Menu trigger={<Button variant="secondary" size="icon" aria-label="Copy options" disabled={!source}><ChevronDown className="size-4" /></Button>}>
            <MenuItem onSelect={() => copy.mutate(true)}>Copy with durations</MenuItem>
          </Menu>
          <Button className="ml-auto" variant="primary" onClick={() => entry.open({ spentOn: date, userId })}>Add your first entry</Button>
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
        <Tooltip content={copyLabel}>
          <Button variant="secondary" loading={copy.isPending} disabled={!source} onClick={() => copy.mutate(false)}>
            <Copy className="size-3.5" />Copy from the most recent day (projects only)
          </Button>
        </Tooltip>
        <Menu trigger={<Button variant="secondary" size="icon" aria-label="Copy options" disabled={!source}><ChevronDown className="size-4" /></Button>}>
          <MenuItem onSelect={() => copy.mutate(true)}>Copy with durations</MenuItem>
        </Menu>
      </div>
    </div>
  );
}

function EntryRow({ entry, expanded, onToggle }: { entry: TimeEntry; expanded: boolean; onToggle: () => void }) {
  const { projectById, taskById, clientById, settings, userById } = useApp();
  // The zone the work was done in, not the reader's. See minutesOfDay.
  const zone = userById.get(entry.userId)?.timezone ?? settings.timezone;
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
        <div className="w-[96px] shrink-0 text-md text-ink-secondary">
          <div className="flex items-center gap-1.5 font-medium text-ink">
            <Play className="size-3 fill-current text-success" aria-hidden />
            <span>{entry.startedAt ? formatClockTime(minutesOfDay(entry.startedAt, zone)) : "-"}</span>
          </div>
          <div className={cn("flex items-center gap-1.5 text-base", isRunning && "font-medium text-live")}>
            <Square className={cn("size-3", isRunning ? "fill-current text-live" : "text-ink-tertiary")} aria-hidden />
            <span>
              {isRunning
                ? "running"
                : entry.endedAt ? formatClockTime(minutesOfDay(entry.endedAt, zone)) : "-"}
            </span>
          </div>
        </div>

        <button className="min-w-0 flex-1 text-left" onClick={onToggle} aria-expanded={expanded}>
          {/*
            Project first, client after it in parentheses, matching Harvest.
            The old order led with the client at --text-tertiary, the token file's
            own floor, so the first thing on the row was the hardest thing to
            read. Leading with the project puts the emphasis where the eye
            already goes and the contrast problem stops being one.

            One step larger throughout, which is the rest of what makes Harvest's
            version of this page easier to read: --fs-lg for the project,
            --fs-md for everything beside it.
          */}
          <div className="truncate text-lg leading-snug">
            <span className="font-semibold text-ink">{project?.name}</span>
            {client?.name && <span className="ml-1.5 font-normal text-ink-secondary">({client.name})</span>}
          </div>
          <div className="truncate text-md text-ink-secondary">
            {task?.name}
            {entry.notes && <><span className="mx-1.5 text-ink-tertiary">·</span>{entry.notes}</>}
            {!entry.isBillable && <Badge variant="outline" className="ml-2">Non-billable</Badge>}
          </div>
        </button>

        {locked && <Lock className="size-3 shrink-0 text-ink-tertiary" aria-label="Locked: on a sent invoice" />}

        <div className={cn("shrink-0 text-xl font-semibold tabular-nums", isRunning && "font-mono")}>
          {isRunning ? formatClock(duration) : formatDuration(duration, settings.timeDisplay)}
        </div>

        {/*
          Stop says "Stop", and its clock pulses.

          An icon alone made the most consequential control on the page the
          smallest and least labelled thing on it. Harvest gives it a word and a
          moving icon, which is right: the row is already tinted and the timer is
          already counting, so the button is the one element that should say what
          pressing it does. `animate-pulse-live` is the same animation the topbar
          dot uses, so the two live signals move together.
        */}
        {isRunning ? (
          <Button variant="danger" size="sm" onClick={() => stop()}>
            <Clock className="size-3.5 animate-pulse-live" aria-hidden />
            Stop
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
