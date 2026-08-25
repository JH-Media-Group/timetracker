"use client";

import * as React from "react";
import { Check, ChevronsUpDown, Search } from "lucide-react";
import { cn } from "@/lib/cn";
import { describeTimeZone, isTimeZone, timeZoneOptions, type TimeZoneOption } from "@/lib/timezones";
import { pickerKeyAction } from "@/lib/picker-keys";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  useInsideDialog,
} from "@/components/ui/primitives";
import { inputVariants } from "@/components/ui/recipes";

/**
 * Searchable worldwide IANA timezone picker.
 *
 * The value is a regional identifier, never a frozen offset. That distinction
 * is what lets `America/New_York` move between offsets while
 * `America/Cancun` stays at UTC-05:00 throughout the year.
 */
export function TimeZonePicker({
  value,
  onChange,
  disabled,
  id,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [cursor, setCursor] = React.useState(0);
  const [referenceTime, setReferenceTime] = React.useState(() => new Date());
  const listId = React.useId();
  const insideDialog = useInsideDialog();

  // Building the worldwide list includes checking each zone's monthly
  // offsets. Do that when somebody opens the picker, not on every form mount.
  const options = React.useMemo(
    () => (open ? timeZoneOptions(value, referenceTime) : []),
    [open, value, referenceTime]
  );

  const selected = React.useMemo(
    () => (isTimeZone(value) ? describeTimeZone(value, referenceTime) : null),
    [value, referenceTime]
  );

  const filtered = React.useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return options;
    return options.filter((option) => terms.every((term) => option.searchText.includes(term)));
  }, [options, query]);

  const grouped = React.useMemo(() => {
    const groups = new Map<string, Array<{ option: TimeZoneOption; index: number }>>();
    filtered.forEach((option, index) => {
      const group = groups.get(option.region);
      const item = { option, index };
      if (group) group.push(item);
      else groups.set(option.region, [item]);
    });
    return [...groups.entries()];
  }, [filtered]);

  React.useEffect(() => {
    if (!open) return;
    const selectedIndex = filtered.findIndex((option) => option.id === value);
    setCursor(query ? 0 : Math.max(0, selectedIndex));
  }, [open, query, filtered, value]);

  const choose = (timeZone: string) => {
    onChange(timeZone);
    setOpen(false);
    setQuery("");
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const action = pickerKeyAction(event.key, filtered.length, cursor);
    if (!action.handled) return;
    event.preventDefault();
    event.stopPropagation();
    if (action.cursor !== null) setCursor(action.cursor);
    if (action.choose !== null) {
      const option = filtered[action.choose];
      if (option) choose(option.id);
    }
  };

  const onOpenChange = (next: boolean) => {
    if (next) setReferenceTime(new Date());
    else setQuery("");
    setOpen(next);
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
          className={cn(
            inputVariants(),
            "relative flex h-auto min-h-9 flex-col items-start justify-center gap-0 py-1.5 pr-9 text-left",
            "disabled:cursor-not-allowed",
            className
          )}
        >
          {selected ? (
            <>
              <span className="w-full truncate font-medium leading-tight text-ink">{selected.city}</span>
              <span className="w-full truncate text-sm leading-tight text-ink-tertiary">{selected.id}</span>
            </>
          ) : (
            <span className="text-ink-tertiary">Choose a timezone</span>
          )}
          <ChevronsUpDown
            className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-tertiary"
            aria-hidden
          />
        </button>
      </PopoverTrigger>

      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-[360px] p-0">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Search className="size-4 shrink-0 text-ink-tertiary" aria-hidden />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search city, region, timezone, or UTC offset..."
            className="w-full bg-transparent text-base outline-none placeholder:text-ink-tertiary"
            role="combobox"
            aria-label="Search timezones"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={filtered[cursor] ? `${listId}-${cursor}` : undefined}
          />
        </div>

        <div className="border-b border-border px-3 py-1.5 text-sm text-ink-tertiary" aria-live="polite">
          {filtered.length} {filtered.length === 1 ? "timezone" : "timezones"}
        </div>

        <div
          id={listId}
          role="listbox"
          aria-label="Worldwide timezones"
          className={cn("overflow-y-auto p-1", insideDialog ? "max-h-[220px]" : "max-h-[360px]")}
        >
          {filtered.length === 0 && (
            <div className="px-3 py-6 text-center text-base text-ink-secondary">
              No timezones match &ldquo;{query}&rdquo;.
            </div>
          )}

          {grouped.map(([region, list]) => (
            <div key={region}>
              <div className="sticky top-0 bg-surface px-2 py-1.5 text-xs font-semibold uppercase tracking-[0.06em] text-ink-tertiary">
                {region}
              </div>
              {list.map(({ option, index }) => (
                <TimeZoneRow
                  key={option.id}
                  id={`${listId}-${index}`}
                  option={option}
                  selected={option.id === value}
                  active={index === cursor}
                  onSelect={() => choose(option.id)}
                />
              ))}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function TimeZoneRow({
  id,
  option,
  selected,
  active,
  onSelect,
}: {
  id: string;
  option: TimeZoneOption;
  selected: boolean;
  active: boolean;
  onSelect: () => void;
}) {
  const ref = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <button
      ref={ref}
      id={id}
      role="option"
      aria-selected={selected}
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left",
        "hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none",
        selected && "bg-bg-muted",
        active && "bg-surface-hover"
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="truncate text-base font-medium text-ink">{option.city}</span>
          <span className="shrink-0 text-sm text-ink-tertiary">{option.currentOffset}</span>
        </span>
        <span className="block truncate text-sm text-ink-tertiary">
          {option.id} · {option.changeLabel}
        </span>
      </span>
      {selected && <Check className="size-4 shrink-0 text-ink" aria-hidden />}
    </button>
  );
}
