"use client";

/**
 * Quick timer. Two fields and a keystroke from anywhere in the app.
 *
 * If there is a recent entry, the form pre-fills it and the button reads
 * "Resume", so the most common case is one keypress: T, Enter.
 */

import * as React from "react";
import { Play } from "lucide-react";
import { Button, Field, Textarea } from "@/components/ui/primitives";
import { ProjectPicker, TaskSelect, defaultTaskFor, pushRecent, readRecents } from "./project-picker";
import { useApp } from "./providers";
import { useTimer } from "./timer";

export function QuickTimer({ onDone }: { onDone?: () => void }) {
  const { projectById, taskById, projects, me } = useApp();
  const { start, isBusy } = useTimer();

  const recent = React.useMemo(() => {
    const r = readRecents()[0];
    if (!r) return null;
    const p = projects.find((x) => x.id === r.projectId && !x.archivedAt);
    return p ? r : null;
  }, [projects]);

  const [projectId, setProjectId] = React.useState<string | undefined>(recent?.projectId);
  const [taskId, setTaskId] = React.useState<string | undefined>(recent?.taskId);
  const [notes, setNotes] = React.useState("");

  const onProject = (pid: string) => {
    setProjectId(pid);
    const p = projectById.get(pid);
    setTaskId(p ? defaultTaskFor(pid, p.taskIds, taskById) : undefined);
  };

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!projectId || !taskId) return;
    pushRecent(projectId, taskId);
    // Closes only if the timer actually started. Closing regardless hid the
    // failure behind the popover it was reported in.
    if (await start({ projectId, taskId, notes: notes.trim() || undefined })) onDone?.();
  };

  const project = projectId ? projectById.get(projectId) : undefined;
  const task = taskId ? taskById.get(taskId) : undefined;
  const isResume = !!recent && recent.projectId === projectId && recent.taskId === taskId && !notes;

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 p-3">
      <Field label="Project">
        <ProjectPicker projectId={projectId} onChange={onProject} />
      </Field>
      <Field label="Task">
        <TaskSelect projectId={projectId} taskId={taskId} onChange={setTaskId} />
      </Field>
      <Field label="Notes">
        <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" className="min-h-[60px]" />
      </Field>
      <Button type="submit" variant="primary" disabled={!projectId || !taskId} loading={isBusy} className="w-full">
        {!isBusy && <Play className="size-3.5 fill-current" />}
        {isResume && task ? `Resume: ${task.name}` : "Start timer"}
      </Button>
    </form>
  );
}
