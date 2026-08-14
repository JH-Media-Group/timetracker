/**
 * Tally - grid recipes
 *
 * Ships verbatim into the app at `src/components/ui/grid.ts`.
 *
 * Every table in the product is an AG Grid Community instance configured from
 * this file. A page author writes column definitions and nothing else; the
 * behaviour, chrome, keyboard model, and export are all supplied here.
 *
 * =============================================================================
 * THE COMMUNITY BOUNDARY - READ THIS BEFORE ADDING A FEATURE
 * =============================================================================
 * We are on AG Grid Community (MIT). These features are Enterprise and are NOT
 * available to us. Using one produces a console error and a watermark:
 *
 *   Row grouping           Aggregation          Pivoting
 *   Master/detail          Tree data            Set filter (checkbox list)
 *   Range selection        Fill handle          Clipboard range ops
 *   Columns tool panel     Filters tool panel   Status bar
 *   Context menu           Excel export         Server-side row model
 *
 * Three of those are specced in the PRD, so each has a Community pattern here:
 *
 *   Row grouping     -> `groupRow()` full-width rows injected into flat data
 *   Aggregation      -> totals computed server-side and carried on the group row
 *   Master/detail    -> `detailRow()` full-width rows injected on expand
 *
 * The workaround is arguably the better design for us. Client-side aggregation
 * would re-derive totals in the browser using different rounding than the
 * server, and would happily sum a column the current user is not permitted to
 * see. Server-computed totals cannot drift from the reports that use the same
 * SQL, and they respect permission scoping by construction.
 *
 * The remaining Enterprise features we simply do not need, because the PRD
 * already specifies our own chrome for them: filters live in the page toolbar,
 * column visibility lives in our Columns popover, row actions live in our
 * Actions menu, and CSV export is Community.
 * =============================================================================
 */

import type * as React from "react";
import {
  ModuleRegistry,
  AllCommunityModule,
  type ColDef,
  type ColTypeDef,
  type GridOptions,
  type ICellRendererParams,
  type CsvExportParams,
  type GetRowIdParams,
  type RowHeightParams,
  type IsFullWidthRowParams,
} from "ag-grid-community";
import { tallyGridTheme } from "@/styles/ag-grid-theme";
import { prefersReducedMotion } from "@/styles/tokens";

/**
 * Register once, at app boot, from a client component.
 *
 * `AllCommunityModule` is the simple default and is what we ship first. If the
 * grid chunk needs trimming later, swap it for the granular modules actually in
 * use (client-side row model, the three filter modules, row selection,
 * pagination, CSV export, cell style, custom editors) and measure. Do not
 * optimise this before the bundle report says it matters.
 */
export function registerGridModules(): void {
  ModuleRegistry.registerModules([AllCommunityModule]);
}

/* =============================================================================
   ROW MODEL

   Rows are flat. Group headers, detail panels, and data rows all live in one
   array, distinguished by `_kind`. This is what replaces Enterprise grouping
   and master/detail, and it has a useful side effect: the row array is exactly
   what the API returned, in the order the server decided, so what you see is
   what the query produced.
   ========================================================================== */

export type RowKind = "data" | "group" | "detail";

export interface GridRowMeta {
  /** Stable identity. Required: it is what keeps selection and scroll position
   *  across refetches, and it is what makes optimistic updates land correctly. */
  _id: string;
  _kind: RowKind;
  /** Indent level for nested group headers. */
  _depth?: number;
  /** Group rows only: the label and the server-computed totals to render. */
  _group?: { label: string; sublabel?: string; totals?: Record<string, string>; collapsed?: boolean };
  /** Detail rows only: whatever the detail renderer needs. */
  _detail?: unknown;
}

export type GridRow<T> = T & GridRowMeta;

/** Build a group header row, e.g. a client name above its projects. */
export function groupRow(
  id: string,
  label: string,
  opts: { sublabel?: string; totals?: Record<string, string>; depth?: number; collapsed?: boolean } = {}
): GridRow<Record<string, never>> {
  return {
    _id: `group:${id}`,
    _kind: "group",
    _depth: opts.depth ?? 0,
    _group: { label, sublabel: opts.sublabel, totals: opts.totals, collapsed: opts.collapsed },
  } as GridRow<Record<string, never>>;
}

