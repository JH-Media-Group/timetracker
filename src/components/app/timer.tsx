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
import { usePathname } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "@/lib/api";
import { isAnonymousPage } from "@/lib/anonymous-pages";
import { liveSeconds } from "@/lib/derive";
import type { TimeEntry } from "@/lib/types";
import { useToast } from "@/components/ui/toast";
import { useApp } from "./providers";
import { formatClock } from "@/lib/format";
import { dayIn } from "@/domain/calendar";

/** The server's sentence when it gave one, or a plain fallback. */
const failureText = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message.trim() ? error.message : fallback;

/**
 * Waits for a mutation and reports whether it worked, rather than rejecting.
 *
 * The mutation's own `onError` has already told the person what happened. What
 * is left is the answer for the caller, and an unhandled rejection is not one.
 */
const settled = (promise: Promise<unknown>): Promise<boolean> =>
  promise.then(() => true, () => false);

interface TimerCtx {
  running: TimeEntry | null;
  elapsed: number;
  /*
    These answer whether it worked, and never reject.

    They used to be `mutateAsync` handed straight out, so a failure rejected
    into whatever called them. Nothing caught it: pressing Stop produced an
    uncaught promise rejection in the console and no message on the screen, so a
    timer that refused to stop was indistinguishable from a button that did
    nothing (t-qXAssj, t-4Sct76, t-E-CsIL). The mutations below say what went
    wrong; the boolean is for callers that need to know, like the popover that
    should stay open when the timer did not start.
  */
  start: (input: { projectId: string; taskId: string; notes?: string; spentOn?: string }) => Promise<boolean>;
  /**
   * Stops one person's timer. The id is required on purpose.
   *
   * The timesheet can be pointed at a teammate, and its rows then show that
   * person's running entry with a Stop button beside it. `stopTimer` has always
   * taken a user id and every caller omitted it, so the button stopped the
   * signed-in person's timer instead: nothing visible happened on somebody
   * else's timesheet, and on your own the two coincided. That is the whole of
   * "sometimes it works" (t-DVQ2qW).
   *
   * Optional was the mistake. A control that stops a timer has a timer in hand,
   * so it can always say which, and now the compiler makes it.
   */
  stop: (userId: string) => Promise<boolean>;
  restart: (entryId: string) => Promise<boolean>;
  isBusy: boolean;
  /**
   * True when the running-timer query is failing.
   *
   * Absent data and unreachable data look identical in a widget that shows
   * "Start timer" for both, and somebody who believes no timer is running will
   * start a second one over the top of the first.
   */
  unreachable: boolean;
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
  const { projectById, taskById, me } = useApp();
  const [now, setNow] = React.useState(() => Date.now());

  // Nothing to reconcile on anonymous auth screens. Polling there gets a 401
  // and the global handler redirects a valid set-password link to sign-in.
  const pathname = usePathname();
  const anonymous = isAnonymousPage(pathname);

  const { data: running = null, isError: timerUnreachable } = useQuery({
    queryKey: ["running"],
    queryFn: () => api.getRunningEntry(),
    enabled: !anonymous,
    refetchInterval: anonymous ? false : 30_000,   // reconcile with the server periodically
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
        spentOn: input.spentOn ?? dayIn(me.timezone),
        // No `startedAt`. The server names the instant a timer begins, because
        // the server is what ends it, and a browser clock running fast wrote
        // entries that could not be stopped. See `timerStartInstant`.
        start: true,
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
    onError: (e: unknown) => toast.push({ tone: "danger", title: failureText(e, "Could not start the timer.") }),
  });

  const stopM = useMutation({
    mutationFn: (userId: string) => api.stopTimer(userId),
    onSuccess: (stopped) => {
      invalidate();
      if (stopped) {
        const p = projectById.get(stopped.projectId);
        toast.push({ tone: "success", title: <>Stopped <em className="font-medium not-italic">{p?.name}</em> at {formatClock(stopped.durationSeconds)}.</> });
        return;
      }
      // Nothing was running. Silence here is what made a Stop button aimed at
      // the wrong person indistinguishable from a button that does nothing.
      toast.push({ title: "There was no running timer to stop." });
    },
    onError: (e: unknown) =>
      toast.push({ tone: "danger", title: failureText(e, "Could not stop the timer. It is still running.") }),
  });

  const restartM = useMutation({
    mutationFn: (entryId: string) => api.startTimerFrom(entryId),
    onSuccess: ({ entry }) => {
      invalidate();
      const p = projectById.get(entry.projectId);
      toast.push({ tone: "success", title: <>Timer started on <em className="font-medium not-italic">{p?.name}</em>.</> });
    },
    onError: (e: unknown) => toast.push({ tone: "danger", title: failureText(e, "Could not start the timer.") }),
  });

  const value = React.useMemo<TimerCtx>(() => ({
    running,
    elapsed,
    start: async (i) => settled(startM.mutateAsync(i)),
    stop: async (userId: string) => settled(stopM.mutateAsync(userId)),
    restart: async (id) => settled(restartM.mutateAsync(id)),
    isBusy: startM.isPending || stopM.isPending || restartM.isPending,
    unreachable: timerUnreachable,
  }), [running, elapsed, startM, stopM, restartM]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
