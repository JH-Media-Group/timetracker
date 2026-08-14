/**
 * Tally - AG Grid theme
 *
 * Ships verbatim into the app at `src/styles/ag-grid-theme.ts`.
 *
 * Every table in Tally is an AG Grid Community instance, and every one of them
 * gets this theme. It maps AG Grid's theming parameters onto our design tokens,
 * so the grid inherits the product's surfaces, ink, borders, radii, and type
 * without a single hard-coded value.
 *
 * WHY THIS WORKS FOR DARK MODE WITH NO EXTRA CODE
 * The params below are `var(--token)` references, not resolved colours. Our
 * tokens already carry both themes through `light-dark()`, so the grid flips
 * with the rest of the app the instant `data-theme` changes. There is no dark
 * grid theme, and there is no theme-change listener. `browserColorScheme:
 * "inherit"` makes AG Grid's own internal scheme follow `color-scheme` on the
 * root, which is what drives `light-dark()` in the first place.
 *
 * VERSION
 * Requires AG Grid v33 or later, which is where the Theming API (`themeQuartz`,
 * `.withParams()`) replaced the old `ag-theme-*` stylesheets. Do not import
 * `ag-grid-community/styles/*.css`; the Theming API emits its own CSS.
 *
 *   pnpm add ag-grid-community ag-grid-react
 *
 * A NOTE ON PARAM NAMES
 * AG Grid occasionally renames or adds parameters between majors. Anything the
 * installed version does not recognise is ignored rather than throwing, so a
 * stale name fails silently and quietly reverts to a default. When bumping the
 * major, diff this file against the version's parameter reference and check the
 * grid in both themes.
 */

import { themeQuartz, type Theme } from "ag-grid-community";

/**
 * The one theme. Pass it to every grid via `theme={tallyGridTheme}` or set it
 * once on `defaultGridOptions` in `recipes/grid.ts`.
 */
export const tallyGridTheme: Theme = themeQuartz.withParams({
  /* ---- Colour scheme ------------------------------------------------------
     "inherit" ties AG Grid's internal light/dark decision to the root's
     `color-scheme`, which is the same signal `light-dark()` reads. Setting a
     literal "light" or "dark" here would freeze the grid in one mode while the
     rest of the app switched, which is exactly the bug this avoids. */
  browserColorScheme: "inherit",

  /* ---- Surfaces ----------------------------------------------------------- */
  backgroundColor: "var(--surface)",
  foregroundColor: "var(--text)",
  borderColor: "var(--border)",

  /** Chrome is anything that is not a data cell: header, toolbars, panels. */
  chromeBackgroundColor: "var(--bg-muted)",

  /* ---- Header -------------------------------------------------------------
     Small, uppercase, tertiary ink. The header is a label, not a headline: it
     should recede so the data reads first. */
  headerBackgroundColor: "var(--bg-muted)",
  headerTextColor: "var(--text-tertiary)",
  headerFontSize: "var(--fs-xs)",
  headerFontWeight: 600,
  headerHeight: "36px",
  headerColumnResizeHandleColor: "var(--border-strong)",
  headerColumnBorder: false,

  /* ---- Rows ---------------------------------------------------------------
     No zebra striping. Alternating fills add visual noise to a dense financial
     table and make a hover state harder to see, which matters more here since
     hover is how a row reveals its actions. */
  oddRowBackgroundColor: "transparent",
  rowHoverColor: "var(--surface-hover)",
  selectedRowBackgroundColor: "var(--info-bg)",
  rowHeight: "var(--row-h)",

  /* Horizontal hairlines only. Vertical rules turn a table into a spreadsheet
     and make scanning a row harder. The week grid opts back in, because there
     a cell genuinely is a discrete editable unit. */
  rowBorder: { style: "solid", width: 1, color: "var(--border)" },
  columnBorder: false,

  /* ---- Wrapper ------------------------------------------------------------
     The grid supplies no outer frame. Pages wrap it in our own card so the
     radius, border, and shadow match every other surface on the page. */
  wrapperBorder: false,
  wrapperBorderRadius: 0,

  /* ---- Typography ---------------------------------------------------------- */
  fontFamily: "var(--typeface-sans)",
  fontSize: "var(--fs-base)",
  dataFontSize: "var(--fs-base)",

  /* ---- Spacing ------------------------------------------------------------
     `spacing` is AG Grid's own base unit, which it multiplies for internal
     padding. 4px matches our grid, so the grid's rhythm lines up with the page. */
  spacing: 4,
  cellHorizontalPadding: 12,

  /* ---- Accent and focus ---------------------------------------------------
     `accentColor` drives checkboxes, the sort indicator, range highlights, and
     the focused-cell ring. Using our focus blue keeps the grid's keyboard
     affordances identical to every other control in the product. */
  accentColor: "var(--focus)",
  focusShadow: { spread: 3, color: "color-mix(in srgb, var(--focus) 25%, transparent)" },

  /* ---- Controls ------------------------------------------------------------ */
  borderRadius: "var(--r-md)",
  checkboxBorderRadius: "var(--r-sm)",
  checkboxUncheckedBorderColor: "var(--border-strong)",
  checkboxCheckedBackgroundColor: "var(--accent)",
  checkboxCheckedBorderColor: "var(--accent)",
  checkboxCheckedShapeColor: "var(--accent-text)",

  inputBackgroundColor: "var(--surface)",
  inputBorder: { style: "solid", width: 1, color: "var(--border)" },
  inputFocusBorder: { style: "solid", width: 1, color: "var(--focus)" },
  inputTextColor: "var(--text)",
  inputPlaceholderTextColor: "var(--text-tertiary)",

  /* ---- Overlays ------------------------------------------------------------
     Filter popups and the column menu. Matched to our popover treatment so a
     grid menu and an app menu are indistinguishable. */
  menuBackgroundColor: "var(--surface)",
  menuTextColor: "var(--text)",
  menuBorder: { style: "solid", width: 1, color: "var(--border)" },
  menuShadow: { radius: 8, spread: 0, offsetY: 4, color: "rgba(0,0,0,0.12)" },

  tooltipBackgroundColor: "var(--text)",
  tooltipTextColor: "var(--text-inverse)",

  /* ---- Icons --------------------------------------------------------------- */
  iconSize: 14,
  iconButtonHoverColor: "var(--surface-hover)",
});

/**
 * Week-grid variant. The timesheet week view is the one table that genuinely is
 * a spreadsheet: a cell is a discrete editable unit, so vertical rules help
 * rather than hurt, and the cells are centre-height rather than row-height.
 */
export const tallyWeekGridTheme: Theme = tallyGridTheme.withParams({
  columnBorder: { style: "solid", width: 1, color: "var(--border)" },
  rowHeight: "40px",
  cellHorizontalPadding: 8,
});

/**
 * Compact variant for report drill-downs and modals, where the extra rows on
 * screen are worth more than the breathing room. Bind this to the density
 * toggle rather than overriding `rowHeight` per grid.
 */
export const tallyCompactGridTheme: Theme = tallyGridTheme.withParams({
  rowHeight: "var(--row-h-compact)",
  headerHeight: "32px",
});
