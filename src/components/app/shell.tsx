"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Bell, Building2, Clock, FileText, FolderOpen, ListChecks, Plus, Receipt,
  Search, Settings as SettingsIcon, Square, Users, BarChart3, Check, Play, PanelLeftClose, PanelLeft,
  LogOut,
} from "lucide-react";
import * as api from "@/lib/api";
import { cn } from "@/lib/cn";
import { ANONYMOUS_PAGES } from "@/lib/anonymous-pages";
import { endSession } from "@/lib/sign-out";
import { useToast } from "@/components/ui/toast";
import { navItemClass, navSectionLabelClass, timerPillVariants, timerReadoutClass } from "@/components/ui/recipes";
import {
  Avatar, Button, Kbd, Menu, MenuItem, MenuLabel, MenuSeparator, Popover,
  PopoverContent, PopoverTrigger, Tooltip,
} from "@/components/ui/primitives";
import { useApp, useCan, useTheme } from "./providers";
import { useTimer } from "./timer";
import { formatClock } from "@/lib/format";
import { CommandPalette, useCommandPalette } from "./command-palette";
import { Logo } from "./logo";
import { QuickTimer } from "./quick-timer";
import { EntryDialog, useEntryDialog } from "./entry-editor";

/* ----------------------------------------------------------------- nav */

interface NavItem { href: string; label: string; icon: React.ElementType; cap?: string }
interface NavSection { label: string; items: NavItem[] }

const SECTIONS: NavSection[] = [
  { label: "Track", items: [
    { href: "/timesheet", label: "Timesheet", icon: Clock },
    { href: "/expenses", label: "Expenses", icon: Receipt },
    { href: "/approvals", label: "Approvals", icon: Check, cap: "approval:review" },
  ]},
  { label: "Organize", items: [
    { href: "/team", label: "Team", icon: Users },
    { href: "/clients", label: "Clients", icon: Building2, cap: "client:view" },
    { href: "/projects", label: "Projects", icon: FolderOpen },
    { href: "/tasks", label: "Tasks", icon: ListChecks, cap: "task:manage" },
  ]},
  { label: "Bill", items: [
    { href: "/invoices", label: "Invoices", icon: FileText, cap: "invoice:view" },
  ]},
  { label: "Review", items: [
    { href: "/reports", label: "Reports", icon: BarChart3 },
  ]},
];

