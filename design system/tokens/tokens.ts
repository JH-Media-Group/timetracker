/**
 * Tally - typed tokens for JS consumers
 *
 * Ships verbatim into the app at `src/styles/tokens.ts`.
 *
 * Most of the product should never import from here. Styling belongs in
 * Tailwind classes that resolve to the CSS variables in `tokens.css`. This file
 * exists for the cases where JavaScript genuinely needs a value:
 *
 *   - Chart libraries that want a colour string for a mark
 *   - Layout maths (virtualized row heights, sticky offsets)
 *   - Assigning a project its identity colour at creation time
 *   - Animation timings passed to a JS-driven transition
 *
 * KEEP IN SYNC WITH tokens.css. Anything here that duplicates a CSS value is a
 * drift risk, so prefer the `cssVar()` form below, which references the live
 * variable rather than copying its value.
 */

/* -----------------------------------------------------------------------------
   Referencing tokens without copying them

   `cssVar('--viz-1')` returns the string `var(--viz-1)`, which is a legal value
   for SVG `fill`, `stroke`, CSS-in-JS, and Recharts props. Using this instead of
   a hex literal means the value stays theme-aware and can never fall out of sync
   with the stylesheet.
   -------------------------------------------------------------------------- */

export const cssVar = (name: string): string => `var(${name})`;

/** Reads the *computed* value of a token. Only needed when a library refuses a
 *  `var()` string, for example canvas rendering or a colour maths operation.
 *  Client-side only; returns an empty string during SSR. */
export function tokenValue(name: string, el: Element | null = null): string {
  if (typeof window === "undefined") return "";
  const target = el ?? document.documentElement;
  return getComputedStyle(target).getPropertyValue(name).trim();
}

/* -----------------------------------------------------------------------------
   Scales
   -------------------------------------------------------------------------- */

export const spacing = {
  1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 10: 40, 12: 48, 16: 64, 20: 80,
} as const;

export const radii = {
  sm: 4, md: 6, lg: 8, xl: 12, "2xl": 16, full: 9999,
} as const;

export const typography = {
  size: {
    xs: 11, sm: 12, base: 13, md: 14, lg: 16,
    xl: 20, "2xl": 24, "3xl": 32, "4xl": 40,
  },
  lineHeight: { tight: 1.25, normal: 1.5, relaxed: 1.65 },
  weight: { regular: 400, medium: 500, semibold: 600, bold: 700 },
} as const;

export const motion = {
  durFast: 120,
  dur: 180,
  durSlow: 280,
  ease: "cubic-bezier(0.2, 0, 0, 1)",
  easeIn: "cubic-bezier(0.4, 0, 1, 1)",
  easeOut: "cubic-bezier(0, 0, 0.2, 1)",
} as const;

/** Honour the user's motion preference in JS-driven animation. */
export const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export const layout = {
  topbarH: 52,
  sidebarW: 240,
  sidebarRailW: 56,
  contentMax: 1440,
  settingsNavW: 280,
  rowH: { comfortable: 44, compact: 36 },
  controlH: { sm: 28, md: 32, lg: 36, touch: 44 },
} as const;

/** Matches the `--breakpoint-*` values in theme.css. `sm` is the base state. */
export const breakpoints = { md: 640, lg: 1024, xl: 1440 } as const;

export const zIndex = {
  base: 0, sticky: 50, dropdown: 100, modal: 200, toast: 300, tooltip: 400,
} as const;

/* -----------------------------------------------------------------------------
   Data visualization

   `VIZ_SERIES` is the ordered categorical palette as CSS variable references.
   Assign slots by stable entity ID ordering, computed once per report and
   cached, so filtering a chart never repaints the surviving series.
   -------------------------------------------------------------------------- */

export const VIZ_SERIES = [
  cssVar("--viz-1"), cssVar("--viz-2"), cssVar("--viz-3"), cssVar("--viz-4"),
  cssVar("--viz-5"), cssVar("--viz-6"), cssVar("--viz-7"), cssVar("--viz-8"),
] as const;

export const VIZ_SEQUENTIAL = [
  cssVar("--viz-seq-1"), cssVar("--viz-seq-2"), cssVar("--viz-seq-3"),
  cssVar("--viz-seq-4"), cssVar("--viz-seq-5"),
] as const;

export const VIZ_DIVERGING = {
  positive: cssVar("--viz-div-pos"),
  mid: cssVar("--viz-div-mid"),
  negative: cssVar("--viz-div-neg"),
} as const;

export const VIZ_STATUS = {
  good: cssVar("--viz-good"),
  warning: cssVar("--viz-warning"),
  serious: cssVar("--viz-serious"),
  critical: cssVar("--viz-critical"),
} as const;

/**
 * Raw hexes, for the rare consumer that cannot accept `var()` (canvas, image
 * export, a colour-maths operation). Light and dark are the same eight hues
 * re-stepped per surface, not two different palettes.
 *
 * Validated against our surfaces with `scripts/validate-palette.mjs`. Do not
 * edit a value here without re-running it in BOTH modes.
 */
export const VIZ_SERIES_HEX = {
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100",
          "#e87ba4", "#008300", "#4a3aa7", "#e34948"],
  dark:  ["#3987e5", "#d95926", "#199e70", "#c98500",
          "#d55181", "#008300", "#9085e9", "#e66767"],
} as const;

