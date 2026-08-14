"use client";

/**
 * Project / task picker.
 *
 * Used more than any other input in the product, so it gets its own component
 * and its own rules:
 *   - Client above project, both readable without opening it.
 *   - Fuzzy match across client name, project name, project code, and task name
 *     at once, so "budgetnista des" finds Example Learning → Example Client 40 plan → Design.
 *   - Recents pinned to the top.
 *   - Selecting a project auto-selects the task you used last on it, so the
 *     common path is one selection rather than two.
 *   - The whole assigned-project list is already in the query cache, so this
 *     opens instantly with no network round trip.
 */

import * as React from "react";
import { Check, ChevronsUpDown, Search } from "lucide-react";
import { cn } from "@/lib/cn";
import { useApp } from "./providers";
import { Popover, PopoverContent, PopoverTrigger, Badge } from "@/components/ui/primitives";
import { inputVariants } from "@/components/ui/recipes";
import type { ID } from "@/lib/types";

const RECENTS_KEY = "tally-recent-projects";

export function readRecents(): { projectId: ID; taskId: ID }[] {
  if (typeof window === "undefined") return [];
  try { return JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "[]"); } catch { return []; }
}
export function pushRecent(projectId: ID, taskId: ID) {
  if (typeof window === "undefined") return;
  const list = readRecents().filter((r) => !(r.projectId === projectId && r.taskId === taskId));
  list.unshift({ projectId, taskId });
  try { localStorage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, 8))); } catch { /* ignore */ }
}

/** Last task used on a project, else the project's first billable task. */
export function defaultTaskFor(projectId: ID, taskIds: ID[], taskById: Map<ID, { defaultBillable: boolean; name: string }>): ID | undefined {
  const recent = readRecents().find((r) => r.projectId === projectId);
  if (recent && taskIds.includes(recent.taskId)) return recent.taskId;
  const billable = taskIds
    .map((id) => ({ id, t: taskById.get(id) }))
    .filter((x) => x.t?.defaultBillable)
    .sort((a, b) => (a.t!.name).localeCompare(b.t!.name));
  return billable[0]?.id ?? taskIds[0];
}

/** Subsequence match, so "bud Example Client 40" hits "Example Learning Example Client 40 plan". */
function fuzzy(haystack: string, needle: string): boolean {
  if (!needle) return true;
  const h = haystack.toLowerCase();
  return needle.toLowerCase().split(/\s+/).every((term) => h.includes(term));
}

