"use client";

/**
 * Command palette.
 *
 * One tab stop from anywhere. Empty query shows recents and actions; typing
 * searches across projects, clients, people, invoices and tasks at once.
 * Alt+Enter on a project starts a timer on it without leaving the palette,
 * which is the fastest path in the product.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import {
  Building2, Clock, FileText, FolderOpen, ListChecks, Play, Search, Users, Command as CmdIcon,
} from "lucide-react";
import * as api from "@/lib/api";
import { cn } from "@/lib/cn";
import { createStore } from "@/lib/store";
import { Dialog, DialogContent, Kbd } from "@/components/ui/primitives";
import { useApp } from "./providers";
import { useTimer } from "./timer";
import { defaultTaskFor, pushRecent } from "./project-picker";
import { useEntryDialog } from "./entry-editor";

type Mode = "search" | "shortcuts" | "timer";
const store = createStore<{ open: boolean; mode: Mode }>({ open: false, mode: "search" });

export function useCommandPalette() {
  return {
    open: () => store.set({ open: true, mode: "search" }),
    openShortcuts: () => store.set({ open: true, mode: "shortcuts" }),
    openTimer: () => store.set({ open: true, mode: "timer" }),
    close: () => store.set({ open: false }),
  };
}

interface Row {
  id: string; label: string; sub?: string; icon: React.ElementType;
  group: string; run: () => void; startTimer?: () => void; shortcut?: string;
}

export function CommandPalette() {
  const { open, mode } = store.useStore();
  const palette = useCommandPalette();
  const router = useRouter();
  const { projects, clients, users, projectById, taskById } = useApp();
  const { start, running, stop } = useTimer();
  const entry = useEntryDialog();

  const [q, setQ] = React.useState("");
  const [cursor, setCursor] = React.useState(0);
  const listRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => { if (open) { setQ(""); setCursor(0); } }, [open, mode]);

  const { data: hits = [] } = useQuery({
    queryKey: ["search", q],
    queryFn: () => api.search(q),
    enabled: open && mode === "search" && q.trim().length > 0,
  });

  const actions = React.useMemo<Row[]>(() => [
    { id: "a-timer", group: "Actions", icon: Play, label: running ? "Stop timer" : "Start timer", shortcut: "T",
      run: () => { if (running) void stop(); else palette.openTimer(); } },
    { id: "a-entry", group: "Actions", icon: Clock, label: "New time entry", shortcut: "N", run: () => entry.open({}) },
    { id: "a-today", group: "Actions", icon: Clock, label: "Go to today", run: () => router.push("/timesheet") },
    { id: "a-proj", group: "Actions", icon: FolderOpen, label: "New project", run: () => router.push("/projects/new") },
    { id: "a-client", group: "Actions", icon: Building2, label: "New client", run: () => router.push("/clients/new") },
    { id: "a-reports", group: "Actions", icon: FileText, label: "Profitability report", run: () => router.push("/reports?r=profitability") },
    { id: "a-short", group: "Actions", icon: CmdIcon, label: "Keyboard shortcuts", shortcut: "?", run: () => palette.openShortcuts() },
  ], [running, stop, palette, entry, router]);

  const rows = React.useMemo<Row[]>(() => {
    if (mode === "timer") {
      return projects.filter((p) => !p.archivedAt).slice(0, 200).map((p) => ({
        id: p.id, group: "Start a timer on", icon: FolderOpen,
        label: p.name, sub: clients.find((c) => c.id === p.clientId)?.name,
        run: () => {
          const t = defaultTaskFor(p.id, p.taskIds, taskById);
          if (t) { pushRecent(p.id, t); void start({ projectId: p.id, taskId: t }); }
          palette.close();
        },
      }));
    }

    if (!q.trim()) {
      const recentProjects = projects.filter((p) => !p.archivedAt).slice(0, 5).map<Row>((p) => ({
        id: `p-${p.id}`, group: "Projects", icon: FolderOpen, label: p.name,
        sub: clients.find((c) => c.id === p.clientId)?.name,
        run: () => { router.push(`/projects/${p.id}`); palette.close(); },
        startTimer: () => {
          const t = defaultTaskFor(p.id, p.taskIds, taskById);
          if (t) { pushRecent(p.id, t); void start({ projectId: p.id, taskId: t }); }
          palette.close();
        },
      }));
      return [...actions, ...recentProjects];
    }

    const iconFor: Record<string, React.ElementType> = {
      project: FolderOpen, client: Building2, person: Users, invoice: FileText, task: ListChecks,
    };
    const groupFor: Record<string, string> = {
      project: "Projects", client: "Clients", person: "People", invoice: "Invoices", task: "Tasks",
    };
    const hitRows = hits.map<Row>((h) => ({
      id: `${h.type}-${h.id}`, group: groupFor[h.type]!, icon: iconFor[h.type]!,
      label: h.label, sub: h.sub,
      run: () => {
        const dest: Record<string, string> = {
          project: `/projects/${h.id}`, client: `/clients/${h.id}`,
          person: `/team/${h.id}`, invoice: `/invoices/${h.id}`, task: `/tasks`,
        };
        router.push(dest[h.type]!);
        palette.close();
      },
      startTimer: h.type === "project" ? () => {
        const p = projectById.get(h.id);
        const t = p ? defaultTaskFor(p.id, p.taskIds, taskById) : undefined;
        if (p && t) { pushRecent(p.id, t); void start({ projectId: p.id, taskId: t }); }
        palette.close();
      } : undefined,
    }));
    const matchedActions = actions.filter((a) => a.label.toLowerCase().includes(q.toLowerCase()));
    return [...matchedActions, ...hitRows];
  }, [mode, q, hits, actions, projects, clients, projectById, taskById, router, palette, start]);

  const grouped = React.useMemo(() => {
    const map = new Map<string, Row[]>();
    rows.forEach((r) => { const l = map.get(r.group); if (l) l.push(r); else map.set(r.group, [r]); });
    return [...map.entries()];
  }, [rows]);

  const flat = React.useMemo(() => grouped.flatMap(([, list]) => list), [grouped]);

  React.useEffect(() => { setCursor((c) => Math.min(c, Math.max(0, flat.length - 1))); }, [flat.length]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(c + 1, flat.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
    else if (e.key === "Enter") {
      e.preventDefault();
      const row = flat[cursor];
      if (!row) return;
      if (e.altKey && row.startTimer) row.startTimer(); else row.run();
    }
  };

  React.useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  if (!open) return null;

  if (mode === "shortcuts") {
    return (
      <Dialog open onOpenChange={palette.close}>
        <DialogContent title="Keyboard shortcuts" size="lg">
          <div className="grid gap-6 md:grid-cols-2">
            {SHORTCUT_GROUPS.map((g) => (
              <div key={g.title}>
                <div className="mb-2 text-xs font-semibold uppercase tracking-[0.06em] text-ink-tertiary">{g.title}</div>
                <div className="flex flex-col gap-1.5">
                  {g.items.map((i) => (
                    <div key={i.keys} className="flex items-center justify-between gap-4 text-base">
                      <span className="text-ink-secondary">{i.label}</span>
                      <span className="flex shrink-0 gap-1">{i.keys.split(" ").map((k) => <Kbd key={k}>{k}</Kbd>)}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open onOpenChange={palette.close}>
      <DialogContent
        title={mode === "timer" ? "Start a timer" : "Search"}
        description={mode === "timer" ? "Pick a project. The task you used last is selected automatically." : undefined}
        size="md"
        className="p-0"
      >
        <div className="-mx-5 -my-4">
          <div className="flex items-center gap-2 border-b border-border px-4 py-3">
            <Search className="size-4 shrink-0 text-ink-tertiary" aria-hidden />
            {/* Combobox semantics, so a screen reader announces the result count
                and reads the highlighted row as the arrow keys move through it. */}
            <input
              autoFocus value={q} onChange={(e) => { setQ(e.target.value); setCursor(0); }}
              onKeyDown={onKeyDown}
              placeholder={mode === "timer" ? "Filter projects…" : "Search projects, people, invoices…"}
              className="w-full bg-transparent text-base outline-none placeholder:text-ink-tertiary"
              aria-label="Search"
              role="combobox"
              aria-expanded={flat.length > 0}
              aria-controls="tally-palette-list"
              aria-autocomplete="list"
              aria-activedescendant={flat[cursor] ? `tally-palette-${flat[cursor]!.id}` : undefined}
            />
          </div>

          <div
            ref={listRef}
            id="tally-palette-list"
            role="listbox"
            aria-label={mode === "timer" ? "Projects" : "Search results"}
            className="max-h-[380px] overflow-y-auto p-1.5"
          >
            {flat.length === 0 && (
              <div className="px-3 py-8 text-center text-base text-ink-secondary">
                {q ? <>No matches for “{q}”.</> : "Start typing to search."}
              </div>
            )}
            {grouped.map(([group, list]) => (
              <div key={group} role="group" aria-label={group}>
                <div className="px-2 py-1.5 text-xs font-semibold uppercase tracking-[0.06em] text-ink-tertiary" aria-hidden>{group}</div>
                {list.map((row) => {
                  const idx = flat.indexOf(row);
                  const Icon = row.icon;
                  return (
                    <button
                      key={row.id}
                      id={`tally-palette-${row.id}`}
                      role="option"
                      aria-selected={idx === cursor}
                      data-active={idx === cursor}
                      onMouseEnter={() => setCursor(idx)}
                      onClick={(e) => (e.altKey && row.startTimer ? row.startTimer() : row.run())}
                      className={cn(
                        "flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left text-base",
                        idx === cursor ? "bg-surface-hover" : ""
                      )}
                    >
                      <Icon className="size-4 shrink-0 text-ink-tertiary" aria-hidden />
                      <span className="min-w-0 flex-1 truncate">
                        {row.label}
                        {row.sub && <span className="ml-2 text-ink-tertiary">{row.sub}</span>}
                      </span>
                      {row.startTimer && idx === cursor && (
                        <span className="hidden shrink-0 items-center gap-1 text-xs text-ink-tertiary md:flex">
                          <Kbd>⌥↵</Kbd> start
                        </span>
                      )}
                      {row.shortcut && <Kbd>{row.shortcut}</Kbd>}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          <div className="flex items-center gap-3 border-t border-border px-4 py-2 text-xs text-ink-tertiary">
            <span className="flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd> navigate</span>
            <span className="flex items-center gap-1"><Kbd>↵</Kbd> open</span>
            <span className="flex items-center gap-1"><Kbd>esc</Kbd> close</span>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const SHORTCUT_GROUPS = [
  { title: "Global", items: [
    { keys: "⌘K", label: "Command palette" },
    { keys: "T", label: "Start or stop the timer" },
    { keys: "N", label: "New time entry" },
    { keys: "E", label: "New expense" },
    { keys: "?", label: "This sheet" },
    { keys: "⌘Z", label: "Undo the last action" },
  ]},
  { title: "Navigate", items: [
    { keys: "G T", label: "Timesheet" },
    { keys: "G P", label: "Projects" },
    { keys: "G C", label: "Clients" },
    { keys: "G I", label: "Invoices" },
    { keys: "G R", label: "Reports" },
    { keys: "G M", label: "Team" },
  ]},
  { title: "Timesheet", items: [
    { keys: "D", label: "Day view" },
    { keys: "W", label: "Week view" },
    { keys: "C", label: "Calendar view" },
    { keys: "← →", label: "Previous or next day" },
  ]},
  { title: "Editor", items: [
    { keys: "⌘↵", label: "Save" },
    { keys: "esc", label: "Cancel" },
  ]},
];
