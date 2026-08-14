"use client";

/**
 * The running timer.
 *
 * Elapsed time is derived from the server's `timerStartedAt` on every tick,
 * never accumulated in a client-side counter. A laptop that sleeps for an hour
 * therefore shows the correct elapsed time the moment it wakes, and a stale tab
 * reconciles on its next tick rather than drifting forever.
 */

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "@/lib/api";
import { liveSeconds } from "@/lib/derive";
import type { TimeEntry } from "@/lib/types";
import { useToast } from "@/components/ui/toast";
import { useApp } from "./providers";
import { formatClock } from "@/lib/format";

interface TimerCtx {
  running: TimeEntry | null;
  elapsed: number;
  start: (input: { projectId: string; taskId: string; notes?: string; spentOn?: string }) => Promise<void>;
  stop: () => Promise<void>;
  restart: (entryId: string) => Promise<void>;
  isBusy: boolean;
}

const Ctx = React.createContext<TimerCtx | null>(null);

export function useTimer() {
  const ctx = React.useContext(Ctx);
  if (!ctx) throw new Error("useTimer must be used inside <TimerProvider>");
  return ctx;
}

export function TimerProvider({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { projectById, taskById } = useApp();
  const [now, setNow] = React.useState(() => Date.now());

  const { data: running = null } = useQuery({
    queryKey: ["running"],
    queryFn: () => api.getRunningEntry(),
    refetchInterval: 30_000,          // reconcile with the server periodically
  });

  // One interval for the whole app. Only ticks while something is running.
  React.useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [running]);

  const elapsed = running ? liveSeconds(running, now) : 0;

  // Document title and favicon reflect the running state, so a background tab
  // still shows it. This is the cheapest possible ambient signal.
  React.useEffect(() => {
    const base = "Tally";
    if (!running) { document.title = base; return; }
    const project = projectById.get(running.projectId);
    document.title = `${formatClock(elapsed)} · ${project?.name ?? "Tracking"}`;
  }, [running, elapsed, projectById]);

  const invalidate = React.useCallback(() => {
    qc.invalidateQueries({ queryKey: ["running"] });
    qc.invalidateQueries({ queryKey: ["time"] });
    qc.invalidateQueries({ queryKey: ["summary"] });
  }, [qc]);

  const startM = useMutation({
    mutationFn: (input: { projectId: string; taskId: string; notes?: string; spentOn?: string }) =>
      api.createTimeEntry({
        projectId: input.projectId, taskId: input.taskId, notes: input.notes,
        spentOn: input.spentOn ?? new Date().toISOString().slice(0, 10),
        startedAt: new Date().toISOString(), start: true,
      }),
    onSuccess: ({ entry, stopped }) => {
      invalidate();
      const p = projectById.get(entry.projectId);
      const t = taskById.get(entry.taskId);
      if (stopped) {
        const sp = projectById.get(stopped.projectId);
        toast.push({
          tone: "success",
          title: <>Stopped <em className="font-medium not-italic">{sp?.name}</em>. Started <em className="font-medium not-italic">{t?.name}</em> on {p?.name}.</>,
        });
      } else {
        toast.push({ tone: "success", title: <>Timer started on <em className="font-medium not-italic">{p?.name}</em>.</> });
      }
    },
  });

  const stopM = useMutation({
    mutationFn: () => api.stopTimer(),
    onSuccess: (stopped) => {
      invalidate();
      if (stopped) {
        const p = projectById.get(stopped.projectId);
        toast.push({ tone: "success", title: <>Stopped <em className="font-medium not-italic">{p?.name}</em> at {formatClock(stopped.durationSeconds)}.</> });
      }
    },
  });

  const restartM = useMutation({
    mutationFn: (entryId: string) => api.startTimerFrom(entryId),
    onSuccess: ({ entry }) => {
      invalidate();
      const p = projectById.get(entry.projectId);
      toast.push({ tone: "success", title: <>Timer started on <em className="font-medium not-italic">{p?.name}</em>.</> });
    },
  });

  const value = React.useMemo<TimerCtx>(() => ({
    running,
    elapsed,
    start: async (i) => { await startM.mutateAsync(i); },
    stop: async () => { await stopM.mutateAsync(); },
    restart: async (id) => { await restartM.mutateAsync(id); },
    isBusy: startM.isPending || stopM.isPending || restartM.isPending,
  }), [running, elapsed, startM, stopM, restartM]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