/** Build a detail row, e.g. the per-person breakdown under a task. */
export function detailRow(parentId: string, detail: unknown): GridRow<Record<string, never>> {
  return { _id: `detail:${parentId}`, _kind: "detail", _detail: detail } as GridRow<Record<string, never>>;
}

export const isDataRow = <T,>(row: GridRow<T> | undefined): boolean => row?._kind === "data";

/* =============================================================================
   COLUMN TYPES

   Referenced from a column definition as `type: "money"`. Centralising these is
   what stops a numeric column somewhere ending up left-aligned with the wrong
   number of decimals.

   Formatters are injected rather than imported, because how a duration renders
   is an account setting (decimal or h:mm) and how money renders depends on the
   invoice currency. The design system owns the shape; the app owns the domain.
   ========================================================================== */

export interface GridFormatters {
  money: (cents: number | null | undefined, currency?: string) => string;
  duration: (seconds: number | null | undefined) => string;
  percent: (fraction: number | null | undefined) => string;
  date: (iso: string | null | undefined) => string;
}

export function createColumnTypes(fmt: GridFormatters): Record<string, ColTypeDef> {
  return {
    /** Default for anything textual. Left-aligned, ellipsis on overflow. */
    text: {
      cellClass: "tly-cell",
      filter: "agTextColumnFilter",
      flex: 1,
      minWidth: 140,
    },

    /** Bare numbers: counts, quantities. */
    numeric: {
      cellClass: "tly-cell tly-numeric",
      headerClass: "tly-header-numeric",
      filter: "agNumberColumnFilter",
      width: 110,
      resizable: true,
    },

    /** Integer minor units in, formatted currency out. Sorts on the raw number,
     *  so "$9.99" never sorts above "$1,164.00" the way a string would. */
    money: {
      cellClass: "tly-cell tly-numeric",
      headerClass: "tly-header-numeric",
      filter: "agNumberColumnFilter",
      width: 130,
      valueFormatter: (p) => fmt.money(p.value, (p.data as { currency?: string })?.currency),
    },

    /** Seconds in, decimal hours or h:mm out per the account setting. */
    duration: {
      cellClass: "tly-cell tly-numeric",
      headerClass: "tly-header-numeric",
      filter: "agNumberColumnFilter",
      width: 100,
      valueFormatter: (p) => fmt.duration(p.value),
    },

    percent: {
      cellClass: "tly-cell tly-numeric",
      headerClass: "tly-header-numeric",
      filter: "agNumberColumnFilter",
      width: 90,
      valueFormatter: (p) => fmt.percent(p.value),
    },

    date: {
      cellClass: "tly-cell",
      filter: "agDateColumnFilter",
      width: 120,
      valueFormatter: (p) => fmt.date(p.value),
    },

    /** Status pill. Pair with `cellRenderer: StatusCellRenderer`. */
    status: {
      cellClass: "tly-cell",
      filter: "agTextColumnFilter",
      width: 130,
      sortable: true,
    },

    /** Trailing actions column. Pinned right, never sorted, never resized, and
     *  excluded from export because a menu button is not data. */
    actions: {
      cellClass: "tly-cell tly-actions",
      width: 56,
      minWidth: 56,
      maxWidth: 56,
      pinned: "right",
      sortable: false,
      resizable: false,
      filter: false,
      suppressHeaderMenuButton: true,
      suppressColumnsToolPanel: true,
      suppressMovable: true,
    },
  };
}

/** Leading checkbox column for bulk selection. Spread into the column array. */
export const selectionColumn: ColDef = {
  colId: "__select",
  width: 44,
  minWidth: 44,
  maxWidth: 44,
  pinned: "left",
  sortable: false,
  resizable: false,
  filter: false,
  headerCheckboxSelection: true,
  headerCheckboxSelectionFilteredOnly: true,
  checkboxSelection: (p) => isDataRow(p.data),
  suppressMovable: true,
  suppressHeaderMenuButton: true,
};

/* =============================================================================
   GRID OPTIONS
   ========================================================================== */

export const defaultColDef: ColDef = {
  sortable: true,
  resizable: true,
  filter: false,          // filters live in the page toolbar, not in headers
  suppressHeaderMenuButton: true,
  cellClass: "tly-cell",
  minWidth: 80,
};

/**
 * The house grid configuration. Spread into every grid; override only what a
 * particular table genuinely needs to differ on.
 */
