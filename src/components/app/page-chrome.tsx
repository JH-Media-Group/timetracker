"use client";

/**
 * Page chrome: the three-band header every page uses, plus the period picker.
 *
 * Band 1 is the title and primary actions and is sticky. Band 2 is tabs. Band 3
 * is the toolbar, which scrolls away. Filter state lives in the URL so any view
 * is linkable and survives a refresh.
 */

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight, Calendar as CalIcon, Check } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button, Popover, PopoverContent, PopoverTrigger, Segmented } from "@/components/ui/primitives";
import {
  addDays, addMonths, endOfMonth, formatDayLong, formatMonthYear, formatWeekRange,
  isoDate, startOfMonth, startOfWeek, toDate,
} from "@/lib/format";

/* ------------------------------------------------------------ URL state */

export function useUrlState() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const set = React.useCallback((patch: Record<string, string | null | undefined>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === "") next.delete(k); else next.set(k, v);
    }
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  }, [params, pathname, router]);

  return { params, set };
}

/* --------------------------------------------------------------- header */

export function PageHeader({
  title, breadcrumb, badge, actions, children,
}: {
  title: React.ReactNode;
  breadcrumb?: { label: string; href?: string }[];
  badge?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;   // the tab band
}) {
  return (
    <div className="sticky top-(--topbar-h) z-(--z-sticky) border-b border-border bg-bg/85 backdrop-blur-md backdrop-saturate-150">
      <div className="px-6 pt-5">
        {breadcrumb && breadcrumb.length > 0 && (
          <nav className="mb-1 flex items-center gap-1.5 text-base text-ink-secondary" aria-label="Breadcrumb">
            {breadcrumb.map((b, i) => (
              <React.Fragment key={i}>
                {i > 0 && <span className="text-ink-tertiary" aria-hidden>›</span>}
                {b.href ? <Link href={b.href} className="hover:text-ink hover:underline">{b.label}</Link> : <span>{b.label}</span>}
              </React.Fragment>
            ))}
          </nav>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3 pb-4">
          <div className="flex min-w-0 items-center gap-3">
            <h1 className="truncate text-2xl font-semibold tracking-(--ls-tight) text-ink">{title}</h1>
            {badge}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
        {children}
      </div>
    </div>
  );
}

export function Toolbar({ left, right, className }: { left?: React.ReactNode; right?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-3 px-6 py-4", className)}>
      <div className="flex flex-wrap items-center gap-2">{left}</div>
      <div className="flex flex-wrap items-center gap-2">{right}</div>
    </div>
  );
}

export function PageBody({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("mx-auto w-full max-w-(--content-max) px-6 pb-16", className)}>{children}</div>;
}

/* -------------------------------------------------------- period picker */

export type Granularity = "day" | "week" | "month" | "quarter" | "year" | "all";

export interface Period { granularity: Granularity; from: string; to: string; label: string }

export function resolvePeriod(granularity: Granularity, anchor: Date): Period {
  switch (granularity) {
    case "day":
      return { granularity, from: isoDate(anchor), to: isoDate(anchor), label: formatDayLong(anchor) };
    case "week": {
      const s = startOfWeek(anchor);
      return { granularity, from: isoDate(s), to: isoDate(addDays(s, 6)), label: formatWeekRange(s) };
    }
    case "month": {
      const s = startOfMonth(anchor);
      return { granularity, from: isoDate(s), to: isoDate(endOfMonth(anchor)), label: formatMonthYear(anchor) };
    }
    case "quarter": {
      const q = Math.floor(anchor.getMonth() / 3);
      const s = new Date(anchor.getFullYear(), q * 3, 1);
      const e = new Date(anchor.getFullYear(), q * 3 + 3, 0);
      return { granularity, from: isoDate(s), to: isoDate(e), label: `Q${q + 1} ${anchor.getFullYear()}` };
    }
    case "year": {
      const s = new Date(anchor.getFullYear(), 0, 1);
      const e = new Date(anchor.getFullYear(), 11, 31);
      return { granularity, from: isoDate(s), to: isoDate(e), label: String(anchor.getFullYear()) };
    }
    default:
      return { granularity: "all", from: "1970-01-01", to: "2999-12-31", label: "All time" };
  }
}

export function stepPeriod(granularity: Granularity, anchor: Date, dir: -1 | 1): Date {
  switch (granularity) {
    case "day": return addDays(anchor, dir);
    case "week": return addDays(anchor, 7 * dir);
    case "month": return addMonths(anchor, dir);
    case "quarter": return addMonths(anchor, 3 * dir);
    case "year": return addMonths(anchor, 12 * dir);
    default: return anchor;
  }
}

const GRANULARITIES: { value: Granularity; label: string }[] = [
  { value: "day", label: "Day" }, { value: "week", label: "Week" },
  { value: "month", label: "Month" }, { value: "quarter", label: "Quarter" },
  { value: "year", label: "Year" }, { value: "all", label: "All time" },
];

export function PeriodPicker({
  granularity, anchor, onChange, allowed,
}: {
  granularity: Granularity; anchor: Date;
  onChange: (g: Granularity, anchor: Date) => void;
  allowed?: Granularity[];
}) {
  const [open, setOpen] = React.useState(false);
  const period = resolvePeriod(granularity, anchor);
  const options = allowed ? GRANULARITIES.filter((g) => allowed.includes(g.value)) : GRANULARITIES;
  const stepless = granularity === "all";

  return (
    <div className="flex items-center gap-1">
      <Button variant="secondary" size="icon-sm" aria-label="Previous period" disabled={stepless}
        onClick={() => onChange(granularity, stepPeriod(granularity, anchor, -1))}>
        <ChevronLeft className="size-4" />
      </Button>

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="secondary" size="sm" className="gap-2 font-normal">
            <CalIcon className="size-3.5 text-ink-tertiary" aria-hidden />
            <span className="font-medium">{period.label}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[240px] p-1.5">
          <div className="px-1.5 pb-1.5 text-xs font-semibold uppercase tracking-[0.06em] text-ink-tertiary">Range</div>
          {options.map((g) => (
            <button
              key={g.value}
              onClick={() => { onChange(g.value, anchor); setOpen(false); }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-base hover:bg-surface-hover"
            >
              {g.label}
              {g.value === granularity && <Check className="ml-auto size-4" strokeWidth={3} />}
            </button>
          ))}
          <div className="my-1.5 h-px bg-border" />
          <button
            onClick={() => { onChange(granularity, new Date()); setOpen(false); }}
            className="flex w-full items-center rounded-md px-2 py-1.5 text-base hover:bg-surface-hover"
          >
            Jump to today
          </button>
        </PopoverContent>
      </Popover>

      <Button variant="secondary" size="icon-sm" aria-label="Next period" disabled={stepless}
        onClick={() => onChange(granularity, stepPeriod(granularity, anchor, 1))}>
        <ChevronRight className="size-4" />
      </Button>
    </div>
  );
}

/** Reads the period from the URL, so every filtered view is shareable. */
export function usePeriod(defaultGranularity: Granularity = "week", allowed?: Granularity[]) {
  const { params, set } = useUrlState();
  const g = (params.get("g") as Granularity) || defaultGranularity;
  const dateParam = params.get("date");
  const anchor = dateParam ? toDate(dateParam) : new Date();
  const period = resolvePeriod(g, anchor);
  const onChange = (ng: Granularity, na: Date) => set({ g: ng, date: isoDate(na) });
  return { granularity: g, anchor, period, onChange, allowed };
}

export { Segmented };
