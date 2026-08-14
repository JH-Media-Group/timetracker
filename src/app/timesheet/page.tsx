"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { Plus, ChevronLeft, ChevronRight, Calendar as CalIcon } from "lucide-react";
import * as api from "@/lib/api";
import { cn } from "@/lib/cn";
import {
  addDays, formatDayLong, formatDuration, formatWeekRange, isoDate, startOfWeek, toDate,
} from "@/lib/format";
import { Button, Segmented } from "@/components/ui/primitives";
import { PageBody, PageHeader, useUrlState } from "@/components/app/page-chrome";
import { useApp } from "@/components/app/providers";
import { useEntryDialog } from "@/components/app/entry-editor";
import { DayView } from "./day-view";
import { WeekView } from "./week-view";
import { CalendarView } from "./calendar-view";
import { TeammateSwitcher } from "./teammate-switcher";
import { SubmitWeek } from "./submit-week";

type View = "day" | "week" | "calendar";

export default function TimesheetPage() {
  const { params, set } = useUrlState();
  const { me, settings, userById } = useApp();
  const entry = useEntryDialog();

  const view = (params.get("view") as View) || "day";
  const userId = params.get("user") || me.id;
  const dateStr = params.get("date") || isoDate(api.TODAY);
  const date = toDate(dateStr);
  const weekStart = startOfWeek(date, settings.weekStartsOn ?? 1);
  const isOther = userId !== me.id;
  const person = userById.get(userId);

  const { data: entries = [], isLoading } = useQuery({
    queryKey: ["time", userId, isoDate(weekStart)],
    queryFn: () => api.listTimeEntries({ userId, from: isoDate(weekStart), to: isoDate(addDays(weekStart, 6)) }),
  });

  const setDate = (d: Date) => set({ date: isoDate(d) });
  const step = (dir: -1 | 1) => setDate(addDays(date, view === "day" ? dir : 7 * dir));

  // Day/Week/Calendar and arrow-key navigation.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "d") { e.preventDefault(); set({ view: "day" }); }
      else if (k === "w") { e.preventDefault(); set({ view: "week" }); }
      else if (k === "c") { e.preventDefault(); set({ view: "calendar" }); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
      else if (e.key === "ArrowRight") { e.preventDefault(); step(1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [date, view, set]);

  const dayTotals = React.useMemo(() => {
    const out: Record<string, number> = {};
    for (let i = 0; i < 7; i++) out[isoDate(addDays(weekStart, i))] = 0;
    for (const e of entries) if (out[e.spentOn] != null) out[e.spentOn]! += e.durationSeconds;
    return out;
  }, [entries, weekStart]);

  const weekTotal = Object.values(dayTotals).reduce((a, b) => a + b, 0);
  const capacity = (person ?? me).weeklyCapacitySeconds;

  return (
    <>
      <PageHeader
        title="Timesheet"
        actions={
          <div className="flex items-center gap-2">
            <SubmitWeek userId={userId} weekStart={isoDate(weekStart)} totalSeconds={weekTotal} />
            <Segmented
              value={view}
              onChange={(v) => set({ view: v })}
              aria-label="Timesheet view"
              options={[{ value: "day", label: "Day" }, { value: "week", label: "Week" }, { value: "calendar", label: "Calendar" }]}
            />
            <TeammateSwitcher userId={userId} onChange={(id) => set({ user: id === me.id ? null : id })} />
          </div>
        }
      />

      <PageBody className="pt-4">
        {isOther && person && (
          <div className="mb-4 flex items-center gap-3 rounded-md border border-warning-border bg-warning-bg px-4 py-2.5 text-base text-warning">
            <span className="grid size-7 shrink-0 place-items-center rounded-full bg-warning/20 text-xs font-semibold">
              {person.firstName[0]}{person.lastName[0]}
            </span>
            <div className="min-w-0 flex-1">
              <strong className="font-semibold">Editing {person.firstName} {person.lastName}&rsquo;s timesheet.</strong>{" "}
              <span className="text-ink-secondary">Changes save to {person.firstName}&rsquo;s timesheet.</span>
            </div>
            <button className="shrink-0 underline" onClick={() => set({ user: null })}>Return to mine</button>
          </div>
        )}

        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Button variant="primary" size="icon" aria-label="New entry"
            onClick={() => entry.open({ spentOn: dateStr, userId })}>
            <Plus className="size-4" />
          </Button>
          <div className="flex items-center gap-1">
            <Button variant="secondary" size="icon-sm" aria-label="Previous" onClick={() => step(-1)}><ChevronLeft className="size-4" /></Button>
            <span className="flex h-8 items-center gap-2 rounded-md border border-border bg-surface px-3 text-base">
              <CalIcon className="size-3.5 text-ink-tertiary" aria-hidden />
              {view === "day"
                ? <>{isoDate(date) === isoDate(api.TODAY) && <span className="font-medium">Today</span>}<span className={isoDate(date) === isoDate(api.TODAY) ? "text-ink-secondary" : "font-medium"}>{formatDayLong(date)}</span></>
                : <span className="font-medium">{formatWeekRange(weekStart)}</span>}
            </span>
            <Button variant="secondary" size="icon-sm" aria-label="Next" onClick={() => step(1)}><ChevronRight className="size-4" /></Button>
          </div>
          {isoDate(date) !== isoDate(api.TODAY) && (
            <button className="text-base text-link underline" onClick={() => setDate(api.TODAY)}>Return to today</button>
          )}
        </div>

        {/* Week strip */}
        <div className="mb-4 grid grid-cols-8 gap-px overflow-hidden rounded-lg border border-border bg-border">
          {Array.from({ length: 7 }).map((_, i) => {
            const d = addDays(weekStart, i);
            const key = isoDate(d);
            const isSel = key === dateStr;
            const isToday = key === isoDate(api.TODAY);
            const total = dayTotals[key] ?? 0;
            const isWeekday = d.getDay() !== 0 && d.getDay() !== 6;
            const missing = isWeekday && total === 0 && d < api.TODAY;
            return (
              <button key={key} onClick={() => setDate(d)}
                className={cn("flex flex-col items-start gap-0.5 bg-surface px-3 py-2 text-left transition-colors hover:bg-surface-hover",
                  isSel && "bg-bg-muted")}>
                <span className={cn("flex items-center gap-1 text-base", isSel ? "font-medium text-ink" : "text-ink-secondary")}>
                  {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][(d.getDay() + 6) % 7]}
                  {isToday && !isSel && <span className="size-1 rounded-full bg-ink-tertiary" aria-hidden />}
                  {missing && <span className="size-1.5 rounded-full bg-warning" title="No time tracked" aria-hidden />}
                </span>
                <span className={cn("tabular-nums", total ? "font-semibold text-ink" : "text-ink-tertiary")}>
                  {formatDuration(total, settings.timeDisplay)}
                </span>
                {isSel && <span className="mt-0.5 h-0.5 w-full rounded-full bg-accent" aria-hidden />}
              </button>
            );
          })}
          <div className="flex flex-col items-end gap-0.5 bg-surface px-3 py-2">
            <span className="text-base text-ink-secondary">Week total</span>
            <span className={cn("font-semibold tabular-nums", weekTotal >= capacity ? "text-success" : "text-ink")}>
              {formatDuration(weekTotal, settings.timeDisplay)}
              <span className="ml-1 font-normal text-ink-tertiary">/ {Math.round(capacity / 3600)}</span>
            </span>
          </div>
        </div>

        {view === "day" && <DayView date={dateStr} userId={userId} entries={entries} loading={isLoading} />}
        {view === "week" && <WeekView weekStart={weekStart} userId={userId} entries={entries} loading={isLoading} />}
        {view === "calendar" && <CalendarView weekStart={weekStart} userId={userId} entries={entries} loading={isLoading} />}
      </PageBody>
    </>
  );
}
