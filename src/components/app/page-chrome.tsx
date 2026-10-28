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
import { Button, Field, Input, Popover, PopoverContent, PopoverTrigger, Segmented } from "@/components/ui/primitives";
import { dateRangeError, isCalendarDate, readPeriod, resolvePeriod, stepPeriod, periodUrlPatch, type CalendarGranularity, type DateRange, type Granularity } from "@/lib/period";

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
    <div className="sticky top-(--topbar-h) z-(--z-sticky) border-b border-border bg-bg/85 backdrop-blur-md backdrop-saturate-150 print:static print:border-0 print:bg-transparent print:backdrop-blur-none">
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
          {/* The buttons are chrome, not document. An invoice printed with an
              "Actions" menu across the top is not a document you send. */}
          {actions && <div data-print="hide" className="flex flex-wrap items-center gap-2">{actions}</div>}
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

export { resolvePeriod, stepPeriod } from "@/lib/period";
export type { Granularity, Period } from "@/lib/period";

const GRANULARITIES: { value: Granularity; label: string }[] = [
  { value: "day", label: "Day" }, { value: "week", label: "Week" },
  { value: "month", label: "Month" }, { value: "quarter", label: "Quarter" },
  { value: "year", label: "Year" }, { value: "all", label: "All time" },
];

export function PeriodPicker({
  granularity, anchor, onChange, allowed, custom,
}: {
  granularity: Granularity; anchor: Date;
  onChange: (g: Granularity, anchor: Date) => void;
  allowed?: Granularity[];
  custom?: DateRange & { onChange: (range: DateRange) => void };
}) {
  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [range, setRange] = React.useState<DateRange>({ from: "", to: "" });
  const changeRange = (field: keyof DateRange, value: string) => setRange((r) => ({ ...r, [field]: value }));
  const rangeId = React.useId();
  const rangeStartRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => { if (editing) rangeStartRef.current?.focus(); }, [editing]);
  const rangeError = dateRangeError(range);
  const period = resolvePeriod(granularity, anchor, custom);
  const options = allowed ? GRANULARITIES.filter((g) => allowed.includes(g.value)) : GRANULARITIES;
  const stepless = granularity === "all" || granularity === "custom";

  return (
    <div className="flex items-center gap-1">
      <Button variant="secondary" size="icon-sm" aria-label="Previous period" disabled={stepless}
        onClick={() => onChange(granularity, stepPeriod(granularity, anchor, -1))}>
        <ChevronLeft className="size-4" />
      </Button>

      <Popover open={open} onOpenChange={(value) => {
        setOpen(value);
        if (value) { setEditing(false); setRange({ from: period.from, to: period.to }); }
      }}>
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
              aria-pressed={g.value === granularity}
              onClick={() => { onChange(g.value, anchor); setOpen(false); }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-base hover:bg-surface-hover"
            >
              {g.label}
              {g.value === granularity && <Check className="ml-auto size-4" strokeWidth={3} />}
            </button>
          ))}
          {custom && (
            <>
              <button type="button"
                aria-pressed={granularity === "custom"}
                aria-expanded={editing} aria-controls={editing ? `${rangeId}-fields` : undefined}
                onClick={() => setEditing(true)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-base hover:bg-surface-hover">
                Custom range
                {granularity === "custom" && <Check className="ml-auto size-4" strokeWidth={3} />}
              </button>
              {editing && (
                <div id={`${rangeId}-fields`} className="flex flex-col gap-2 border-t border-border p-2">
                  <Field label="Start date" htmlFor={`${rangeId}-from`}>
                    <Input ref={rangeStartRef} id={`${rangeId}-from`} type="date" min="1000-01-01" max="9999-12-31"
                      aria-invalid={!isCalendarDate(range.from)} aria-describedby={rangeError ? `${rangeId}-error` : undefined}
                      value={range.from} onChange={(e) => changeRange("from", e.target.value)} />
                  </Field>
                  <Field label="End date" htmlFor={`${rangeId}-to`}>
                    <Input id={`${rangeId}-to`} type="date" min={range.from || "1000-01-01"} max="9999-12-31"
                      aria-invalid={!isCalendarDate(range.to) || range.from > range.to} aria-describedby={rangeError ? `${rangeId}-error` : undefined}
                      value={range.to} onChange={(e) => changeRange("to", e.target.value)} />
                  </Field>
                  {rangeError && <div id={`${rangeId}-error`} className="text-sm text-danger" role="alert">{rangeError}</div>}
                  <Button type="button" size="sm" disabled={!!rangeError}
                    onClick={() => { custom.onChange(range); setOpen(false); }}>
                    Apply range
                  </Button>
                </div>
              )}
            </>
          )}
          <div className="my-1.5 h-px bg-border" />
          <button
            onClick={() => { onChange(granularity === "custom" ? "month" : granularity, new Date()); setOpen(false); }}
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
export function usePeriod(defaultGranularity: CalendarGranularity = "week", allowed?: Granularity[]) {
  const { params, set } = useUrlState();
  const selection = readPeriod(params, defaultGranularity, allowed);
  const onChange = (ng: Granularity, na: Date) => set(periodUrlPatch(ng, na));
  const onCustomChange = (range: DateRange) => set(periodUrlPatch("custom", selection.anchor, range));
  return { ...selection, onChange, onCustomChange, allowed };
}

export { Segmented };
