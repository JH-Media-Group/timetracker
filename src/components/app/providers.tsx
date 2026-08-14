"use client";

/**
 * App providers and the shared data context.
 *
 * `useApp()` exposes the bootstrap payload (me, users, clients, projects, tasks,
 * settings) that almost every screen needs. It is fetched once and held in the
 * query cache, which is what lets the project picker open instantly with no
 * network round trip.
 */

import * as React from "react";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "@/lib/api";
import type { Client, ExpenseCategory, Project, Settings, Task, User, ID } from "@/lib/types";
import { ToastProvider } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/primitives";

/* ------------------------------------------------------------------ theme */

export type ThemePref = "system" | "light" | "dark";
const ThemeCtx = React.createContext<{ theme: ThemePref; setTheme: (t: ThemePref) => void }>({
  theme: "system", setTheme: () => {},
});
export const useTheme = () => React.useContext(ThemeCtx);

function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = React.useState<ThemePref>("system");

  React.useEffect(() => {
    try {
      const t = localStorage.getItem("tally-theme") as ThemePref | null;
      if (t) setThemeState(t);
    } catch { /* blocked storage */ }
  }, []);

  const setTheme = React.useCallback((t: ThemePref) => {
    setThemeState(t);
    const root = document.documentElement;
    if (t === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", t);
    try { localStorage.setItem("tally-theme", t); } catch { /* blocked storage */ }
  }, []);

  return <ThemeCtx.Provider value={{ theme, setTheme }}>{children}</ThemeCtx.Provider>;
}

/* --------------------------------------------------------------- app data */

export interface AppData {
  me: User;
  users: User[];
  clients: Client[];
  projects: Project[];
  tasks: Task[];
  expenseCategories: ExpenseCategory[];
  settings: Settings;
  pinnedProjectIds: ID[];
  // Lookups, built once so components never scan an array in render.
  userById: Map<ID, User>;
  clientById: Map<ID, Client>;
  projectById: Map<ID, Project>;
  taskById: Map<ID, Task>;
  categoryById: Map<ID, ExpenseCategory>;
  ready: boolean;
}

const AppCtx = React.createContext<AppData | null>(null);

export function useApp(): AppData {
  const ctx = React.useContext(AppCtx);
  if (!ctx) throw new Error("useApp must be used inside <Providers>");
  return ctx;
}

/** Capability check. The mock grants by profile; the real app reads /me/capabilities. */
export function useCan() {
  const { me } = useApp();
  return React.useCallback((cap: string) => {
    const p = me.profile;
    if (p === "administrator") return true;
    const table: Record<string, string[]> = {
      member: ["time:create_own", "time:edit_own", "expense:manage"],
      project_manager: ["time:create_own", "time:edit_own", "time:view_others", "time:edit_others", "approval:review", "project:manage", "client:manage", "task:manage", "expense:manage"],
      people_admin: ["time:create_own", "time:edit_own", "time:view_others", "time:edit_others", "approval:review", "people:manage", "expense:manage"],
      accounting: ["time:create_own", "time:edit_own", "client:manage", "invoice:manage", "rates:view_billable", "report:view_financial", "expense:manage"],
      executive_manager: ["time:create_own", "time:edit_own", "time:view_others", "time:edit_others", "approval:review", "project:manage", "client:manage", "people:manage", "invoice:manage", "rates:view_billable", "report:view_financial", "expense:manage"],
    };
    return (table[p] ?? []).includes(cap);
  }, [me.profile]);
}

function AppDataProvider({ children }: { children: React.ReactNode }) {
  const { data } = useQuery({
    queryKey: ["bootstrap"],
    queryFn: api.getBootstrap,
    staleTime: Infinity,
  });

  const value = React.useMemo<AppData>(() => {
    const users = data?.users ?? [];
    const clients = data?.clients ?? [];
    const projects = data?.projects ?? [];
    const tasks = data?.tasks ?? [];
    const expenseCategories = data?.expenseCategories ?? [];
    return {
      me: data?.me ?? ({ id: "u1", firstName: "…", lastName: "", email: "", roles: [], departments: [], employmentType: "employee", profile: "administrator", weeklyCapacitySeconds: 144000, timezone: "UTC", billableRateCents: 0, costRateCents: 0 } as User),
      users, clients, projects, tasks, expenseCategories,
      settings: data?.settings ?? ({} as Settings),
      pinnedProjectIds: data?.pinnedProjectIds ?? [],
      userById: new Map(users.map((u) => [u.id, u])),
      clientById: new Map(clients.map((c) => [c.id, c])),
      projectById: new Map(projects.map((p) => [p.id, p])),
      taskById: new Map(tasks.map((t) => [t.id, t])),
      categoryById: new Map(expenseCategories.map((c) => [c.id, c])),
      ready: !!data,
    };
  }, [data]);

  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}

/** Invalidate everything that could have changed after a write. */
export function useRefresh() {
  const qc = useQueryClient();
  return React.useCallback((...keys: string[]) => {
    if (!keys.length) { qc.invalidateQueries(); return; }
    keys.forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  }, [qc]);
}

/* --------------------------------------------------------------- provider */

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = React.useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        refetchOnWindowFocus: false,
        retry: 1,
      },
    },
  }));

  return (
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <TooltipProvider>
          <ToastProvider>
            <AppDataProvider>{children}</AppDataProvider>
          </ToastProvider>
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