function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const pathname = usePathname();
  const can = useCan();
  const { me } = useApp();

  return (
    <aside
      className={cn(
        "sticky top-(--topbar-h) hidden h-[calc(100vh-var(--topbar-h))] shrink-0 flex-col overflow-y-auto border-r border-border bg-bg-subtle transition-[width] duration-(--dur) md:flex",
        collapsed ? "w-(--sidebar-rail-w) px-2 py-4" : "w-(--sidebar-w) px-3 py-4"
      )}
    >
      <nav className="flex-1">
        {SECTIONS.map((section) => {
          const items = section.items.filter((i) => !i.cap || can(i.cap));
          if (!items.length) return null;
          return (
            <div key={section.label} className="mb-5">
              {!collapsed && <div className={navSectionLabelClass}>{section.label}</div>}
              {items.map((item) => {
                const active = pathname === item.href || pathname.startsWith(item.href + "/");
                const Icon = item.icon;
                return (
                  <Tooltip key={item.href} content={collapsed ? item.label : null} side="right">
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={cn(navItemClass, collapsed && "justify-center px-0")}
                    >
                      <Icon className="size-4 shrink-0" aria-hidden />
                      {!collapsed && <span className="truncate">{item.label}</span>}
                    </Link>
                  </Tooltip>
                );
              })}
            </div>
          );
        })}
      </nav>

      <div className="mt-auto border-t border-border pt-3">
        <Link href="/settings" className={cn(navItemClass, collapsed && "justify-center px-0")}>
          <SettingsIcon className="size-4 shrink-0" aria-hidden />
          {!collapsed && <span>Settings</span>}
        </Link>
        <button onClick={onToggle} className={cn(navItemClass, "w-full", collapsed && "justify-center px-0")}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
          {collapsed ? <PanelLeft className="size-4" /> : <><PanelLeftClose className="size-4" /><span>Collapse</span></>}
        </button>
        {!collapsed && (
          <div className="mt-2 flex items-center gap-2 rounded-md px-2 py-2">
            <Avatar user={me} size="sm" />
            <div className="min-w-0">
              <div className="truncate text-base font-medium text-ink">{me.firstName} {me.lastName}</div>
              <div className="truncate text-sm text-ink-tertiary">JH Media Group</div>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------- top bar */

function TimerWidget() {
  const { running, elapsed, stop, isBusy, unreachable } = useTimer();
  const { projectById, taskById, clientById } = useApp();
  const [open, setOpen] = React.useState(false);

  const project = running ? projectById.get(running.projectId) : undefined;
  const task = running ? taskById.get(running.taskId) : undefined;
  const client = project ? clientById.get(project.clientId) : undefined;

  if (unreachable) {
    // Not "no timer": we do not know. Saying so is the difference between
    // somebody starting a second timer over the first and somebody retrying.
    return (
      <Tooltip content="Cannot reach the server, so the timer state is unknown. It will reconnect on its own.">
        <span className={timerPillVariants({ state: "idle" })} data-testid="timer-unreachable">
          <Clock className="size-3.5" aria-hidden />
          Timer unavailable
        </span>
      </Tooltip>
    );
  }

  if (!running) {
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button className={timerPillVariants({ state: "idle" })} data-testid="timer-start">
            <Clock className="size-3.5" aria-hidden />
            Start timer
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-[360px]"><QuickTimer onDone={() => setOpen(false)} /></PopoverContent>
      </Popover>
    );
  }

  return (
    <div className="flex min-w-0 items-center gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button className={timerPillVariants({ state: "running" })} data-testid="timer-running">
            <span className="size-1.5 rounded-full bg-live animate-pulse-live" aria-hidden />
            <span className={timerReadoutClass}>{formatClock(elapsed)}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-[360px]"><QuickTimer onDone={() => setOpen(false)} /></PopoverContent>
      </Popover>

      <Tooltip content="Stop timer">
        <Button variant="secondary" size="icon-sm" aria-label="Stop timer" disabled={isBusy}
          onClick={() => { if (running) void stop(running.userId); }} data-testid="timer-stop">
          <Square className="size-3 fill-current" />
        </Button>
      </Tooltip>

      <div className="hidden min-w-0 text-base text-ink-secondary lg:block">
        <span className="truncate">{task?.name}</span>
        <span className="mx-1.5 text-ink-tertiary" aria-hidden>·</span>
        <span className="truncate text-ink-tertiary">{client?.name}</span>
      </div>
    </div>
  );
}

function TopBar() {
  const palette = useCommandPalette();
  const entry = useEntryDialog();
  const { me } = useApp();
  const { theme, setTheme } = useTheme();
  const router = useRouter();
  const toast = useToast();

  /*
    Ending your own session.

    There was no way to do this at all. Settings has "sign out everywhere",
    which revokes every session on every device, and that is a different act:
    somebody finishing their shift on a shared machine wants this one, and
    reaching for the only control that existed would have logged out their
    phone as well.

    `window.location` rather than `router.push`, deliberately. A client-side
    navigation keeps the React Query cache alive, so the next person at the
    keyboard would be looking at the previous person's bootstrap, their roster,
    and whatever money their profile could see, until something happened to
    refetch it. A full document load is what actually discards it.

    The rule about what happens when the request fails lives in
    `src/lib/sign-out.ts`, with the reasoning and a test: the session is only
    over if the server said so, so a failure is reported here rather than
    redirected past.
  */
  const signOut = async () => {
    const failure = await endSession({
      signOut: api.signOut,
      leave: () => window.location.assign("/signin"),
    });
    if (failure) toast.push({ tone: "danger", title: failure });
  };

  return (
    <header data-print="hide" className="sticky top-0 z-(--z-sticky) flex h-(--topbar-h) items-center justify-between gap-3 border-b border-border bg-bg/85 px-4 backdrop-blur-md backdrop-saturate-150">
      <div className="flex min-w-0 items-center gap-2">
        <Link href="/timesheet" className="mr-2 hidden shrink-0 items-center md:flex" aria-label="Tally home">
          <Logo height={22} />
        </Link>
        <TimerWidget />
        <Menu trigger={<Button variant="secondary" size="icon-sm" aria-label="Create new"><Plus className="size-4" /></Button>} align="start">
          <MenuItem onSelect={() => entry.open({})} shortcut="N">New time entry</MenuItem>
          <MenuItem onSelect={() => router.push("/expenses?new=1")} shortcut="E">New expense</MenuItem>
          <MenuSeparator />
          <MenuItem onSelect={() => router.push("/projects/new")}>New project</MenuItem>
          <MenuItem onSelect={() => router.push("/clients/new")}>New client</MenuItem>
          <MenuItem onSelect={() => router.push("/invoices?new=1")}>New invoice</MenuItem>
        </Menu>
      </div>

      <button
        onClick={palette.open}
        className="hidden h-[30px] w-full max-w-[440px] items-center gap-2 rounded-md border border-transparent bg-bg-muted px-2.5 text-base text-ink-tertiary transition-colors hover:border-border md:flex"
      >
        <Search className="size-3.5" aria-hidden />
        <span className="truncate">Search projects, people, invoices…</span>
        <span className="ml-auto"><Kbd>⌘K</Kbd></span>
      </button>

      <div className="flex shrink-0 items-center gap-1">
        <Button variant="ghost" size="icon-sm" aria-label="Search" className="md:hidden" onClick={palette.open}>
          <Search className="size-4" />
        </Button>
        <Menu trigger={<Button variant="ghost" size="icon-sm" aria-label="Notifications"><Bell className="size-4" /></Button>}>
          <MenuLabel>Notifications</MenuLabel>
          <div className="px-2 py-6 text-center text-base text-ink-secondary">You are all caught up.</div>
        </Menu>
        <Menu trigger={<button className="rounded-full focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2" aria-label="Account menu"><Avatar user={me} size="md" /></button>}>
          <div className="flex items-center gap-2 px-2 py-2">
            <Avatar user={me} size="lg" />
            <div className="min-w-0">
              <div className="truncate font-medium text-ink">{me.firstName} {me.lastName}</div>
              <div className="truncate text-sm text-ink-tertiary">{me.email}</div>
            </div>
          </div>
          <MenuSeparator />
          <MenuItem onSelect={() => router.push(`/team/${me.id}`)}>My profile</MenuItem>
          <MenuItem onSelect={() => router.push(`/reports?user=${me.id}`)}>My time report</MenuItem>
          <MenuSeparator />
          <MenuLabel>Theme</MenuLabel>
          {(["system", "light", "dark"] as const).map((t) => (
            <MenuItem key={t} onSelect={() => setTheme(t)}>
              <span className="capitalize">{t}</span>
              {theme === t && <Check className="ml-auto size-4" strokeWidth={3} />}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem onSelect={() => palette.openShortcuts()} shortcut="?">Keyboard shortcuts</MenuItem>
          <MenuSeparator />
          <MenuItem onSelect={signOut}>
            <LogOut className="size-4" aria-hidden />
            Sign out
          </MenuItem>
        </Menu>
      </div>
    </header>
  );
}

/* ------------------------------------------------------------ mobile nav */

function MobileTabs() {
  const pathname = usePathname();
  const can = useCan();
  const items = [
    { href: "/timesheet", label: "Track", icon: Clock },
    ...(can("approval:review") ? [{ href: "/approvals", label: "Approvals", icon: Check }] : []),
    { href: "/projects", label: "Projects", icon: FolderOpen },
    { href: "/reports", label: "Reports", icon: BarChart3 },
    { href: "/settings", label: "More", icon: SettingsIcon },
  ];
  return (
    <nav className="fixed inset-x-0 bottom-0 z-(--z-sticky) flex h-14 items-stretch border-t border-border bg-bg md:hidden">
      {items.map((i) => {
        const active = pathname.startsWith(i.href);
        const Icon = i.icon;
        return (
          <Link key={i.href} href={i.href}
            className={cn("flex flex-1 flex-col items-center justify-center gap-0.5 text-xs",
              active ? "text-ink" : "text-ink-tertiary")}>
            <Icon className="size-5" aria-hidden />
            {i.label}
          </Link>
        );
      })}
    </nav>
  );
}

/* ---------------------------------------------------------------- shell */

/**
 * Routes that render on their own, without the shell.
 *
 * Sign-in has no navigation to show and no session to build it from, so
 * wrapping it in the app chrome would render a sidebar full of links that all
 * bounce back here.
 */
const BARE_ROUTES = ANONYMOUS_PAGES;

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (BARE_ROUTES.some((r) => pathname.startsWith(r))) return <>{children}</>;
  return <AppShellChrome>{children}</AppShellChrome>;
}

function AppShellChrome({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = React.useState(false);
  const palette = useCommandPalette();
  const entry = useEntryDialog();
  const { running, stop } = useTimer();
  const router = useRouter();

  React.useEffect(() => {
    try { setCollapsed(localStorage.getItem("tally-sidebar") === "collapsed"); } catch { /* ignore */ }
  }, []);
  const toggle = () => setCollapsed((c) => {
    const next = !c;
    try { localStorage.setItem("tally-sidebar", next ? "collapsed" : "open"); } catch { /* ignore */ }
    return next;
  });

  // Global shortcuts. Suppressed while typing, so a "t" in a note is just a "t".
  React.useEffect(() => {
    let gPending = false;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable || el.tagName === "SELECT");

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); palette.open(); return; }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;

      if (gPending) {
        gPending = false;
        const map: Record<string, string> = {
          t: "/timesheet", e: "/expenses", p: "/projects", c: "/clients",
          i: "/invoices", r: "/reports", m: "/team", a: "/approvals",
        };
        const dest = map[e.key.toLowerCase()];
        if (dest) { e.preventDefault(); router.push(dest); }
        return;
      }
      if (e.key === "g") { gPending = true; window.setTimeout(() => { gPending = false; }, 1200); return; }
      if (e.key === "?") { e.preventDefault(); palette.openShortcuts(); return; }
      if (e.key.toLowerCase() === "t") { e.preventDefault(); if (running) void stop(running.userId); else palette.openTimer(); return; }
      if (e.key.toLowerCase() === "n") { e.preventDefault(); entry.open({}); return; }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [palette, entry, router, running, stop]);

  return (
    <div className="min-h-screen bg-bg">
      <TopBar />
      <div className="flex">
        <Sidebar collapsed={collapsed} onToggle={toggle} />
        <main className="min-w-0 flex-1 pb-14 md:pb-0">{children}</main>
      </div>
      <MobileTabs />
      <CommandPalette />
      <EntryDialog />
    </div>
  );
}
