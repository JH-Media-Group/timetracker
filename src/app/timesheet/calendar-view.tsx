"use client";

/** Calendar view: a time grid week. Drag on empty space to create, click a block to edit. */

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as api from "@/lib/api";
import { cn } from "@/lib/cn";
import { Card, Popover, PopoverAnchor, PopoverContent, Segmented, Skeleton } from "@/components/ui/primitives";
import { useApp } from "@/components/app/providers";
import { EntryForm } from "@/components/app/entry-editor";
import type { TimeEntry } from "@/lib/types";
import { addDays, formatClockTime, formatDuration, isoDate, minutesOfDay } from "@/lib/format";

const HOUR_H = 44;
const START_HOUR = 7;
const END_HOUR = 21;

export function CalendarView({ weekStart, userId, entries, loading }: {
  weekStart: Date; userId: string; entries: TimeEntry[]; loading: boolean;
}) {
  const { projectById, taskById, clientById, settings, userById } = useApp();
  const [span, setSpan] = React.useState<"5" | "7">("5");
  const [editing, setEditing] = React.useState<{ entry?: TimeEntry; defaults?: { spentOn: string; startMinutes: number; endMinutes: number } } | null>(null);
  const [drag, setDrag] = React.useState<{ day: string; from: number; to: number } | null>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  const days = React.useMemo(
    () => Array.from({ length: Number(span) }, (_, i) => addDays(weekStart, i)),
    [weekStart, span]
  );

  // Open scrolled to the working day, not to midnight.
  React.useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = (9 - START_HOUR) * HOUR_H; }, []);

  const byDay = React.useMemo(() => {
    const map = new Map<string, TimeEntry[]>();
    for (const e of entries) {
      if (!e.startedAt) continue;
      const list = map.get(e.spentOn);
      if (list) list.push(e); else map.set(e.spentOn, [e]);
    }
    return map;
  }, [entries]);

  const minuteFromY = (y: number) => Math.round((y / HOUR_H) * 60 / 15) * 15 + START_HOUR * 60;

  if (loading) return <Card padded={false}><div className="space-y-2 p-4">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div></Card>;

  return (
    <>
      <div className="mb-3 flex items-center justify-between">
        <Segmented value={span} onChange={setSpan} aria-label="Days shown"
          options={[{ value: "5", label: "5-day" }, { value: "7", label: "7-day" }]} />
      </div>

      <Card padded={false} className="overflow-hidden">
        <div className="flex border-b border-border">
          <div className="w-14 shrink-0" />
          {days.map((d) => {
            const key = isoDate(d);
            const total = (byDay.get(key) ?? []).reduce((a, e) => a + e.durationSeconds, 0);
            const isToday = key === isoDate(api.TODAY);
            return (
              <div key={key} className={cn("flex-1 border-l border-border px-3 py-2", isToday && "bg-bg-subtle")}>
                <div className={cn("text-base", isToday ? "font-semibold text-ink" : "text-ink-secondary")}>
                  {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][(d.getDay() + 6) % 7]} {d.getDate()}
                </div>
                <div className="tabular-nums text-ink-tertiary">{formatDuration(total, settings.timeDisplay)}</div>
              </div>
            );
          })}
        </div>

        <div ref={scrollRef} className="relative max-h-[560px] overflow-y-auto">
          <div className="flex" style={{ height: (END_HOUR - START_HOUR) * HOUR_H }}>
            <div className="w-14 shrink-0">
              {Array.from({ length: END_HOUR - START_HOUR }).map((_, i) => (
                <div key={i} className="relative" style={{ height: HOUR_H }}>
                  <span className="absolute -top-1.5 right-2 text-xs text-ink-tertiary">
                    {formatClockTime((START_HOUR + i) * 60).replace(":00", "")}
                  </span>
                </div>
              ))}
            </div>

            {days.map((d) => {
              const key = isoDate(d);
              const list = byDay.get(key) ?? [];
              return (
                <div
                  key={key}
                  className="relative flex-1 border-l border-border"
                  onMouseDown={(e) => {
                    if ((e.target as HTMLElement).closest("[data-block]")) return;
                    const rect = e.currentTarget.getBoundingClientRect();
                    const m = minuteFromY(e.clientY - rect.top);
                    setDrag({ day: key, from: m, to: m + 30 });
                  }}
                  onMouseMove={(e) => {
                    if (!drag || drag.day !== key) return;
                    const rect = e.currentTarget.getBoundingClientRect();
                    setDrag({ ...drag, to: Math.max(drag.from + 15, minuteFromY(e.clientY - rect.top)) });
                  }}
                  onMouseUp={() => {
                    if (!drag || drag.day !== key) return;
                    setEditing({ defaults: { spentOn: key, startMinutes: drag.from, endMinutes: drag.to } });
                    setDrag(null);
                  }}
                >
                  {Array.from({ length: END_HOUR - START_HOUR }).map((_, i) => (
                    <div key={i} className="border-b border-border/60" style={{ height: HOUR_H }} />
                  ))}

                  {drag?.day === key && (
                    <div className="pointer-events-none absolute inset-x-1 rounded-md border border-focus bg-info-bg"
                      style={{ top: ((drag.from - START_HOUR * 60) / 60) * HOUR_H, height: ((drag.to - drag.from) / 60) * HOUR_H }} />
                  )}

                  {list.map((e) => {
                    // The zone the work was done in, not the reader's.
                    const zone = userById.get(e.userId)?.timezone ?? settings.timezone;
                    const start = minutesOfDay(e.startedAt!, zone);
                    const end = e.endedAt ? minutesOfDay(e.endedAt, zone) : start + Math.round(e.durationSeconds / 60);
                    const top = ((start - START_HOUR * 60) / 60) * HOUR_H;
                    const h = Math.max(18, ((end - start) / 60) * HOUR_H);
                    const project = projectById.get(e.projectId);
                    const task = taskById.get(e.taskId);
                    const client = project ? clientById.get(project.clientId) : undefined;
                    return (
                      <button
                        key={e.id} data-block
                        onClick={() => setEditing({ entry: e })}
                        className="absolute inset-x-1 overflow-hidden rounded-md px-1.5 py-1 text-left text-xs leading-tight text-white ring-2 ring-surface transition-[filter] hover:brightness-95"
                        style={{ top, height: h, background: `var(--project-${project?.colorIndex ?? 1})` }}
                      >
                        <div className="truncate font-medium">{project?.name}</div>
                        {h > 34 && <div className="truncate opacity-90">{task?.name}</div>}
                        {h > 52 && <div className="truncate opacity-75">{client?.name}</div>}
                      </button>
                    );
                  })}

                  {key === isoDate(api.TODAY) && <NowLine />}
                </div>
              );
            })}
          </div>
        </div>
      </Card>

      {editing && (
        <Popover open onOpenChange={(v) => !v && setEditing(null)}>
          <PopoverAnchor className="fixed left-1/2 top-1/3" />
          <PopoverContent className="w-[380px] p-4" align="center">
            <EntryForm
              entry={editing.entry}
              defaults={editing.defaults ? { ...editing.defaults, userId } : { userId }}
              onDone={() => setEditing(null)}
            />
          </PopoverContent>
        </Popover>
      )}
    </>
  );
}

function NowLine() {
  const [minutes, setMinutes] = React.useState(() => new Date().getHours() * 60 + new Date().getMinutes());
  React.useEffect(() => {
    const id = window.setInterval(() => setMinutes(new Date().getHours() * 60 + new Date().getMinutes()), 60000);
    return () => window.clearInterval(id);
  }, []);
  const top = ((minutes - START_HOUR * 60) / 60) * HOUR_H;
  if (top < 0 || top > (END_HOUR - START_HOUR) * HOUR_H) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 z-10 flex items-center" style={{ top }}>
      <span className="size-1.5 rounded-full bg-live" aria-hidden />
      <span className="h-px flex-1 bg-live" aria-hidden />
    </div>
  );
}
