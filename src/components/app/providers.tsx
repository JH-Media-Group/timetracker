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
import { usePathname } from "next/navigation";
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
  /** What the signed-in person may do, exactly as the server computed it. */
  capabilities: ReadonlySet<string>;
  ready: boolean;
}

const AppCtx = React.createContext<AppData | null>(null);

export function useApp(): AppData {
  const ctx = React.useContext(AppCtx);
  if (!ctx) throw new Error("useApp must be used inside <Providers>");
  return ctx;
}

/**
 * Capability check.
 *
 * The set comes from the server, which computed it from the same constant the
 * API gates on. That is the point: the client asks the identical question, so a
 * button cannot appear for an action the request would refuse, and a new
 * capability does not need a copy of the table maintained over here.
 *
 * Before the bootstrap lands the set is empty and every check is false, so the
 * shell renders its floor rather than flashing controls and taking them away.
 */
export function useCan() {
  const { capabilities } = useApp();
  return React.useCallback((cap: string) => capabilities.has(cap), [capabilities]);
}

/** Screens that render before anybody is signed in, so they must not bootstrap. */
const ANONYMOUS = ["/signin"];

function AppDataProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const anonymous = ANONYMOUS.some((r) => pathname.startsWith(r));

  const { data, error, isLoading } = useQuery({
    queryKey: ["bootstrap"],
    queryFn: api.getBootstrap,
    staleTime: Infinity,
    enabled: !anonymous,
    // A 401 is already being handled by a redirect to sign in; retrying it just
    // makes three requests fail instead of one.
    retry: (count, e) => count < 2 && !(api.isApiError(e) && e.status === 401),
  });

  const value = React.useMemo<AppData>(() => {
    const users = data?.users ?? [];
    const clients = data?.clients ?? [];
    const projects = data?.projects ?? [];
    const tasks = data?.tasks ?? [];
    const expenseCategories = data?.expenseCategories ?? [];
    return {
      // The placeholder holds no capabilities, so nothing privileged renders
      // before the real answer arrives.
      me: data?.me ?? ({ id: "", firstName: "…", lastName: "", email: "", roles: [], departments: [], employmentType: "employee", profile: "member", weeklyCapacitySeconds: 144000, timezone: "UTC", billableRateCents: 0, costRateCents: 0 } as User),
      users, clients, projects, tasks, expenseCategories,
      settings: data?.settings ?? (DEFAULT_SETTINGS as Settings),
      pinnedProjectIds: data?.pinnedProjectIds ?? [],
      userById: new Map(users.map((u) => [u.id, u])),
      clientById: new Map(clients.map((c) => [c.id, c])),
      projectById: new Map(projects.map((p) => [p.id, p])),
      taskById: new Map(tasks.map((t) => [t.id, t])),
      categoryById: new Map(expenseCategories.map((c) => [c.id, c])),
      capabilities: new Set(data?.capabilities ?? []),
      ready: !!data,
    };
  }, [data]);

  // A failure that is not a 401 has to be visible. Rendering the shell over an
  // empty context would show every page as "no data", which reads as an empty
  // account rather than as a server that is down.
  if (!anonymous && error && !(api.isApiError(error) && error.status === 401)) {
    return <BootstrapFailure error={error} />;
  }

  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}

/**
 * Sensible values for the moment before the account's own settings land.
 *
 * Not an empty object: `settings.timeDisplay` and `settings.weekStartsOn` are
 * read during the first render of the timesheet, and undefined there formats a
 * duration as "NaN".
 */
const DEFAULT_SETTINGS: Settings = {
  companyName: "",
  companyAddress: "",
  baseCurrency: "USD",
  timezone: "America/New_York",
  weekStartsOn: 1,
  timerMode: "duration",
  timeDisplay: "decimal",
  roundingMinutes: 0,
  requireNotes: "never",
  allowFutureDates: true,
  modules: {},
};

function BootstrapFailure({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : "Something went wrong.";
  const requestId = api.isApiError(error) ? error.requestId : undefined;

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="max-w-md text-center">
        <h1 className="mb-2 text-xl font-semibold text-ink">Tally could not start</h1>
        <p className="mb-4 text-base text-ink-secondary">{message}</p>
        {requestId && (
          <p className="mb-4 font-mono text-sm text-ink-muted">Request {requestId}</p>
        )}
        <button
          className="rounded-md border border-border px-3 py-1.5 text-base text-ink hover:bg-bg-subtle"
          onClick={() => window.location.reload()}
        >
          Try again
        </button>
      </div>
    </div>
  );
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
