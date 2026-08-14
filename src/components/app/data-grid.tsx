"use client";

/**
 * DataGrid: the one table component.
 *
 * Owns everything a table needs and is not worth rebuilding per page: the card
 * frame, the fixed-height action row with its browse / select / act layers, the
 * column picker, density, the pinned totals row, and the empty and loading
 * states.
 *
 * THE NO-SHIFT RULE
 * The action row is always in the layout at --action-row-h, whatever it is
 * showing. Ticking a checkbox changes the row's background and nothing else.
 * See docs/FRONTEND_PRD.md section 4.4.
 */

import * as React from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, ColTypeDef, GridApi, GridReadyEvent, ICellRendererParams, RowClassParams, RowHeightParams } from "ag-grid-community";
import { Columns3, Download, X } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  actionEndClass, actionRowClass, actionRowLayerVariants, actionSeparatorClass,
  selectionCountClass, tableFrameClass,
} from "@/components/ui/recipes";
import { Button, Checkbox, Popover, PopoverContent, PopoverTrigger, Segmented, Skeleton } from "@/components/ui/primitives";
import { createColumnTypes, createDefaultGridOptions, registerGridModules, type GridRow } from "@/components/ui/grid";
import { tallyCompactGridTheme, tallyGridTheme } from "@/styles/ag-grid-theme";
import { formatDateUS, formatDuration, formatMoney, formatPercent } from "@/lib/format";
import { useApp } from "@/components/app/providers";

registerGridModules();

export interface BulkAction {
  key: string;
  label: string;
  intent?: "default" | "danger";
  /** How the action collects input. This is a layout decision, not a preference:
   *  the action row's height is fixed, so anything larger than one row is a modal. */
  input: "immediate" | "inline" | "modal";
  inlineLabel?: string;
  inlinePlaceholder?: string;
  run: (rows: unknown[], value?: string) => void | Promise<void>;
  end?: boolean;               // renders at the trailing edge, with removal actions
}

export interface DataGridProps<T> {
  rows: GridRow<T>[] | undefined;
  columns: ColDef[];
  tableId: string;
  loading?: boolean;
  empty?: React.ReactNode;
  totals?: Record<string, unknown>;
  totalsSpanAllPages?: boolean;
  selectable?: boolean;
  bulkActions?: BulkAction[];
  onRowOpen?: (row: T) => void;
  filters?: React.ReactNode;
  /**
   * Overrides the built-in CSV export.
   *
   * The default writes what is on screen: the visible columns in their current
   * order, the rows after filtering and sorting, and the totals row. Pass this
   * only when the export has to come from the server, which is the case when a
   * list is paginated and the file must cover more than the page.
   */
  onExport?: () => void;
  label: string;
  /**
   * The grid's minimum height when it fills, or its exact height when it does not.
   */
  height?: number | string;
  /**
   * Stretch to the bottom of the window (TALLY-7).
   *
   * On by default, because the common case is a page's main table and a short
   * list used to leave half a screen of nothing under it. A page looks the same
   * whether it holds four rows or four hundred.
   *
   * The escape hatch is for a grid embedded in a card beside other content,
   * where a fixed short height is the point. Nothing passes it today: every
   * DataGrid in the app is a page main table. The short lists on the client and
   * person pages are plain markup rather than grids, which is why they are not
   * affected by this at all.
   */
  fill?: boolean;
  density?: "comfortable" | "compact";
}

/** `PageBody`'s bottom padding (`pb-16`), so filling does not create a scrollbar. */
const BOTTOM_GAP = 64;