/**
 * Series caps enforced by the <Chart> wrapper.
 *
 * Only the first three slots clear the all-pairs colour-separation floor, which
 * is what scatter, bubble, and small-multiple forms need because every series
 * can sit adjacent to every other. Bars, lines, and stacks only ever compare
 * neighbouring slots, so all eight are safe there.
 */
export const VIZ_MAX_SERIES = { adjacent: 8, allPairs: 3 } as const;

/**
 * Slots below 3:1 contrast on the LIGHT surface. Charts using these must ship
 * visible direct labels or a table view. The dark steps all clear 3:1.
 */
export const VIZ_LOW_CONTRAST_LIGHT_SLOTS = [3, 4, 5] as const;

/** Shared Recharts defaults, so no chart has to restate its chrome. */
export const chartTheme = {
  grid: { stroke: cssVar("--viz-grid"), strokeDasharray: "0" },
  axis: { stroke: cssVar("--viz-axis") },
  tick: { fill: cssVar("--viz-label"), fontSize: typography.size.xs },
  barRadius: [4, 4, 0, 0] as const,   // rounded data-ends, square on the baseline
  barGap: 2,                           // surface-coloured separation
  lineWidth: 2,
  dotRadius: 4,                        // 8px diameter minimum
  surface: cssVar("--viz-surface"),
} as const;

/* -----------------------------------------------------------------------------
   Project identity colours

   Fixed hexes, deliberately not themed: a project's colour is how people
   recognise it on a calendar at a glance, and it must not shift with the theme.
   Always accompanied by a text label, never the sole identifier.
   -------------------------------------------------------------------------- */

export const PROJECT_COLORS = [
  "#3B82F6", // blue
  "#06B6D4", // cyan
  "#14B8A6", // teal
  "#10B981", // green
  "#84CC16", // lime
  "#F59E0B", // amber
  "#F97316", // orange
  "#EF4444", // red
  "#EC4899", // pink
  "#A855F7", // violet
  "#8B5CF6", // purple
  "#6366F1", // indigo
] as const;

/**
 * First palette colour not already taken, so a run of new projects gets a
 * pleasant rotation rather than a wall of blue. Wraps deterministically once
 * all twelve are used. Case-insensitive, because a hand-typed hex and a stored
 * one will disagree on case sooner or later.
 */
export function nextUnusedProjectColor(existing: readonly string[]): string {
  const used = new Set(existing.map((c) => c.toLowerCase()));
  for (const color of PROJECT_COLORS) {
    if (!used.has(color.toLowerCase())) return color;
  }
  return PROJECT_COLORS[existing.length % PROJECT_COLORS.length]!;
}

/* -----------------------------------------------------------------------------
   Domain to visual mapping

   One place that decides which visual treatment a domain state receives. Import
   these rather than writing a switch in a component, so adding an invoice state
   is a single edit.
   -------------------------------------------------------------------------- */

export type InvoiceState =
  | "draft" | "sent" | "partial" | "late" | "paid" | "written_off";

export const INVOICE_STATE_VARIANT: Record<InvoiceState, {
  variant: "neutral" | "info" | "warning" | "danger" | "success";
  label: string;
}> = {
  draft:       { variant: "neutral", label: "Draft" },
  sent:        { variant: "info",    label: "Sent" },
  partial:     { variant: "warning", label: "Partially paid" },
  late:        { variant: "danger",  label: "Late" },
  paid:        { variant: "success", label: "Paid" },
  written_off: { variant: "neutral", label: "Written off" },
};

export type ApprovalState = "draft" | "submitted" | "approved" | "changes_requested";

export const APPROVAL_STATE_VARIANT: Record<ApprovalState, {
  variant: "neutral" | "warning" | "success" | "danger";
  label: string;
}> = {
  draft:             { variant: "neutral", label: "Not submitted" },
  submitted:         { variant: "warning", label: "Awaiting review" },
  approved:          { variant: "success", label: "Approved" },
  changes_requested: { variant: "danger",  label: "Changes requested" },
};

export type BudgetHealth = "ok" | "near" | "over";

/**
 * Visual band for a budget bar. The thresholds mirror the domain rule in
 * BACKEND_PRD 4.6; if that rule changes, change it there first and mirror here.
 */
export function budgetHealth(percentUsed: number): BudgetHealth {
  if (percentUsed > 1) return "over";
  if (percentUsed >= 0.8) return "near";
  return "ok";
}

export const BUDGET_HEALTH_TOKEN: Record<BudgetHealth, string> = {
  ok:   cssVar("--budget-ok"),
  near: cssVar("--budget-near"),
  over: cssVar("--budget-over"),
};

/* -----------------------------------------------------------------------------
   Theme
   -------------------------------------------------------------------------- */

export type ThemePreference = "system" | "light" | "dark";

/**
 * Applies a theme choice. `system` removes the attribute entirely so
 * `color-scheme: light dark` and `light-dark()` follow the OS.
 *
 * Persist the choice to the user record so it follows across devices, and
 * mirror it to localStorage so the head script can apply it before first paint.
 */
export function applyTheme(pref: ThemePreference): void {
  const root = document.documentElement;
  if (pref === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", pref);
  try {
    localStorage.setItem("tally-theme", pref);
  } catch {
    /* Private browsing or blocked storage. The in-memory choice still applies. */
  }
}

/**
 * Inline this in <head>, before any stylesheet, to prevent a flash of the wrong
 * theme. It must be render-blocking and it must not be deferred.
 */
export const THEME_INIT_SCRIPT = `
(function(){try{var t=localStorage.getItem('tally-theme');
if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t);}catch(e){}})();
`.trim();