export function ProjectPicker({
  projectId, onChange, className, disabled, id,
}: {
  projectId?: ID; onChange: (projectId: ID) => void;
  className?: string; disabled?: boolean; id?: string;
}) {
  const { projects, clientById, me, taskById } = useApp();
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState("");

  const assigned = React.useMemo(
    () => projects.filter((p) => !p.archivedAt && (p.memberIds.includes(me.id) || p.managerIds.includes(me.id))),
    [projects, me.id]
  );

  const selected = projectId ? projects.find((p) => p.id === projectId) : undefined;
  const selectedClient = selected ? clientById.get(selected.clientId) : undefined;

  const recents = React.useMemo(() => {
    const ids = readRecents().map((r) => r.projectId);
    const seen = new Set<string>();
    return ids
      .map((id) => assigned.find((p) => p.id === id))
      .filter((p): p is NonNullable<typeof p> => !!p && !seen.has(p.id) && !!seen.add(p.id))
      .slice(0, 5);
  }, [assigned, open]);

  const filtered = React.useMemo(() => {
    if (!q) return assigned;
    return assigned.filter((p) => {
      const c = clientById.get(p.clientId);
      const taskNames = p.taskIds.map((t) => taskById.get(t)?.name ?? "").join(" ");
      return fuzzy(`${c?.name ?? ""} ${p.name} ${p.code ?? ""} ${taskNames}`, q);
    });
  }, [assigned, q, clientById, taskById]);

  const grouped = React.useMemo(() => {
    const map = new Map<string, typeof assigned>();
    for (const p of filtered) {
      const name = clientById.get(p.clientId)?.name ?? "Unknown client";
      const list = map.get(name);
      if (list) list.push(p); else map.set(name, [p]);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered, clientById]);

  const choose = (pid: ID) => { onChange(pid); setOpen(false); setQ(""); };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          disabled={disabled}
          className={cn(
            inputVariants(), "flex h-auto min-h-9 flex-col items-start justify-center gap-0 py-1.5 text-left",
            "disabled:cursor-not-allowed", className
          )}
        >
          {selected ? (
            <>
              <span className="w-full truncate text-sm leading-tight text-ink-tertiary">{selectedClient?.name}</span>
              <span className="w-full truncate font-medium leading-tight text-ink">{selected.name}</span>
            </>
          ) : (
            <span className="text-ink-tertiary">Choose a project</span>
          )}
          <ChevronsUpDown className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-tertiary" aria-hidden />
        </button>
      </PopoverTrigger>

      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-[340px]">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Search className="size-4 shrink-0 text-ink-tertiary" aria-hidden />
          <input
            autoFocus value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Search projects, clients, tasks…"
            className="w-full bg-transparent text-base outline-none placeholder:text-ink-tertiary"
          />
        </div>

        <div className="max-h-[320px] overflow-y-auto p-1">
          {!q && recents.length > 0 && (
            <>
              <div className="px-2 py-1.5 text-xs font-semibold uppercase tracking-[0.06em] text-ink-tertiary">Recent</div>
              {recents.map((p) => (
                <Row key={`r-${p.id}`} project={p} client={clientById.get(p.clientId)?.name} selected={p.id === projectId} onSelect={() => choose(p.id)} />
              ))}
              <div className="my-1 h-px bg-border" />
            </>
          )}

          {grouped.length === 0 && (
            <div className="px-3 py-6 text-center text-base text-ink-secondary">No projects match “{q}”.</div>
          )}

          {grouped.map(([client, list]) => (
            <div key={client}>
              <div className="px-2 py-1.5 text-xs font-semibold uppercase tracking-[0.06em] text-ink-tertiary">{client}</div>
              {list.map((p) => (
                <Row key={p.id} project={p} selected={p.id === projectId} onSelect={() => choose(p.id)} />
              ))}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Row({ project, client, selected, onSelect }: {
  project: { id: string; name: string; billingType: string; endsOn?: string };
  client?: string; selected?: boolean; onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-base",
        "hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none",
        selected && "bg-bg-muted"
      )}
    >
      <span className="min-w-0 flex-1 truncate">
        {client && <span className="mr-1.5 text-ink-tertiary">{client}</span>}
        {project.name}
      </span>
      {project.billingType === "non_billable" && <Badge variant="outline">Non-billable</Badge>}
      {selected && <Check className="size-4 shrink-0 text-ink" aria-hidden />}
    </button>
  );
}

/** Task select, scoped to a project. Separate control, pre-filled by the picker. */
export function TaskSelect({ projectId, taskId, onChange, className, id }: {
  projectId?: ID; taskId?: ID; onChange: (taskId: ID) => void; className?: string; id?: string;
}) {
  const { projectById, taskById } = useApp();
  const project = projectId ? projectById.get(projectId) : undefined;
  const options = React.useMemo(() => {
    const ids = project?.taskIds ?? [];
    return ids
      .map((id) => taskById.get(id))
      .filter((t): t is NonNullable<typeof t> => !!t && !t.archivedAt)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [project, taskById]);

  return (
    <div className="relative">
      <select
        id={id}
        className={cn(inputVariants(), "cursor-pointer appearance-none pr-8", className)}
        value={taskId ?? ""}
        disabled={!project}
        onChange={(e) => onChange(e.target.value)}
      >
        {!taskId && <option value="">Choose a task</option>}
        {options.map((t) => (
          <option key={t.id} value={t.id}>{t.name}{t.defaultBillable ? "" : " (non-billable)"}</option>
        ))}
      </select>
      <ChevronsUpDown className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-tertiary" aria-hidden />
    </div>
  );
}