export function createDefaultGridOptions<T>(): GridOptions<GridRow<T>> {
  return {
    theme: tallyGridTheme,
    defaultColDef,

    /* ---- Identity ---------------------------------------------------------
       Stable row IDs are what let a refetch preserve selection, focus, and
       scroll position instead of resetting the table under the user. */
    getRowId: (p: GetRowIdParams<GridRow<T>>) => p.data._id,

    /* ---- Full-width rows ---------------------------------------------------
       This is the mechanism standing in for Enterprise grouping and
       master/detail. Any row that is not a data row renders as one wide cell
       with our own renderer. */
    isFullWidthRow: (p: IsFullWidthRowParams<GridRow<T>>) => p.rowNode.data?._kind !== "data",
    getRowHeight: (p: RowHeightParams<GridRow<T>>) => {
      if (p.data?._kind === "group") return 38;
      if (p.data?._kind === "detail") return undefined; // renderer measures itself
      return undefined;                                  // theme's rowHeight
    },
    getRowClass: (p) =>
      p.data?._kind === "group" ? "tly-row-group"
      : p.data?._kind === "detail" ? "tly-row-detail"
      : undefined,

    /* ---- Selection ---------------------------------------------------------
       Ticking a checkbox changes the row's BACKGROUND and nothing else. It must
       not change row height, add a border, or reveal anything that was not
       already occupying space, because a user working down a column of
       checkboxes is aiming at a target that must not move. See the no-shift
       rule at the top of ag-grid-overrides.css.

       Selection surfaces in the action row above the grid, which is always in
       the layout at a fixed height, so going from zero selected to three
       selected shifts nothing. */
    rowSelection: {
      mode: "multiRow",
      checkboxes: true,
      headerCheckbox: true,
      enableClickSelection: false,   // a row click opens the record; only the
                                     // checkbox selects, so nothing is selected
                                     // by accident on the way to a detail page
      isRowSelectable: (node) => isDataRow(node.data as GridRow<T>),
    },

    /* ---- Keyboard ----------------------------------------------------------
       Cell focus is on so J/K and arrow navigation work and so a screen reader
       has a focus target. Our own shortcut layer handles Enter to open and
       Space to toggle selection. */
    suppressCellFocus: false,

    /* ---- Motion ------------------------------------------------------------ */
    animateRows: !prefersReducedMotion(),

    /* ---- Virtualization ----------------------------------------------------
       On by default and left on. This is the single biggest reason for the
       grid: 463 archived projects and 197 open invoices render in constant time. */
    rowBuffer: 10,

    /* ---- Empty and loading -------------------------------------------------
       Suppressed so the page can render our own EmptyState and skeletons, which
       carry the action that would fill the table. AG Grid's built-in overlays
       are a bare centred string with nowhere to go. */
    suppressNoRowsOverlay: true,
    loadingOverlayComponent: undefined,

    /* ---- Misc -------------------------------------------------------------- */
    suppressDragLeaveHidesColumns: true,   // an accidental drag should not delete a column
    suppressMovableColumns: false,
    tooltipShowDelay: 400,
    enableCellTextSelection: true,         // finance users copy figures out of cells
    ensureDomOrder: true,                  // DOM order matches visual order, for AT
  };
}

/* =============================================================================
   TOTALS

   The grand total is a pinned bottom row, which IS Community. It never scrolls
   away and it is never part of the sortable body.

   The value comes from the API, not from summing the loaded rows: a paginated
   table's visible rows are a subset, and a total that silently means "this page
   only" while saying "Total" is a reporting bug.
   ========================================================================== */

export function totalsRow<T>(values: Partial<T>, label = "Total"): GridRow<T> {
  return { ...(values as T), _id: "__total", _kind: "data", __isTotal: true, __label: label } as GridRow<T>;
}

export const totalsRowClass = "tly-row-total";

/* =============================================================================
   EXPORT

   CSV is Community; Excel is not. Large exports go through the server's export
   job anyway (BACKEND_PRD 13.2), which produces XLSX. Client-side CSV is for
   the "I want this view, now" case.
   ========================================================================== */