export function DataGrid<T extends object>({
  rows, columns, tableId, loading, empty, totals, totalsSpanAllPages,
  selectable, bulkActions = [], onRowOpen, filters, onExport, label,
  height = 520, fill = true, density: densityProp,
}: DataGridProps<T>) {
  const frameRef = React.useRef<HTMLDivElement>(null);
  const [api, setApi] = React.useState<GridApi | null>(null);
  const [selected, setSelected] = React.useState<T[]>([]);
  const [acting, setActing] = React.useState<BulkAction | null>(null);
  const [actValue, setActValue] = React.useState("");
  const [hidden, setHidden] = React.useState<string[]>([]);

  /**
   * Writes the grid to CSV.
   *
   * What is on screen is what lands in the file, which is the only version of
   * "export" that does not need explaining: same columns, same order, same
   * filters, same sort. The totals row goes with it, because a spreadsheet of
   * hours whose total has to be recomputed by hand is a spreadsheet nobody
   * trusts.
   */
  const exportCsv = React.useCallback(() => {
    if (!api) return;
    const stamp = new Date().toISOString().slice(0, 10);
    api.exportDataAsCsv({
      fileName: `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${stamp}.csv`,
      allColumns: false,
      skipPinnedBottom: false,
      // Two jobs. Cell renderers return React elements, which stringify to
      // "[object Object]", so the formatted value is what the file gets. And a
      // cell that starts with = + - or @ is a formula to Excel, which will run
      // it on open: notes, descriptions and client names are all free text
      // somebody else typed, so every one of them is prefixed.
      processCellCallback: (p) => {
        const text = p.value == null ? "" : p.formatValue ? p.formatValue(p.value) : String(p.value);
        return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
      },
    });
  }, [api, label]);
  const [density, setDensity] = React.useState<"comfortable" | "compact">(densityProp ?? "comfortable");

  // Column visibility and density persist per user per table.
  React.useEffect(() => {
    try {
      const raw = localStorage.getItem(`tally-table-${tableId}`);
      if (raw) {
        const s = JSON.parse(raw);
        if (Array.isArray(s.hidden)) setHidden(s.hidden);
        if (s.density) setDensity(s.density);
      }
    } catch { /* ignore */ }
  }, [tableId]);
  const persist = (next: { hidden?: string[]; density?: string }) => {
    try {
      const cur = JSON.parse(localStorage.getItem(`tally-table-${tableId}`) ?? "{}");
      localStorage.setItem(`tally-table-${tableId}`, JSON.stringify({ ...cur, ...next }));
    } catch { /* ignore */ }
  };

  const gridOptions = React.useMemo(() => createDefaultGridOptions<T>(), []);

  /**
   * Selection, from the one API that owns it (TALLY-40).
   *
   * `selectable` decides whether the column exists at all, which the defaults
   * cannot know. `selectionColumnDef` carries the width and pinning the
   * hand-built column used to provide, so the first data column does not shift.
   */
  const rowSelection = React.useMemo(
    () => (selectable ? gridOptions.rowSelection : undefined),
    [selectable, gridOptions]
  );

  const selectionColumnDef = React.useMemo(
    () => ({
      width: 44,
      minWidth: 44,
      maxWidth: 44,
      pinned: "left" as const,
      resizable: false,
      suppressMovable: true,
      suppressHeaderMenuButton: true,
    }),
    []
  );

  /* Column types are built here rather than in the design system because how a
     duration renders is an account setting and how money renders depends on the
     row's currency. `type: "money"` on a column is what pulls these in. */
  const { settings } = useApp();
  const columnTypes = React.useMemo(() => {
    /* Each formatter passes a non-matching value straight through. The totals
       row puts its "Total" label in whichever column comes first, which is
       often a typed one, and a date formatter handed the word Total should
       print Total, not NaN/NaN/NaN. */
    const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
    const passthrough = (v: unknown) => (v == null ? "" : String(v));

    const types = createColumnTypes({
      money: (cents, currency) => (num(cents) ? formatMoney(cents, currency) : passthrough(cents)),
      duration: (seconds) => (num(seconds) ? formatDuration(seconds, settings.timeDisplay) : passthrough(seconds)),
      percent: (fraction) => (num(fraction) ? formatPercent(fraction) : passthrough(fraction)),
      date: (iso) => (typeof iso === "string" && /^\d{4}-\d{2}-\d{2}/.test(iso) ? formatDateUS(iso) : passthrough(iso)),
    });
    // Filters live in the action row, not in column headers, so the header
    // filter icon would open something this app does not use.
    return Object.fromEntries(
      Object.entries(types).map(([k, v]) => [k, { ...v, filter: false }])
    ) as Record<string, ColTypeDef<GridRow<T>>>;
  }, [settings.timeDisplay]);

  const cols = React.useMemo<ColDef[]>(() => {
    /* Custom cell renderers never run on the pinned totals row. A meter, a
       badge, or an avatar stack means nothing on a sum, and a renderer that
       reads a field the totals object does not carry would draw an empty
       control rather than an empty cell. The totals row falls back to the
       column's formatter. */
    const base = columns.map((c) => {
      const hide = hidden.includes(String(c.colId ?? c.field));
      const inner = c.cellRenderer as ((p: ICellRendererParams) => React.ReactNode) | undefined;
      if (typeof inner !== "function") return { ...c, hide };
      return {
        ...c, hide,
        cellRenderer: (p: ICellRendererParams) =>
          p.node?.rowPinned ? <>{p.valueFormatted ?? p.value ?? ""}</> : inner(p),
      };
    });
    /**
     * No hand-built selection column (TALLY-40).
     *
     * `rowSelection.checkboxes` in `createDefaultGridOptions` already renders
     * one, and that is the current AG Grid API. This used to prepend a second
     * `__select` column using the older `checkboxSelection` API, and on v34
     * both are honoured: one selection, drawn twice, so ticking either box
     * ticked the other. Width and pinning now come from `selectionColumnDef`.
     */
    return base;
  }, [columns, hidden]);

  const layer: "browse" | "select" | "act" = acting ? "act" : selected.length ? "select" : "browse";

  const clear = () => { api?.deselectAll(); setSelected([]); setActing(null); };

  const runAction = async (action: BulkAction, value?: string) => {
    await action.run(selected, value);
    clear();
  };

  const modifyActions = bulkActions.filter((a) => !a.end);
  const endActions = bulkActions.filter((a) => a.end);

  // Escape steps act -> select rather than clearing the whole selection.
  React.useEffect(() => {
    if (!acting) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setActing(null); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [acting]);

  const showEmpty = !loading && rows && rows.length === 0;

  /**
   * How much window is left below the grid's top edge.
   *
   * Measured from the frame's position in the **document**, not the viewport, so
   * scrolling does not change the answer. Measuring `rect.top` alone would grow
   * the grid as the page scrolls, which grows the page, which scrolls further.
   *
   * `BOTTOM_GAP` matches `PageBody`'s bottom padding, so a filled grid reaches
   * the bottom of the window without pushing a scrollbar into existence.
   */
  const [room, setRoom] = React.useState<number | null>(null);

  React.useLayoutEffect(() => {
    if (!fill) return;
    const el = frameRef.current;
    if (!el) return;

    const measure = () => {
      const documentTop = el.getBoundingClientRect().top + window.scrollY;
      setRoom(window.innerHeight - documentTop - BOTTOM_GAP);
    };

    measure();
    window.addEventListener("resize", measure);

    // Anything above the grid changing size moves it: a filter wrapping to a
    // second line, KPI cards loading, the sidebar collapsing.
    const observer = new ResizeObserver(measure);
    observer.observe(document.body);

    return () => {
      window.removeEventListener("resize", measure);
      observer.disconnect();
    };
  }, [fill]);

  /**
   * The height the frame actually takes.
   *
   * Filling grids take whatever room is left, never less than `height`, so a
   * grid pushed down a long page still has a usable size. Non-filling grids
   * take `height` exactly.
   */
  const frameHeight = React.useMemo(() => {
    if (!fill || typeof height !== "number") return height;
    return room == null ? height : Math.max(height, Math.round(room));
  }, [fill, height, room]);

  return (
    <div
      ref={frameRef}
      className={cn(tableFrameClass, "w-full")}
      style={{ height: showEmpty ? undefined : frameHeight }}
    >
      {/* The action row. Always present, always --action-row-h tall. */}
      <div className={actionRowClass} data-layer={layer}>
        <div className={actionRowLayerVariants({ active: layer === "browse" })}>
          <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto scrollbar-none">{filters}</div>
          <div className={cn(actionEndClass, "flex items-center gap-1")}>
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="sm"><Columns3 className="size-3.5" />Columns</Button>
              </PopoverTrigger>
              <PopoverContent className="w-[230px] p-2">
                <div className="mb-1.5 px-1 text-xs font-semibold uppercase tracking-[0.06em] text-ink-tertiary">Columns</div>
                {columns.filter((c) => c.headerName).map((c) => {
                  const id = String(c.colId ?? c.field);
                  const visible = !hidden.includes(id);
                  return (
                    <label key={id} className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1.5 text-base hover:bg-surface-hover">
                      <Checkbox checked={visible} onCheckedChange={(v) => {
                        const next = v ? hidden.filter((h) => h !== id) : [...hidden, id];
                        setHidden(next); persist({ hidden: next });
                      }} />
                      {c.headerName}
                    </label>
                  );
                })}
                <div className="my-1.5 h-px bg-border" />
                <div className="px-1 pb-1 text-xs font-semibold uppercase tracking-[0.06em] text-ink-tertiary">Density</div>
                <div className="px-1">
                  <Segmented
                    value={density}
                    onChange={(d) => { setDensity(d); persist({ density: d }); }}
                    options={[{ value: "comfortable", label: "Comfortable" }, { value: "compact", label: "Compact" }]}
                    aria-label="Row density"
                  />
                </div>
              </PopoverContent>
            </Popover>
            {/* Off when there is nothing to write. An enabled button that
                produces no file reads as broken rather than as empty. */}
            <Button
              variant="ghost"
              size="sm"
              onClick={onExport ?? exportCsv}
              disabled={!onExport && (!api || showEmpty)}
              title={showEmpty ? "Nothing to export yet." : undefined}
            >
              <Download className="size-3.5" />Export
            </Button>
          </div>
        </div>

        <div className={actionRowLayerVariants({ active: layer === "select" })}>
          <span className={selectionCountClass}>{selected.length} selected</span>
          <Button variant="ghost" size="sm" onClick={clear}>Clear</Button>
          {modifyActions.length > 0 && <span className={actionSeparatorClass} />}
          <div className="flex items-center gap-2 overflow-x-auto scrollbar-none">
            {modifyActions.map((a) => (
              <Button key={a.key} variant="secondary" size="sm"
                onClick={() => { if (a.input === "inline") { setActing(a); setActValue(""); } else runAction(a); }}>
                {a.label}
              </Button>
            ))}
          </div>
          {endActions.length > 0 && (
            <div className={cn(actionEndClass, "flex items-center gap-2")}>
              {endActions.map((a, i) => (
                <React.Fragment key={a.key}>
                  {i > 0 && <span className={actionSeparatorClass} />}
                  <Button variant={a.intent === "danger" ? "danger-ghost" : "secondary"} size="sm"
                    onClick={() => { if (a.input === "inline") { setActing(a); setActValue(""); } else runAction(a); }}>
                    {a.label}
                  </Button>
                </React.Fragment>
              ))}
            </div>
          )}
        </div>

        <div className={actionRowLayerVariants({ active: layer === "act" })}>
          <Button variant="ghost" size="icon-sm" aria-label="Back to selection" onClick={() => setActing(null)}>
            <X className="size-4" />
          </Button>
          <span className="whitespace-nowrap text-ink-tertiary">{acting?.inlineLabel ?? acting?.label}</span>
          <input
            autoFocus value={actValue} onChange={(e) => setActValue(e.target.value)}
            placeholder={acting?.inlinePlaceholder}
            className="h-7 w-[130px] rounded-md border border-border bg-surface px-2 text-base outline-none focus:border-focus focus:shadow-[var(--focus-ring)]"
          />
          <Button variant="primary" size="sm" onClick={() => acting && runAction(acting, actValue)}>
            Apply to {selected.length}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setActing(null)}>Cancel</Button>
        </div>
      </div>

      {loading && (
        <div className="flex flex-col gap-2 p-3">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}
        </div>
      )}

      {showEmpty && <div className="p-4">{empty}</div>}

      {!loading && !showEmpty && (
        <div className="min-h-0 flex-1" role="region" aria-label={label}>
          <AgGridReact
            {...gridOptions}
            rowSelection={rowSelection}
            selectionColumnDef={selectionColumnDef}
            theme={density === "compact" ? tallyCompactGridTheme : tallyGridTheme}
            rowData={rows ?? []}
            columnDefs={cols}
            columnTypes={columnTypes}
            pinnedBottomRowData={totals ? [{ ...totals, _id: "__total", _kind: "data" }] : undefined}
            onGridReady={(e: GridReadyEvent) => setApi(e.api)}
            onSelectionChanged={(e) => setSelected(e.api.getSelectedRows().filter((r: GridRow<T>) => r._kind === "data") as T[])}
            onRowClicked={(e) => {
              const data = e.data as GridRow<T>;
              if (data?._kind === "data" && !(data as { __isTotal?: boolean }).__isTotal) onRowOpen?.(data as T);
            }}
            getRowClass={(p: RowClassParams) => {
              const d = p.data as GridRow<T> | undefined;
              if (!d) return "tly-row-total";
              if (d._kind === "group") return "tly-row-group";
              if (d._kind === "detail") return "tly-row-detail";
              return onRowOpen ? "cursor-pointer" : undefined;
            }}
            getRowHeight={(p: RowHeightParams) => {
              const d = p.data as GridRow<T> | undefined;
              return d?._kind === "group" ? 38 : undefined;
            }}
            fullWidthCellRenderer={GroupRowRenderer}
          />
        </div>
      )}

      {totalsSpanAllPages && (
        <div className="border-t border-border px-3 py-1.5 text-sm text-ink-tertiary">Total for all pages</div>
      )}
    </div>
  );
}

/** Group header row: the Community-edition stand-in for row grouping. */
function GroupRowRenderer(props: { data?: { _group?: { label: string; sublabel?: string; totals?: Record<string, string> } } }) {
  const g = props.data?._group;
  if (!g) return null;
  return (
    <div className="flex h-full items-center gap-3 bg-bg-subtle px-3 font-medium text-ink">
      <span className="truncate">{g.label}</span>
      {g.sublabel && <span className="truncate text-ink-tertiary">{g.sublabel}</span>}
      {g.totals && (
        <span className="ml-auto flex items-center gap-6 tabular-nums text-ink-secondary">
          {Object.entries(g.totals).map(([k, v]) => <span key={k}>{v}</span>)}
        </span>
      )}
    </div>
  );
}