export function createCsvExportParams(context: {
  fileName: string;
  /** Human-readable description of the filters that produced this view. Written
   *  above the header row so an exported figure can always be traced back to
   *  the query behind it. */
  filterSummary?: string;
}): CsvExportParams {
  return {
    fileName: context.fileName,
    prependContent: context.filterSummary ? `${context.filterSummary}\n` : undefined,
    /* Skip the checkbox and actions columns: neither is data. */
    columnKeys: undefined,
    skipColumnGroupHeaders: false,
    /* Export the raw number, not the formatted string, so the receiving
       spreadsheet can sum a money column instead of choking on "$1,164.00". */
    processCellCallback: (p) => {
      const type = p.column.getColDef().type;
      const isNumeric =
        type === "money" || type === "duration" || type === "numeric" || type === "percent";
      return isNumeric ? p.value : (p.formatValue?.(p.value) ?? p.value);
    },
    shouldRowBeSkipped: (p) => (p.node.data as GridRowMeta)?._kind !== "data",
  };
}

/* =============================================================================
   CELL RENDERER CONTRACTS

   The renderers themselves are React components in `components/ui/grid/`. These
   are the class names they render, kept here so the visual system stays in one
   file and the style guide can show them without importing React.
   ========================================================================== */

export const gridCellClasses = {
  /** Client name above project name, the two-line cell used across the product. */
  twoLine: "flex flex-col justify-center leading-tight",
  twoLinePrimary: "font-medium text-ink truncate",
  twoLineSecondary: "text-sm text-ink-tertiary truncate",

  /** Avatar plus name, for person columns. */
  person: "flex items-center gap-2 min-w-0",
  personName: "truncate",

  /** Inline meter, for utilization and budget columns.
   *  `tly-meter-row` / `tly-meter` are not decorative: ag-grid-overrides.css
   *  uses them to make the bar grow inside AG Grid's flex cell. Without them
   *  the bar collapses to zero width and the cell shows a bare percentage. */
  meterCell: "tly-meter-row flex items-center gap-2 min-w-0 flex-1",
  meterTrack: "tly-meter",

  /** The trailing actions button, revealed on row hover or keyboard focus. */
  actionsButton:
    "opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 [.ag-row-focus_&]:opacity-100",

  /** Group header row content. */
  groupRow: "flex h-full items-center gap-3 bg-bg-subtle px-3 font-medium text-ink",
  groupLabel: "truncate",
  groupTotals: "ml-auto flex items-center gap-6 tabular-nums text-ink-secondary",
} as const;

/* =============================================================================
   <DataGrid> WRAPPER CONTRACT

   The component page authors actually use. It owns everything a table needs and
   is not worth rebuilding per page: the card frame, the toolbar, the column
   picker, the density toggle, the bulk action bar, the empty and loading
   states, and the pinned totals row.

   Implemented at `components/ui/DataGrid.tsx`.
   ========================================================================== */

export interface DataGridProps<T> {
  /** Flat rows including any group and detail rows, in server order. */
  rows: GridRow<T>[] | undefined;
  columns: ColDef<GridRow<T>>[];

  /** Persisted per user per table, keyed by this id: column order, widths,
   *  visibility, sort, and density. */
  tableId: string;

  loading?: boolean;
  /** Rendered in place of the grid body when `rows` is empty and not loading. */
  empty?: React.ReactNode;

  /** Server-computed grand total, pinned to the bottom. */
  totals?: Partial<T>;
  /** Set when the view is paginated, so the label reads "Total for all pages". */
  totalsSpanAllPages?: boolean;

  density?: "comfortable" | "compact";
  selectable?: boolean;
  onSelectionChange?: (rows: T[]) => void;

  /**
   * Actions offered in the action row when rows are selected. Drawn from the
   * same registry as Settings > Bulk actions so the two can never diverge.
   *
   * Each action declares how it collects its input, and the choice is a layout
   * decision, not a preference:
   *
   *   "immediate"  runs on click, with an Undo toast
   *   "inline"     a one-row form inside the action row (a single input plus
   *                confirm and cancel). Must fit --action-row-h.
   *   "modal"      anything larger, or anything needing a typed confirmation.
   *
   * There is no third option that grows the action row. The row's height is
   * fixed so the grid below it never moves; an action that needs more space
   * gets a modal, which is an overlay and shifts nothing.
   */
  bulkActions?: Array<{
    key: string;
    label: string;
    intent?: "default" | "danger";
    input: "immediate" | "inline" | "modal";
  }>;

  onRowOpen?: (row: T) => void;
  onSortChange?: (sort: { colId: string; dir: "asc" | "desc" } | null) => void;

  csvFileName?: string;
  filterSummary?: string;

  /** Accessible name. Becomes the grid's `aria-label` and the CSV title. */
  label: string;
}
