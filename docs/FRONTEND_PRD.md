# Tally - Front-End PRD

**Every screen, every layout, every interaction.**

Wireframes use anonymized labels and placeholder numbers, not operational records.

| | |
|---|---|
| Status | Draft v1.1 (review pass applied 2026-08-13) |
| Date | 2026-08-13 |
| Companion docs | [PRD-OVERVIEW.md](PRD-OVERVIEW.md) - [BACKEND_PRD.md](BACKEND_PRD.md) - [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) |

---

## Table of contents

1. [Scope and conventions](#1-scope-and-conventions)
2. [Design foundations](#2-design-foundations)
3. [Application shell](#3-application-shell)
4. [Cross-cutting patterns](#4-cross-cutting-patterns)
5. [Track: Timesheet](#5-track-timesheet)
6. [Track: Expenses](#6-track-expenses)
7. [Review: Approvals](#7-review-approvals)
8. [Organize: Team](#8-organize-team)
9. [Organize: Clients](#9-organize-clients)
10. [Organize: Projects](#10-organize-projects)
11. [Organize: Tasks](#11-organize-tasks)
12. [Bill: Invoices](#12-bill-invoices)
13. [Bill: Recurring invoices](#13-bill-recurring-invoices)
14. [Bill: Retainers](#14-bill-retainers)
15. [Bill: Invoice configuration](#15-bill-invoice-configuration)
16. [Review: Reports](#16-review-reports)
17. [Settings](#17-settings)
18. [Component inventory](#18-component-inventory)
19. [Performance budgets](#19-performance-budgets)
20. [Acceptance criteria](#20-acceptance-criteria)

---

## 1. Scope and conventions

### 1.1 How to read a page section

Every page below is specified with the same seven headings so nothing is left to interpretation:

- **Route** - the URL, including params and query state that must survive a refresh.
- **Purpose** - the one job this page does.
- **Layout** - an ASCII wireframe plus the grid, widths, and spacing rules.
- **Components** - each region, its content, and its states.
- **Interactions** - what happens on click, keypress, drag, and hover.
- **Permissions** - what changes per profile.
- **States** - loading, empty, error, and offline.

### 1.2 Breakpoints

| Name | Width | Shell behaviour |
|---|---|---|
| `sm` | < 640px | Sidebar becomes a bottom tab bar (Track, Projects, Team, Reports, More). Tables collapse to stacked cards. Timer widget is a fixed bottom sheet handle. |
| `md` | 640-1023px | Sidebar collapses to a 56px icon rail, expandable on hover. Two-column layouts stack. |
| `lg` | 1024-1439px | Full 240px sidebar. Primary layout. |
| `xl` | >= 1440px | Content max-width 1440px, centred, with the page gutter growing. Report tables get their optional columns back. |

Mobile is a first-class target for **Track** and **Approvals** only; their mobile layouts are specified in §5.7 and §7.3. Reports, invoicing, and settings are usable on mobile but optimised for `lg`.

### 1.3 Units and formatting

- **Durations** render per the account preference: decimal (`7.25`) or hours-and-minutes (`7:15`). Both are accepted as input everywhere. Stored as seconds.
- **Money** always shows the currency symbol and two decimals: `$10,000.00`. Negative values are `-$1,000.00` in `--danger`, never parenthesised.
- **Percentages** are whole numbers except margins under 10%, which get one decimal.
- **Dates** in UI chrome are `Thu, 13 Aug`; in tables `08/13/2026`; in exports ISO `2026-08-13`.
- **Tabular figures** (`font-variant-numeric: tabular-nums`) on every number in a column. Proportional figures on standalone hero numbers.

---

## 2. Design foundations

The token set is lifted directly from `visual-debugger/app.css` (the Toado design system) so the two JHMG products read as siblings. Neutral-first, near-monochrome chrome, colour reserved for meaning.

> **The built design system supersedes this section as the implementation.** See [`design system/`](../design%20system/README.md), whose `tokens/tokens.css` is canonical and ships verbatim into the app. Two deliberate differences from the sketch below:
>
> 1. **Theming uses CSS `light-dark()`**, so each colour is defined exactly once on bare `:root` rather than repeated across a `:root` block, a `prefers-color-scheme` media query, and a `[data-theme]` block. This satisfies §2.2 and acceptance criterion 1 more strictly, and removes the "updated one block, forgot the other" class of bug.
> 2. **The token list below is a summary.** `tokens.css` carries the full set, including the domain aliases (invoice states, budget health, billable split), the layout and control-height scales, and the project identity palette.
>
> Everything else in this section is implemented as specified.

### 2.1 Colour tokens

```css
:root {
  /* Surfaces */
  --bg:             #FFFFFF;
  --bg-subtle:      #FAFAFA;   /* sidebar, page plane behind cards */
  --bg-muted:       #F4F4F5;   /* inputs at rest, table header, chips */
  --bg-strong:      #E8E8EA;   /* pressed states, progress track */
  --surface:        #FFFFFF;   /* cards, popovers, chart surface */
  --surface-hover:  #F7F7F8;
  --border:         #E4E4E7;
  --border-strong:  #D4D4D8;

  /* Ink */
  --text:           #09090B;
  --text-secondary: #52525B;
  --text-tertiary:  #8B8B91;
  --text-inverse:   #FFFFFF;

  /* Primary action */
  --accent:         #09090B;
  --accent-hover:   #27272A;
  --accent-text:    #FFFFFF;

  /* Semantic */
  --success: #059669;  --success-bg: #ECFDF5;  --success-border: #A7F3D0;
  --warning: #B45309;  --warning-bg: #FFFBEB;  --warning-border: #FCD34D;
  --danger:  #DC2626;  --danger-bg:  #FEF2F2;  --danger-border:  #FCA5A5;
  --info:    #2563EB;  --info-bg:    #EFF6FF;  --info-border:    #BFDBFE;

  /* Running timer (Tally-specific, replaces visual-debugger's --mcp slot) */
  --live:        #EA580C;
  --live-bg:     #FFF7ED;
  --live-border: #FED7AA;

  /* Spacing */
  --sp-1: 4px;  --sp-2: 8px;  --sp-3: 12px; --sp-4: 16px;
  --sp-5: 20px; --sp-6: 24px; --sp-8: 32px; --sp-10: 40px;
  --sp-12: 48px; --sp-16: 64px;

  /* Radii */
  --r-sm: 4px; --r-md: 6px; --r-lg: 8px; --r-xl: 12px; --r-2xl: 16px; --r-full: 9999px;

  /* Elevation */
  --sh-xs: 0 1px 2px rgba(9,9,11,0.04);
  --sh-sm: 0 1px 3px rgba(9,9,11,0.06), 0 1px 2px rgba(9,9,11,0.04);
  --sh-md: 0 4px 8px rgba(9,9,11,0.06), 0 2px 4px rgba(9,9,11,0.04);
  --sh-lg: 0 12px 24px rgba(9,9,11,0.08), 0 4px 8px rgba(9,9,11,0.06);
  --sh-xl: 0 24px 48px rgba(9,9,11,0.12), 0 8px 16px rgba(9,9,11,0.08);

  /* Type */
  --fs-xs: 11px; --fs-sm: 12px; --fs-base: 13px; --fs-md: 14px;
  --fs-lg: 16px; --fs-xl: 20px; --fs-2xl: 24px; --fs-3xl: 32px; --fs-4xl: 40px;
  --lh-tight: 1.25; --lh-normal: 1.5; --lh-relaxed: 1.65;
  --fw-regular: 400; --fw-medium: 500; --fw-semibold: 600; --fw-bold: 700;

  /* Motion */
  --ease: cubic-bezier(0.2, 0, 0, 1);
  --dur-fast: 120ms; --dur: 180ms; --dur-slow: 280ms;
}

[data-theme="dark"] {
  --bg:             #09090B;
  --bg-subtle:      #0E0E10;
  --bg-muted:       #17171A;
  --bg-strong:      #27272A;
  --surface:        #111113;
  --surface-hover:  #1A1A1D;
  --border:         #27272A;
  --border-strong:  #3F3F46;
  --text:           #FAFAFA;
  --text-secondary: #A1A1AA;
  --text-tertiary:  #71717A;
  --text-inverse:   #09090B;
  --accent:         #FAFAFA;
  --accent-hover:   #E4E4E7;
  --accent-text:    #09090B;

  --success: #34D399; --success-bg: rgba(16,185,129,0.12); --success-border: rgba(16,185,129,0.35);
  --warning: #FBBF24; --warning-bg: rgba(245,158,11,0.12); --warning-border: rgba(245,158,11,0.35);
  --danger:  #F87171; --danger-bg:  rgba(239,68,68,0.12);  --danger-border:  rgba(239,68,68,0.35);
  --info:    #60A5FA; --info-bg:    rgba(59,130,246,0.12); --info-border:    rgba(59,130,246,0.35);
  --live:    #FB923C; --live-bg:    rgba(234,88,12,0.14);  --live-border:    rgba(234,88,12,0.38);

  --sh-xs: 0 1px 2px rgba(0,0,0,0.3);
  --sh-sm: 0 1px 3px rgba(0,0,0,0.4), 0 1px 2px rgba(0,0,0,0.3);
  --sh-md: 0 4px 8px rgba(0,0,0,0.4), 0 2px 4px rgba(0,0,0,0.3);
  --sh-lg: 0 12px 24px rgba(0,0,0,0.5), 0 4px 8px rgba(0,0,0,0.4);
  --sh-xl: 0 24px 48px rgba(0,0,0,0.6), 0 8px 16px rgba(0,0,0,0.5);
}
```

**Where colour is allowed to appear.** Chrome is neutral. Colour carries exactly four meanings and nothing else:

| Colour | Means |
|---|---|
| `--live` orange | A timer is running, right now, somewhere. |
| `--info` blue | Billable. Also the sequential ramp for magnitude bars. |
| `--success` / `--warning` / `--danger` | Budget health, invoice status, approval status. Always paired with an icon and a label. |
| Categorical series palette (§2.4) | Chart series identity only. Never chrome, never status. |

Primary buttons are `--accent` (near-black in light, near-white in dark), *not* a brand colour. This is deliberate: it keeps orange exclusively meaning "running", which is the single most important state in a time tracker.

### 2.2 Theme mechanics

Three states:

1. `<html>` with no `data-theme` follows the OS.
2. `<html data-theme="light">` and `<html data-theme="dark">` are explicit user choices, persisted to the user record (so it follows across devices) and mirrored to `localStorage` for a flash-free first paint.
3. A blocking inline script in `<head>` reads `localStorage` and stamps the attribute before first paint. No FOUC, ever. The script ships as `THEME_INIT_SCRIPT` in `tokens.ts`.

The three states are implemented by setting `color-scheme` on those three selectors; every colour token then resolves through `light-dark()`. Toggle lives in the avatar menu with three options: System / Light / Dark.

Every colour is defined exactly once, on bare `:root`. No colour has its only definition inside a media query or a `[data-theme]` block, and there is no second dark block to keep in sync.

### 2.3 Typography and iconography

- **UI sans:** Inter Variable, self-hosted, subset to latin, `font-display: swap`. Fallback `ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`.
- **Mono:** JetBrains Mono, self-hosted, used for durations in dense tables, invoice IDs, project codes, and keyboard hints.
- **Headings** are `--fw-semibold` with `letter-spacing: -0.011em`; hero numbers (`--fs-3xl` and up) go to `-0.02em`.
- **Icons:** Lucide, 16px in dense chrome, 20px in nav, 1.5px stroke, `currentColor` only. Never a coloured icon except inside a status badge.
- **Avatars:** 28px default, circular. The photo is the primary treatment; the fallback chain is photo, then initials on a gradient derived from a hash of the **user ID** (never list position, which would change colour when a list re-sorts), then a generic glyph. Bot and system actors get a 6px-radius square instead of a circle so they are distinguishable at a glance.
- **Avatar stacks:** 22px avatars at -6px overlap, each with a 2px `--surface` ring so edges stay separated against any row background. Caps at seven, then a neutral `+N` chip that is the same size and shape as an avatar, so the row height cannot change with the count. The stack carries one accessible name listing everyone and the individual avatars are `aria-hidden`; a screen reader announcing nineteen sets of initials one at a time is worse than useless.

### 2.4 Data visualization

The chart layer follows a fixed set of rules enforced inside a shared `<Chart>` wrapper. No chart component may set its own colours.

**Categorical series palette.** Fixed slot order, never cycled. Validated for colour-vision deficiency separation against our own surfaces (`#FFFFFF` light, `#111113` dark): all adjacent pairs clear CVD ΔE ≥ 8 and normal-vision ΔE ≥ 15 in both modes. The validator is vendored at [scripts/validate-palette.mjs](../scripts/validate-palette.mjs) and runs in CI against both surfaces; a palette change that fails any gate fails the build.

| Slot | Hue | Light | Dark |
|---|---|---|---|
| 1 | blue | `#2a78d6` | `#3987e5` |
| 2 | orange | `#eb6834` | `#d95926` |
| 3 | aqua | `#1baf7a` | `#199e70` |
| 4 | yellow | `#eda100` | `#c98500` |
| 5 | magenta | `#e87ba4` | `#d55181` |
| 6 | green | `#008300` | `#008300` |
| 7 | violet | `#4a3aa7` | `#9085e9` |
| 8 | red | `#e34948` | `#e66767` |

Rules that fall out of this:

- **Scatter, bubble, and small-multiple charts cap at 3 series.** Only the first three slots clear the all-pairs separation floor. A fourth category folds into "Other" or the chart facets.
- **Slots 3, 4, and 5 sit below 3:1 contrast on the light surface.** Any chart using them ships visible direct labels or a table view alongside. This is not optional.
- **Colour follows the entity, not the rank.** Filtering a chart down to three projects must not repaint the survivors. Slot assignment is by stable entity ID ordering, computed once per report and cached.
- **Never a dual-axis chart.** Revenue and hours are two charts or one indexed chart, never two y-scales.
- **Status colours are reserved** (`good #0ca30c`, `warning #fab219`, `serious #ec835a`, `critical #d03b3b`) and never used as a series.

**Chart chrome.** Gridlines are hairline `--border`; the baseline is `--border-strong`. Axis labels are `--text-tertiary` at `--fs-xs`. Bars have 4px rounded data-ends anchored to the baseline, a 2px surface-coloured gap between adjacent bars and between stacked segments, and a 2px surface ring where marks overlap. Lines are 2px with ≥8px markers, and only the final point carries a marker on a dense series (a dot on every point is noise). Text always wears text tokens, never the series colour; a coloured swatch beside the label carries identity.

**The current period band.** Every time-series chart tints the period currently in progress, or the one selected in the period picker, and labels it. A full-height `--info-bg` band drawn *under* the grid and marks so it never dims the data, with an `--fs-xs` label at the top. The partial period's bar or line segment also renders at 60% opacity, so "incomplete" survives a greyscale print. Without this, a reader cannot tell whether the last bar is a real decline or a week that is two days old, which is the most common misreading of a tracking chart.

**Thresholds.** A budget line is a 1px dashed `--danger` rule with an inline label chip at its left edge, and the series **changes colour at the crossing point** so the moment a project went over is visible without reading the axis.

**Stacks cap at three segments and the segment order never changes between periods.** Only the bottom segment sits on a common baseline, so only it is genuinely comparable across bars; everything above is read by length alone. Past three, the upper bands are noise.

**On circular charts.** The donut on the Time report is the only one in the product, and it is capped at two segments. A ring is readable only when there are very few slices and the question is genuinely part-to-whole; the breakdowns that look like candidates are not, because a projects or tasks breakdown carries eight or more categories and nobody can compare eight angles. Those use a stacked proportional bar with a ranked legend, which answers "which is biggest" and "by how much" at once. A third slice means the answer is a bar chart.

**Every chart ships with:** a legend when there are two or more series (a single-series chart names itself in the title instead), direct labels on at most four series, an interactive tooltip (below), and a "View as table" affordance in the chart's overflow menu. Charts announce their summary to screen readers via `role="img"` plus an `aria-label` containing the headline figure.

**Tooltips.** Every chart is interactive; a chart that only shows shape is half a chart. Rules:

- **The hit target is the whole column, not the mark.** Each slot gets a full-height transparent hit rectangle. Chasing an 8px dot with a pointer is miserable and impossible on a trackpad at speed.
- **Snap to the nearest data point, never interpolate.** A tooltip reading 6.4 hours for a week that recorded 6 or 7 is a fabricated number.
- **One tooltip per column, not per segment.** A stacked bar answers "what made up this month", so the tooltip lists every segment plus the total. The donut is the exception: two segments are two distinct answers rather than points in a series, so it tooltips per segment.
- **Arrow keys drive the same tooltip.** The chart is one tab stop; left and right walk the series, Home and End jump to the ends, Escape dismisses. Data reachable only by hover is data a keyboard user cannot reach.
- **The tooltip is inert** (`pointer-events: none`) and positioned from the hit target's bounding box, not from raw pointer coordinates, so it cannot sit between the cursor and its own mark and flicker.
- **It flips and clamps:** above the mark by default, below when it would leave the viewport, clamped horizontally so it is never cut off.
- **The hovered mark responds** with a tinted column band, a colour shift, or a crosshair plus enlarged point. Something must confirm what the tooltip describes.
- **Content:** title is the period, then one row per series with a swatch, label, and right-aligned tabular value. The footer carries the derived figure that is the actual reason someone hovered (total on a stack, margin on profit, over/under budget on progress, vs average on hours), never a repeat of the axis value.
- The tooltip is **in addition to** the accessible name, never instead of it.

**Chart inventory:**

| Chart | Form | Where |
|---|---|---|
| Project progress | Cumulative line, single series, with a budget threshold rule | Project detail |
| Hours per week | Vertical bars, single series | Project detail |
| Company profit over period | Grouped bars (revenue, cost) plus a profit line overlay, all on one axis in currency | Profitability report |
| Invoices issued | Stacked bars (paid, open) by month | Invoices overview |
| Billable split | Donut, two segments, centre hero percentage | Time report |
| Utilization, summary | Horizontal proportional bar with an axis: tick marks and percentage labels at 20/40/60/80. Once a bar is wide enough to read a value off it, it carries the ticks that let you | Team page header |
| Utilization, row scale | The same meter at 8px with an **outlined** track rather than a filled one. At row scale a filled grey track reads as data, so a person at 0% would look like a person at 10% | Team list rows |
| Budget consumption | Horizontal bar with an over-budget overflow segment in `--danger` | Projects list, project detail |
| Person sparkline | 30-day bar sparkline, no axes, no labels | Team list row hover |

### 2.5 Motion

- Durations: `--dur-fast` (120ms) for hover and focus, `--dur` (180ms) for popovers, dropdowns, and toasts, `--dur-slow` (280ms) for route transitions and modal entry.
- Only `transform` and `opacity` are animated. Never `height`, never `top`.
- The running-timer pulse is a 2s `box-shadow` ripple on a 6px dot, matching the `visual-debugger` `@keyframes pulse`.
- `@media (prefers-reduced-motion: reduce)` sets every duration to `1ms` and disables the pulse (the dot stays solid). Skeletons stop shimmering and render as static blocks.

### 2.6 Accessibility baseline

- WCAG 2.2 AA on all text and UI boundaries.
- Focus is always visible: `outline: 2px solid var(--info); outline-offset: 2px`. Never `outline: none` without a replacement.
- Every icon-only control has an `aria-label` and a tooltip.
- Modals trap focus, restore it on close, and close on `Esc`.
- Tables use real `<table>` semantics with `<caption>`, `scope` on headers, and `aria-sort` on sortable columns.
- Live regions: the timer widget is `aria-live="off"` (it would be maddening) but announces start and stop via a polite status message. Toasts are `role="status"`, errors are `role="alert"`.
- Colour is never the only channel. Budget health carries an icon, invoice status carries a word, billable carries a label.
- Minimum hit target 32x32px in dense chrome, 44x44px on touch.

---

## 3. Application shell

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ┌─ Top bar (00px, sticky, backdrop-blur) ───────────────────────────────────┐│
│ │ [◐ 0:00:00 ⏹]  [+]  [⌘K Search projects, people, invoices…]   [🔔] [JL▾] ││
│ └───────────────────────────────────────────────────────────────────────────┘│
│ ┌────────────┬──────────────────────────────────────────────────────────────┐│
│ │ SIDEBAR    │  PAGE                                                        ││
│ │ 000px      │  ┌────────────────────────────────────────────────────────┐  ││
│ │ bg-subtle  │  │ Page header: H0 + primary actions (sticky)             │  ││
│ │            │  ├────────────────────────────────────────────────────────┤  ││
│ │ TRACK      │  │ Tab bar (optional)                                     │  ││
│ │  Timesheet │  ├────────────────────────────────────────────────────────┤  ││
│ │  Expenses  │  │ Toolbar: date range · filters · view toggle · export   │  ││
│ │  Approvals⁴│  ├────────────────────────────────────────────────────────┤  ││
│ │            │  │                                                        │  ││
│ │ ORGANIZE   │  │ Content, max-width 0000px                              │  ││
│ │  Team      │  │                                                        │  ││
│ │  Clients   │  │                                                        │  ││
│ │  Projects  │  │                                                        │  ││
│ │  Tasks     │  │                                                        │  ││
│ │            │  │                                                        │  ││
│ │ BILL       │  │                                                        │  ││
│ │  Invoices  │  │                                                        │  ││
│ │            │  │                                                        │  ││
│ │ REVIEW     │  │                                                        │  ││
│ │  Reports   │  │                                                        │  ││
│ │ ─────────  │  │                                                        │  ││
│ │  Settings  │  │                                                        │  ││
│ │ ┌────────┐ │  │                                                        │  ││
│ │ │JL Jason│ │  └────────────────────────────────────────────────────────┘  ││
│ │ └────────┘ │                                                              ││
│ └────────────┴──────────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────────────────┘
```

### 3.1 Top bar

52px tall, `position: sticky; top: 0; z-index: 50`, background `color-mix(in srgb, var(--bg) 85%, transparent)` with `backdrop-filter: saturate(140%) blur(10px)` and a 1px bottom border. Three regions.

**Left - the timer widget.** This is the most important control in the product and it is never more than one click or one keypress away.

- *Idle state:* a pill button labelled "Start timer" with a clock icon, `--accent` filled. Clicking opens the Quick Timer popover.
- *Running state:* the pill turns `--live-bg` with a `--live-border` ring, shows a pulsing 6px dot, the elapsed time in JetBrains Mono ticking every second, and a stop square. The project and task names sit to the right of the pill in `--text-secondary`, truncated with a tooltip. Clicking the elapsed time opens the running entry's editor popover; clicking the square stops it.
- The document `<title>` becomes `1:24 · Project name` while running, and the favicon swaps to a filled dot, so a background tab still shows the state.
- Elapsed time is computed from the server-provided `timer_started_at` plus `duration_seconds`, not from a client-side counter, so a sleeping laptop cannot drift. The tick is a `requestAnimationFrame`-throttled recompute against `Date.now()` with the server clock offset applied.

**Left - the plus button.** A 30px icon button opening a menu: New time entry (`N`), New expense (`E`), New project, New client, New invoice. Menu items respect permissions.

**Centre - global search.** A 440px-max search field styled like the `visual-debugger` `.searchbar`: `--bg-muted` background, transparent border that becomes `--border` on hover, a `⌘K` keyboard hint chip on the right. Clicking or `⌘K` opens the command palette; the field itself is a launcher, not an input.

**Right - notifications and avatar.**
- Bell icon with a `--danger` dot when unread. Opens a 380px popover listing: approval requests awaiting you, timesheets rejected, budget alerts, invoices gone late, invoices paid. Each row is a link with a relative timestamp; a "Mark all read" link sits in the header.
- Avatar (28px) opens the account menu: name and JHMG label at top, then My profile, My time report, Notifications, Theme (System / Light / Dark segmented control inline), Keyboard shortcuts (`?`), Sign out.

### 3.2 Sidebar

240px, `--bg-subtle`, `border-right: 1px solid var(--border)`, sticky below the top bar, its own scroll with a scrollbar that only appears on hover.

Grouped with `--fs-xs` uppercase `--text-tertiary` section labels at `letter-spacing: 0.06em`:

- **TRACK** - Timesheet, Expenses, Approvals
- **ORGANIZE** - Team, Clients, Projects, Tasks
- **BILL** - Invoices
- **REVIEW** - Reports

Then a hairline, then Settings. Pinned to the bottom: the current user card (avatar, name, "JH Media Group").

Item anatomy: 8px gap, 16px icon, label at `--fs-base`, optional right-aligned count in mono `--fs-xs` `--text-tertiary`. At rest `--text-secondary`; hover `--surface-hover` + `--text`; active `--bg-muted` + `--text` + `--fw-medium` + a 2px `--accent` left rail.

Counts that appear: Approvals shows the number awaiting your action. Invoices shows the number of late invoices in `--danger`. Both are polled through the SSE stream, not on an interval.

Sections a profile cannot access are not rendered at all (not disabled). A Member sees only Timesheet, Expenses, Reports, and Settings.

A collapse chevron on the sidebar's right edge (visible on hover) toggles the 56px icon rail; the state persists per user.

### 3.3 Command palette

`⌘K` / `Ctrl+K` from anywhere, including inside modals. A 640px centred dialog with a scrim at `rgba(9,9,11,0.4)`.

Behaviour:

- Empty query shows **Recent** (last 8 things you opened) then **Actions**.
- Typing runs a debounced (120ms) fuzzy search across projects, clients, people, tasks, and invoices, plus a static action list. Results are grouped with sticky group headers and capped at 5 per group with a "Show all in Projects →" row.
- Results show the entity icon, the primary label, and a `--text-tertiary` secondary line (a project shows its client, an invoice shows its client and amount).
- Typing `>` filters to actions only. Typing `@` filters to people. Typing `#` filters to projects. These prefixes are shown as a hint row when the query is empty.
- **Start a timer without leaving the palette:** selecting a project result with `⌥Enter` starts a timer immediately and closes; the task resolves to your most recently used task on that project, else the project's first billable task by name - the same rule as the picker ([BACKEND_PRD.md §4.9](BACKEND_PRD.md#49-timer-rules)). Plain `Enter` navigates.
- Arrow keys move, `Enter` selects, `Esc` closes, `Tab` cycles group.
- Every action row shows its own keyboard shortcut on the right where one exists.

Actions available: Start/stop timer, New time entry, New expense, New project, New client, New invoice, Submit timesheet, Go to today, Switch theme, Copy previous day, Sign out.

### 3.4 Keyboard shortcut map

Global, disabled while a text input has focus (except the ones marked ⌘):

| Key | Action |
|---|---|
| `⌘K` | Command palette |
| `T` | Start or stop the timer (toggle) |
| `N` | New time entry for the focused day |
| `E` | New expense |
| `D` / `W` / `C` | Timesheet Day / Week / Calendar view |
| `←` `→` | Previous / next period on any date-nav page |
| `Ctrl+.` | Return to today |
| `G` then `T/E/P/C/I/R/M` | Go to Timesheet / Expenses / Projects / Clients / Invoices / Reports / Team |
| `/` | Focus the page's filter field |
| `?` | Keyboard shortcut sheet |
| `⌘Z` | Undo the last undoable mutation (also available from the toast) |
| `Esc` | Close the topmost overlay |

Inside the time entry editor: `⌘Enter` saves, `⌘⇧Enter` saves and starts a timer on it, `⌘D` duplicates, `⌘⌫` deletes.

Inside tables: `J`/`K` move the row cursor, `Enter` opens, `Space` toggles the row checkbox, `⌘A` selects all loaded rows, `X` toggles selection.

The `?` sheet is a two-column dialog grouping these by context, always current because it is generated from the same shortcut registry the handlers are bound from.

### 3.5 Page header and toolbar

Every page uses the same three-band header so the eye always knows where to look.

1. **Header band** (`--sp-6` top padding): `<h1>` at `--fs-2xl` `--fw-semibold`, optional breadcrumb above it at `--fs-base` `--text-secondary`, optional status badge inline after the title. Primary actions right-aligned: at most one `.btn-primary`, the rest `.btn-secondary`, plus an "Actions ▾" overflow menu.
2. **Tab band** (optional): underline tabs, 2px active indicator in `--text`, counts as pill chips.
3. **Toolbar band**: left side holds the period picker and filters; right side holds view toggles, column picker, Export, and print. All filter state is written to the URL query string so any view is linkable and survives a refresh.

The header band and tab band are sticky as a unit; the toolbar scrolls away.

**Period picker.** A single component used on Timesheet, Team, Projects, Invoices, and every report. Left chevron, a calendar-icon button showing the resolved label and range (`This quarter 01 Jul - 30 Sep 2026`), right chevron. Clicking the label opens a popover: a granularity segmented control (Day / Week / Month / Quarter / Year / Custom), a preset list (Today, Yesterday, This week, Last week, This month, Last month, This quarter, Last quarter, This year, Last year, All time) with a 16px bold check on the selection, and behind a hairline in the footer a custom range with two date inputs and an Apply button. Chevrons step by the current granularity. Range and granularity both live in the URL.

---

## 4. Cross-cutting patterns

### 4.1 Tables

Every table is an **AG Grid Community** instance wrapped in one `DataGrid` component. One grid engine means one keyboard model, one selection model, one export path, and one place to fix a bug. Virtualization is the reason it earns its weight: large project and invoice lists render in constant time. Configuration lives in [`design system/recipes/grid.ts`](../design%20system/recipes/grid.ts) and the theme in [`ag-grid-theme.ts`](../design%20system/tokens/ag-grid-theme.ts), which maps AG Grid's parameters onto our tokens so the grid inherits both themes with no dark-mode code of its own.

**Where the grid is not used.** Three surfaces stay plain HTML tables, deliberately:

- **The invoice document**, because it must render identically in the app, the PDF, and the client pay page, and a virtualized grid inside a Playwright PDF render is not identical to anything.
- **Anything printed** (reports sent to PDF, the printed invoice), because virtualization means only visible rows exist in the DOM, so a printed grid is a screenshot of the viewport.
- **Short fixed lists** under roughly twenty rows with no sorting or selection: the Day view entry list, KPI sub-rows, rate history, invoice history. Loading a 300KB grid to render six rows is a poor trade.

**The Community boundary.** We are on the MIT Community edition. Row grouping, aggregation, master/detail, the columns tool panel, the set filter, the context menu, and Excel export are Enterprise. Three of those are specified in this document, so each has a Community pattern:

| Enterprise feature | What we do instead |
|---|---|
| Row grouping | Group headers are full-width rows injected into the flat row array, in server order |
| Aggregation | Group and grand totals are computed server-side and carried on the group row |
| Master / detail | Detail panels are full-width rows injected on expand |
| Columns tool panel | Our own Columns popover, already specified below |
| Set filter | Filter chips in the page toolbar, already specified in §3.5 |
| Context menu | The row Actions menu, already specified below |
| Excel export | CSV client-side; XLSX from the server export job |

Server-computed totals are the better design regardless of licensing: client-side aggregation would re-derive figures in the browser under different rounding than the server applies, and would sum columns the current user may not be permitted to see.

Anatomy:

- **Header row:** `--bg-muted`, `--fs-xs` uppercase `--text-tertiary`, sticky under the toolbar. Sortable headers show a chevron on hover and a filled chevron plus `aria-sort` when active.
- **Rows:** 44px in comfortable density, 36px in compact. Hairline `--border` between rows, no verticals. Hover `--surface-hover`.
- **Group headers** (client name on the Projects list, week range on Expenses): a full-width `--bg-subtle` row with the group label in `--fw-medium` and the group's totals right-aligned.
- **Numeric columns** are right-aligned with tabular figures. Text columns are left-aligned. There is no centred column.
- **Row actions:** an "Actions ▾" button in the last column, revealed on row hover or focus and always present for the keyboard cursor row.
- **Selection:** a leading checkbox column when bulk actions apply. Selecting anything raises the bulk action bar (§4.4).
- **Density and columns:** a "Columns ▾" popover with checkboxes plus a density toggle, persisted per user per table.
- **Export:** opens a small modal with two segmented choices, scope and format. Scope offers the same buckets as the page's status filter with live counts (`Active (40)`, `Budgeted (18)`, `Archived (463)`), because the most common export mistake is exporting only what happened to be filtered on screen. Format offers CSV and XLSX; anything over 5,000 rows queues server-side and emails a link rather than blocking the tab. The export always carries a header describing the filters that produced it, so a figure in a spreadsheet can be traced back to the query behind it.
- **Totals row:** AG Grid `pinnedBottomRowData`, `--fw-semibold`, `border-top: 1px solid var(--border-strong)`. It never scrolls away and is never sorted into the body. When a list is paginated, it is labelled "Total for all pages" and reflects the full result set, not the page. The value comes from the API, never from summing loaded rows.
- **Virtualization** is on for every grid, always, rather than switching on above a threshold. A table that changes its scrolling behaviour based on row count behaves differently in dev than in production.
- **Row click opens the record; only the checkbox selects.** `enableClickSelection: false`, so nothing is selected by accident on the way to a detail page.
- **Empty and loading states are ours, not the grid's.** AG Grid's built-in overlays are suppressed: a bare centred string with nowhere to go is worse than an empty state carrying the action that would fill the table.

### 4.2 Forms

- Label above input, `--fs-base` `--fw-medium`. Help text below in `--fs-sm` `--text-tertiary`. Error text below in `--fs-sm` `--danger` with a 12px alert icon, and the input border goes `--danger`.
- Inputs are 36px tall, `--r-md`, `--surface` background, `--border` ring, hover `--border-strong`, focus `--info` border plus a 3px 20%-alpha ring.
- Validation is on blur for format and on submit for everything. Never validate on every keystroke.
- The primary submit button is disabled only while the request is in flight, and it shows a spinner in place of its icon plus the label "Saving…". It is never disabled because the form is invalid; submitting an invalid form focuses and announces the first error.
- Editors that live inside a page (project settings, invoice settings, person settings) autosave per field group on blur with a `--text-tertiary` "Saved" flash beside the section heading. Editors that create something (New project, New invoice) use an explicit submit.
- Any form with unsaved changes intercepts navigation and `beforeunload`.
- **Duration inputs accept everything sensible:** `1.5`, `1,5`, `90m`, `1h30`, `1:30`, `1h 30m`. They normalise on blur to the account's display format. A range input accepts `9-10:30`, `9am-10:30am`, `09:00 to 10:30`.
- **Money inputs** accept `1200`, `1,200`, `1200.00`, `$1200` and normalise on blur.

### 4.3 The project/task picker

This control appears in the time entry editor, the expense editor, invoice line items, and the command palette. It is used more than any other input in the product, so it gets its own spec.

- A single combobox showing `Client name` on a small `--text-tertiary` line above `Project name` in `--fw-medium`, so both are readable without opening it.
- Opening it shows a search field and a grouped list: **Recent** (your last 5 project/task pairs, pinned) then **Pinned** then all assigned projects grouped by client.
- Search matches against client name, project name, project code, and task name simultaneously, with fuzzy subsequence matching and match highlighting. Typing `budgetnista des` finds "Example Learning → Example Client 40 plan → Design".
- Selecting a project auto-selects the task you used last on that project, else the project's first billable task by name (there is no stored "default task" concept). The task combobox is separate but pre-filled, so the common path is one selection, not two.
- The full assigned-project list is prefetched on app boot (it is small) and held in a client cache, so the picker opens instantly and filters with zero network round-trips.
- Archived projects never appear. A project whose date range has ended appears with a `--text-tertiary` "ended" chip but is still selectable, because people log time late.

### 4.4 The action row, and the no-shift rule

**Clicking anything in a table must never move the table.** A user ticking checkboxes down a column is aiming at a target; if the first tick pushes the grid down by one row, the second tick lands on the wrong record. On a forty-row bulk edit that is not a risk, it is a certainty. This is a hard rule, and it outranks any individual design preference below.

Every grid therefore sits under an **action row**: a region that is always present in the layout at exactly `--action-row-h` (48px), whatever it happens to be showing. Three states are layered on top of each other and cross-faded. Because all three are absolutely positioned inside a fixed-height container, the height cannot change, even mid-transition.

| State | Shows | When |
|---|---|---|
| **browse** | Filters, column picker, density toggle, export | Nothing selected |
| **select** | `N selected`, Clear, the applicable bulk actions | One or more rows ticked |
| **act** | The chosen action's inline form | An action has been chosen |

`Esc` steps from **act** back to **select**; Clear steps from **select** back to **browse**. Actions come from the same registry that powers Settings → Bulk actions (§17.6), so the two surfaces can never drift.

**Action order in the select state is fixed.** The selection count and Clear sit at the leading edge, then a hairline, then the **modify** actions (Add tags, Set rate, Set tasks billable) ordered by frequency. **Removal** actions (Archive, then a hairline, then Delete) are pushed to the **trailing edge**. The gap between the two groups is deliberate distance rather than decoration: someone clicking along a row of small buttons should never be one pixel of misjudgement away from deleting forty records. Archive stays visually secondary and Delete stays `--danger`, because one is reversible and the other is not. On a narrow screen the auto margin collapses and the group scrolls, so nothing becomes unreachable.

**How an action collects its input is a layout decision, not a preference:**

- `immediate` runs on click with an Undo toast (Archive, Reactivate, Mark as sent).
- `inline` renders a one-row form in the action row: one control, confirm, cancel (Set rate, Set tasks billable, Update due date).
- `modal` covers anything larger, and anything needing typed confirmation (Add tags, Assign to projects, Record payment, Delete).

There is no fourth option that grows the action row. An action needing more space gets a modal, which is an overlay and shifts nothing.

**The six ways a table normally shifts, and what we do instead:**

| Normally | Instead |
|---|---|
| Selection adds a border to the row | Selection is a background plus an *inset* shadow. Inset paints; it does not reflow. |
| Row actions appear on hover | Actions always occupy their space and toggle `opacity`. Never `display`, never a width change. |
| A menu expands inline and pushes rows down | Menus are portalled overlays positioned above the grid. |
| A bulk bar appears on selection | The action row is always in the layout. Only its contents change. |
| An action form grows the toolbar | Inline if it fits one row, modal otherwise. |
| The grid resizes as rows load | The page owns the grid's height; the grid scrolls inside it. |

A floating bar pinned to the bottom of the viewport was considered and rejected: it shifts nothing, but it covers the last rows of the table, which are exactly the rows someone scrolled down to select.

**This applies to every table in the product, not only grids.** Any list with a checkbox, an Actions menu, or a hover-revealed control follows the same rule. The test is mechanical: screenshot, interact, screenshot, diff. Any vertical movement outside the action row's own contents is a bug.

Applying a bulk action opens a review step stating exactly what will change and how many rows are affected, including a warning for anything that will be skipped ("3 projects have running timers and will be flagged"). After it runs, a result toast reports `N succeeded, M skipped` with a "View details" link to the run record.

**Selection survives a refetch.** Stable row IDs mean a live update, a background refresh, or a re-sort does not clear what the user had ticked. Losing a forty-row selection to a websocket event is its own kind of layout betrayal.

### 4.5 Toasts, undo, and confirmation

- Toasts stack bottom-right, max 3 visible, 5s auto-dismiss (8s if they carry an Undo), `role="status"`, dismissible.
- **Undo** is offered on: delete time entry, delete expense, archive anything, bulk actions, and invoice write-off. Clicking Undo (or `⌘Z` while the toast is visible) issues the compensating request. The window is the toast lifetime plus 10s of server-side grace.
- **Confirmation dialogs** are reserved for genuinely irreversible actions: hard delete of an invoice, deleting a client with history, deleting a retainer, revoking an integration. They state the consequence in plain language, name the specific record, and require typing the record's name for the most destructive tier. The confirm button is `--danger` filled; Cancel is the default focus.
- Archive is always preferred over delete and never confirms; it just toasts with Undo.

### 4.6 Empty, loading, and error states

**Loading.** Skeletons that match the final layout's geometry, never spinners on a full page. A route transition shows a 2px indeterminate progress bar under the top bar after 300ms of pending navigation (not before, to avoid flicker on fast transitions). Tables render skeleton rows at the row height. Charts render a static plot frame with a shimmering plot area.

**Empty.** Every empty state has three parts: a one-line explanation of what would appear here, the primary action that would fill it, and nothing else. No illustrations except on the four "you have never used this feature" screens (Retainers, Approvals, Saved reports, Expenses), which get a simple line-art mark in `--text-tertiary`.

The Timesheet's empty day is the exception and keeps Harvest's small delight: a centred quotation in `--bg-muted` at `--r-lg`, `--text-secondary`, rotating daily from a short curated list. It is the one place in the product where charm beats density.

**Error.** Inline errors sit where the failure happened, never as a toast for a form. A failed data fetch renders a card with the error, a Retry button, and a "Copy error details" link that copies a request ID for the logs. A route-level error boundary catches the rest and offers Reload plus Go to Timesheet. Never a blank screen.

**Offline.** A `--warning` bar slides under the top bar reading "Offline. Timer is still running and changes are queued." Mutations queue in IndexedDB and replay on reconnect in order. The running timer keeps ticking against local time and reconciles with the server on reconnect (server wins on `timer_started_at`, client wins on notes typed while offline). See [BACKEND_PRD.md §6.7](BACKEND_PRD.md#67-idempotency-and-offline-replay).

### 4.7 Real-time behaviour

A single SSE connection is opened at app boot and shared by every component through a subscriber bus. Events invalidate TanStack Query keys rather than mutating caches directly, except where the payload is complete enough to patch in place (timer start/stop, approval status).

What updates live, without a refresh:

- Your own running timer, across every tab and device you have open. Starting a timer in one tab stops it in another and both reflect it instantly.
- The Team page "tracking now" indicators.
- Approval queue counts in the sidebar.
- Invoice status changes (someone else marks paid, a Stripe payment lands).
- Budget alerts crossing a threshold.

Reconnect is exponential backoff with jitter, capped at 30s. A dropped connection shows no UI at all until it has been down for 15 seconds, at which point a subtle `--text-tertiary` "Reconnecting…" appears in the top bar.

---

## 5. Track: Timesheet

> **Phase:** 1 (Day view, timer, entry editor) · 1.5 (Week view, Calendar view, mobile Track)

**Route:** `/timesheet?view=day|week|calendar&date=YYYY-MM-DD&user=<id>`

**Purpose:** log time in as few keystrokes as possible, and see at a glance whether the week is complete.

The three views share one header, one date navigator, and one data source. Switching views never loses the date or the selected teammate.

### 5.1 Shared header

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ Timesheet                        Saved 0:00pm  [Day│Week│Calendar]  [Me ▾]    │
├───────────────────────────────────────────────────────────────────────────────┤
│ [+ New]  [← 📅 Today Thursday, 00 Aug →]  Return to today          [Submit ▸] │
├───────────────────────────────────────────────────────────────────────────────┤
│  Mon      Tue      Wed      Thu◉     Fri      Sat      Sun       Week total    │
│  0:00     0:00     0:00     0:00     0:00     0:00     0:00      00:00 / 00    │
└───────────────────────────────────────────────────────────────────────────────┘
```

- **View toggle:** a three-segment control, `--bg-muted` track, active segment `--surface` with `--sh-xs`. Keyboard `D`, `W`, `C`.
- **Teammate switcher:** labelled "Me" by default. Opens a searchable list grouped Employees / Contractors. Only rendered for profiles with `time:edit_others`. Selecting someone else pins a `--warning-bg` banner across the top of the content: an avatar, "Editing **Sample Person06's** timesheet. Changes save to Person06's timesheet.", and a "Return to my timesheet" link. This banner is unmissable by design; editing someone else's time by accident is a real risk.
- **Autosave indicator:** `Saved 8:17pm` in `--text-tertiary`, becoming `Saving…` with a 12px spinner during a write and `Not saved - retrying` in `--warning` on failure.
- **Week strip:** seven columns, each a button that jumps to that day. Day name at `--fs-base` `--text-secondary`, total below in `--fw-semibold`. The current day is `--text` with a 2px `--accent` underline; today, when not selected, gets a small dot. A day whose total is zero on a past weekday shows its total in `--text-tertiary` with a 6px `--warning` dot when the account has "flag missing time" on. The right-most cell is Week total over capacity, e.g. `23:09 / 40`, with the number turning `--success` at or above capacity.
- **Submit button** appears only when the approvals module is on and the selected week is unsubmitted. Its label reflects state: `Submit week`, `Submitted ✓` (disabled, `--success` text), or `Rejected - resubmit` (`--danger` outline).

### 5.2 Day view

The default. A vertical list of entries for the selected day.

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ 00:00am   Example Client 04 · Example Project 02                 │
│  0:00pm   Design  ·  Calendar sync options and empty screen changes    0:00 ▶ ⋯│
├───────────────────────────────────────────────────────────────────────────────┤
│  0:00pm   Example Client 04 · Example Project 02                 │
│  0:00pm   Design                                                       0:00 ▶ ⋯│
├───────────────────────────────────────────────────────────────────────────────┤
│ ◉ running Example Client 04 · Example Project 02                 │
│  0:00pm   Meetings/Collaboration                                    ● 0:00 ⏹ ⋯│
├───────────────────────────────────────────────────────────────────────────────┤
│                                                            Total       0:00    │
└───────────────────────────────────────────────────────────────────────────────┘
[ Copy from Wednesday, 00 Aug ▾ ]
```

**Row anatomy** (72px tall):
- **Time column** (88px, mono `--fs-sm`): start over end when the account uses start/end mode; a clock glyph and "duration only" dash otherwise.
- **Body:** client name in `--text-tertiary` `--fs-sm` on line one alongside the project name in `--fw-medium`; task name in `--text-secondary` on line two, then a bullet separator and the note in `--text-secondary`. Notes clamp to one line and expand on click.
- **Right cluster:** duration in `--fs-lg` `--fw-semibold` tabular, then a Start (▶) or Stop (⏹) button, then an overflow `⋯` menu (Edit, Duplicate, Duplicate to tomorrow, Split entry, Delete).
- **Running row** gets `--live-bg`, a 3px `--live` left rail, a pulsing dot before the duration, and its duration ticking live.
- **Locked row** (attached to a sent invoice) shows a 12px lock glyph next to the duration, the row is `--bg-subtle`, and Edit is replaced by "View invoice". An Administrator sees "Unlock" in the overflow.
- **Non-billable row** shows a small `Non-billable` outline chip after the task name.

**Interactions:**
- Click anywhere on the row body opens the inline editor (§5.5), expanding the row in place rather than opening a modal. This is faster and keeps context.
- `▶` on a stopped row starts a *new* timer with the same project, task, and notes on today's date. It does not resume the old entry, which keeps the audit trail honest. A toast confirms with the project name.
- Drag a row's grip (revealed on hover at the far left) onto a day in the week strip to move it to that day.
- **Copy from previous day:** a split button. The main action copies the most recent day with entries, projects and tasks only, zero durations. The chevron offers "Copy with durations", "Copy from a specific day…", and "Copy last week's Thursday".
- The total row is pinned at the bottom of the list.

**Empty state:** the rotating quotation card, plus the copy-from-previous-day control below it, plus a large ghost "+ Add your first entry" affordance.

### 5.3 Week view

A grid: one row per unique project+task+notes combination, one column per day.

```
┌────────────────────────────────────────────────────────────────────────────────┐
│                                    Mon   Tue   Wed   Thu◉  Fri   Sat   Sun  Tot│
│                                    00    00    00    00    00    00    00      │
├────────────────────────────────────────────────────────────────────────────────┤
│ Example Travel · PRODUCT OWNER…                                                     │
│ Design                        [📝] 0:00  0:00  0:00  0:00  ―     ―     ―   00:00│
├────────────────────────────────────────────────────────────────────────────────┤
│ Example Travel · PRODUCT OWNER…                                                     │
│ Meetings/Collaboration        [📝] 0:00  ―     0:00  0:00  ―     ―     ―    0:00│
├────────────────────────────────────────────────────────────────────────────────┤
│ + Add row                                                                      │
├────────────────────────────────────────────────────────────────────────────────┤
│ Daily total                        0:00  0:00  0:00  0:00  0:00  0:00  0:00 00:00│
└────────────────────────────────────────────────────────────────────────────────┘
```

**This view is fully editable in every timer mode.** Harvest disables Week view when the account uses start-and-end-time mode; we do not. When an account tracks start and end times, typing a duration into a week cell creates an entry whose start time is inferred by appending to that day's last entry (or to the account's default day-start time if the day is empty), and a small clock glyph in the cell corner marks the times as inferred. Hovering shows "9:00am - 10:30am (inferred)". This removes the single most confusing limitation in the current tool.

**Cell behaviour:**
- Cells are text inputs that look like plain text until focused. Focus reveals the input ring.
- `Tab` moves right, `Shift+Tab` left, `Enter` moves down, arrow keys navigate without entering edit mode, typing a digit enters edit mode and replaces.
- Empty cells show an em-width dash in `--text-tertiary`. Zero shows `0`.
- A cell with more than one underlying entry (same project/task/notes, tracked twice) shows the sum with a small stacked-layers glyph; clicking it expands the row into its constituent entries for that day.
- The notes button `[📝]` opens a popover with a per-day note grid so notes can be edited without leaving the view. A filled glyph means a note exists.
- The running entry's cell shows the live-ticking duration on `--live-bg` and is read-only while running.
- `⌫` on a focused cell clears it, with Undo.

**Row actions:** an `×` at the row end removes the whole row (all its entries for the week) with Undo. The row header is clickable to change the project or task for all of that row's entries at once.

**+ Add row** appends an empty row with the project picker focused. Selecting a project and task and then tabbing into a day cell is the full path to logging a week.

### 5.4 Calendar view

A time-grid week, the fastest way to reconstruct a day you forgot to track.

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ [+] [← This week 00 - 00 Aug 0000 →]  [0-day ▾]        [👁 show calendar] [⋯] │
├────────────────────────────────────────────────────────────────────────────────┤
│         Mon 00    Tue 00    Wed 00    Thu 00    Fri 00                         │
│          0:00      0:00      0:00      0:00      0:00                          │
│  0am   ┌───────┐                                                               │
│        │Design │                                                               │
│ 00am   │Arc Tr.│                                                               │
│        │       │ ┌───────┐                     ┌───────┐                       │
│ 00am   │       │ │Design │                     │Design │                       │
│        └───────┘ │Arc Tr.│                     │Arc Tr.│                       │
│ 00pm             │ 0:00  │                     │ 0:00  │                       │
│                  │       │                     │       │  ← drag to create     │
│  0pm             └───────┘                     └───────┘                       │
└────────────────────────────────────────────────────────────────────────────────┘
```

- **Granularity toggle:** 5-day (Mon-Fri) or 7-day. Persisted.
- **Column headers** show the day and that day's total, with today's column tinted `--bg-subtle` and its header in `--live` when a timer runs.
- **Blocks** are `--r-md`, filled with the project's assigned colour at 90% opacity, with the project name in `--fs-xs` `--fw-medium`, task below, client below that, and the duration top-right. Blocks under 30 minutes collapse to a single line. Overlapping blocks side-by-side with a 2px surface gap.
- **Drag on empty grid** creates an entry snapped to 15-minute increments, opening the editor popover pre-filled with the dragged times.
- **Drag a block** moves it; **drag its bottom edge** resizes it. Both write on drop with an optimistic update.
- **Click a block** opens the editor popover anchored to it (project/task combo, notes, start, end, computed duration, Save, Cancel, a calendar-import glyph, and Delete in `--danger` on the right).
- **Show calendar** (the eye toggle) overlays your connected Google Calendar events as ghost blocks: `--bg-muted` fill, dashed `--border-strong` outline, `--text-secondary` text, non-interactive except for a "Track this" button that appears on hover and converts the event into a time entry pre-filled with its title as the note and its times as the range. This is the single best feature for people who forget to start timers.
- **Now line:** a 1px `--live` horizontal rule across today's column with a 6px dot at the left edge, positioned at the current time and updated each minute. The view auto-scrolls so the now line is at 40% viewport height on load.

### 5.5 Time entry editor

Used inline (Day view row expansion), as a popover (Calendar view), and as a modal (from `N`, the plus menu, or the command palette). Same fields, same validation, same shortcuts in all three.

```
┌──────────────────────────────────────────────┐
│ New time entry                            ×  │
├──────────────────────────────────────────────┤
│ Date                                         │
│ [ 00/00/0000                              ▾] │
│ Project / Task                               │
│ ┌──────────────────────────────────────────┐ │
│ │ Ann & Robert H Example Client 29 │ │
│ │ Example Project 01       ▾ │ │
│ └──────────────────────────────────────────┘ │
│ [ Account Management                      ▾] │
│ ┌──────────────────────────────────────────┐ │
│ │ Notes (optional)                         │ │
│ └──────────────────────────────────────────┘ │
│ Time                                         │
│ [ 0:00am ] to [ 00:00am ] = [ 0:00 ]         │
│ ☐ Non-billable                               │
├──────────────────────────────────────────────┤
│ [ Start timer ] [ Save ]  [Cancel]  📅 Import│
└──────────────────────────────────────────────┘
```

Field rules:

- **Date** defaults to the currently selected day. A date picker with a "Today" shortcut. Dates outside the project's start/end range are allowed but show a `--warning` hint.
- **Project / Task** is the picker from §4.3.
- **Notes** is a 3-row auto-growing textarea. It supports `@mention` of a teammate (which notifies them) and pasting a URL renders it as a link in read views. Notes are required when the project or task is configured to require them (a per-project setting), and the Save button explains why if it blocks.
- **Time** adapts to the account's timer mode. In start/end mode all three fields show and any two drive the third: typing a duration with a start time sets the end, typing both times sets the duration. In duration mode only the duration field shows.
- **Non-billable** is a checkbox, not a toggle, and is pre-set from the project task's billable default. It is hidden entirely on Non-billable projects.
- **Start timer** vs **Save**: `Start timer` is the primary action when the duration is empty; `Save` becomes primary as soon as a duration exists. Only one is ever `.btn-primary`.
- **Import from calendar** opens a list of today's calendar events; choosing one fills times and notes.

Shortcuts: `⌘Enter` save, `⌘⇧Enter` save and start, `Esc` cancel (with a confirm if dirty), `⌘⌫` delete (edit mode only).

**Permissions:** the date field is disabled and the entry is read-only when the entry is locked to a sent invoice, or when the week is submitted and awaiting approval (unless you are the approver). Creating a new entry dated into an **approved** week is refused with an explanatory message; Administrators and People Admins can override, which flags the week as amended and notifies the approver ([BACKEND_PRD.md §4.10](BACKEND_PRD.md#410-editability)).

### 5.6 Quick Timer popover

Opened from the top bar or by pressing `T` when nothing is running. A compact 360px popover anchored to the timer pill: project picker, task picker, notes, an expandable "Time" disclosure for entering a start time retroactively, and a single `Start timer` button. Two fields and a keystroke from anywhere in the app.

If the user has a most-recent entry from today, the popover pre-fills it and the button reads `Resume: Design · Example Travel`. This is the single most common case and should take one keypress: `T`, `Enter`.

Starting a timer while one is running stops the running one first and shows a combined toast: "Stopped *Design* at 1:24. Started *Programming*." with an Undo that restores the previous state exactly.

### 5.7 Mobile Track

Track is the one surface that must be excellent on a phone. At `sm`:

**Day view is the only timesheet view.** Week and Calendar redirect to it with a "best on a larger screen" toast rather than rendering a broken grid. Layout:

- The week strip compresses to seven 40px columns, horizontally scrollable, selected day centred.
- Entry rows keep the same anatomy minus the leading time column; start and end times move to the second line beside the duration.
- Row actions move into a bottom action sheet, opened by long-press or the `⋯` button.
- `+ New` is a 56px floating action button, bottom-right, sitting above the tab bar.

**The timer bottom sheet** replaces the top-bar pill: a persistent 56px bar above the bottom tab bar showing the pulsing dot, the elapsed time, the project name, and a stop button. Tapping it expands a half-height sheet containing the full Quick Timer form (§5.6). When nothing is running the bar collapses away and the FAB is the entry point.

**Editors** (time entry, expense) open as full-height sheets rather than modals, with the primary action pinned to the bottom edge above the keyboard. All inputs are 44px tall at `sm`.

**Bottom tab bar:** Track, Approvals (badge-counted, rendered only for approvers), Projects, Reports, More. "More" opens a sheet listing the remaining nav items the user's profile allows.

---

## 6. Track: Expenses

> **Phase:** 2

**Route:** `/expenses?tab=all|reimbursements|categories&range=…&user=…`

### 6.1 All expenses

Grouped by week, newest first, matching the mental model of an expense report.

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ Expenses                                        [Filters ▾] [+ Track expense] │
├───────────────────────────────────────────────────────────────────────────────┤
│ All expenses │ Reimbursements 0 │ Categories                                  │
├───────────────────────────────────────────────────────────────────────────────┤
│ 00 - 00 May 0000                                                              │
│ ┌───────────────────────────────────────────────────────────────────────────┐ │
│ │ Sat, 00 May  Operations (Example Internal)                                   │ │
│ │              Other · Transcription System            🧾   $0.00   [Edit]  │ │
│ └───────────────────────────────────────────────────────────────────────────┘ │
│                                                          Total:      $0.00    │
├───────────────────────────────────────────────────────────────────────────────┤
│ 00 Apr - 00 May 0000                                                          │
│ …                                                                             │
└───────────────────────────────────────────────────────────────────────────────┘
```

Row: date (88px), project in `--fw-medium` with client in parentheses `--text-tertiary`, category on line two, notes on line three in `--text-secondary` clamped to one line, then a receipt thumbnail chip (24px, opens a lightbox) if attached, the amount right-aligned in `--fw-semibold`, then Edit. Billable expenses carry a `Billable` chip; reimbursable ones carry a `Reimbursable` chip in `--info`. An expense in a submitted or approved week gets the same lock treatment as a time entry (§7); one attached to a sent invoice shows the lock glyph and "View invoice".

Each week group has its own totals row. The toolbar filters by person, client, project, category, billable, reimbursable, and approval status.

**Expense editor** (modal): Date, Project (picker), Category, then a branch:
- Unit-priced categories (Mileage at $0.45/mile) show `Units` and compute `Total` read-only with the rate displayed beneath.
- All others show `Total` directly.
Then Notes, a receipt dropzone (drag, paste from clipboard, or file picker; images and PDF, 10MB max, with an inline preview), `Billable` checkbox, `Reimbursable` checkbox. Save / Cancel / Delete.

### 6.2 Reimbursements

A queue, not a payment rail. We do not move money; we produce the export the bookkeeper needs.

Table: Person, Date, Project, Category, Notes, Receipt, Amount, Status (`Pending`, `Approved`, `Paid`). Bulk select to `Approve`, `Mark paid`, or `Export selected` (CSV plus a ZIP of receipts). A summary strip above shows Pending count and total, Approved count and total.

### 6.3 Categories

Simple list with an inline editor per row, exactly like the Tasks page. Fields: name, optional unit name and unit price (which turns it into a unit-priced category), and an "archive" action. Categories in use cannot be deleted, only archived; the Delete button is disabled with a tooltip explaining why.

---

## 7. Review: Approvals

> **Phase:** 2

**Route:** `/approvals?tab=pending|history&week=YYYY-MM-DD`

New capability, not present in the current tool, and the main reason a contractor-heavy roster needs its own product.

### 7.1 Approver view

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ Approvals                                    [← Week 00 - 00 Aug 0000 →]      │
├───────────────────────────────────────────────────────────────────────────────┤
│ Pending 0 │ History                                                           │
├───────────────────────────────────────────────────────────────────────────────┤
│ ☐ Person              Submitted     Hours   Billable   Capacity   Flags       │
│ ☐ 👤 Sample Person06      Mon 0:00am    00:00    00:00     00      ⚠ 0 gaps       │
│ ☐ 👤 Sample Person10     Mon 0:00am    00:00    00:00     00                     │
│ ☐ 👤 Sample Person07   ―             00:00    00:00     00      ⚠ not submitted│
├───────────────────────────────────────────────────────────────────────────────┤
│ [0 selected]  [Approve]  [Request changes]           [Remind unsubmitted]     │
└───────────────────────────────────────────────────────────────────────────────┘
```

- A submission covers the period's time **and expenses** together. Clicking a row expands it into a read-only week grid of that person's entries grouped by project, followed by the period's expenses with receipt thumbnails, each with a per-entry comment affordance. The approver can approve the week, or request changes with a required note, which reopens the week for editing and notifies the person by email and Slack.
- **Flags** are computed server-side and shown as `--warning` chips: `N gaps` (weekdays with zero hours), `over capacity`, `missing notes on N entries`, `missing receipt on N reimbursable expenses`, `future-dated`, `retroactive` (entries edited after submission).
- Bulk approve is the common path; the flags exist so bulk approve stays safe.
- "Remind unsubmitted" sends the nudge email and Slack DM to everyone in the period without a submission.

### 7.2 Submitter view

The Timesheet's Submit button and a `/approvals/me` page showing your own submission history: week, submitted at, status, reviewer, and their note. A rejected week shows the note prominently in a `--danger-bg` banner on the Timesheet when that week is selected.

**Locking:** an approved week's entries and expenses become read-only for the submitter, and new records cannot be added into the period - the lock is period-based, so back-dating an entry into an approved week is refused rather than silently slipping past approval. Administrators and People Admins can edit or add, which writes an audit row and flags the week as amended ([BACKEND_PRD.md §4.10](BACKEND_PRD.md#410-editability)).

### 7.3 Mobile approvals

At `sm` the approver queue renders each pending submission as a card: avatar, name, hours against capacity as a proportional bar, flag chips, and full-width `Approve` / `Request changes` buttons. Tapping the card body expands the read-only entry and expense list inline. Bulk selection is replaced by a single `Approve all unflagged` action with a confirm sheet naming the people and total hours. This is the flow that lets a manager clear Monday approvals from a phone in under a minute.

---

## 8. Organize: Team

> **Phase:** 1 (members list, person settings, invites) · 2 (rates, utilization, assignments)

**Route:** `/team?tab=members|assignments&week=…&filter=…`

### 8.1 Members

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ Team              [+ Invite person] [Actions ▾] [Import] [Export] [Archived →]│
├───────────────────────────────────────────────────────────────────────────────┤
│ Members │ Assignments                                                         │
├───────────────────────────────────────────────────────────────────────────────┤
│ [← 📅 This week 00 - 00 Aug 0000 →]                                           │
│                                                                               │
│ Total hours     Team capacity     ■ Billable      00.00  ▇▇▇▇▇▇▇▇▁▁▁▁▁▁▁▁▁▁  │
│ 00.00           000.00            ■ Non-billable   0.00   00%  00%  00%  00%  │
│                                                                               │
│ [🔍 Filter by name          ]  [Everyone ▾]  [Role ▾]  [Department ▾]         │
├───────────────────────────────────────────────────────────────────────────────┤
│ ▾ Employees (0)          Hours              Utilization  Capacity  Billable   │
│   ● 👤 Sample Person04  Member    0.00  ▁▁▁▁▁▁▁▁     0%        00.00      0.00  ⋯ │
│   ◉ 👤 Sample Person01   Owner    00.00  ▇▇▇▇▁▁▁▁    00%        00.00     00.00  ⋯ │
│ ▾ Contractors (0)                                                             │
│   ● 👤 Sample Person06  Member   00.00  ▇▇▇▇▇▁▁▁    00%        00.00     00.00  ⋯ │
└───────────────────────────────────────────────────────────────────────────────┘
```

- **Summary strip:** Total hours, Team capacity, and a billable/non-billable proportional bar with axis ticks at 20/40/60/80%. The bar uses `--info` for billable and a 45% tint of it for non-billable, with both directly labelled.
- **Grouping** by Employees / Contractors, collapsible, counts in the header. A secondary grouping option (by Role, by Department, none) sits in the Columns popover.
- **Presence dot** before each avatar: `--live` and pulsing when that person has a timer running right now, `--text-tertiary` hollow otherwise. Hovering shows "Tracking *Design* on *Example Travel* for 1:24".
- **Utilization bar** per row: a track in `--bg-strong` with a billable segment in `--info` and a non-billable segment in a 45% tint, capped at 100% with the overflow rendered as a `--warning` cap.
- **Row hover** reveals a 30-day bar sparkline in the row's trailing space (desktop `xl` only), giving instant read on consistency.
- **Actions menu** per row: View report, Edit profile, Edit rates, Assign to projects, Send reminder, Archive.
- Clicking a name opens the person detail page.

### 8.2 Person detail

**Route:** `/team/:userId?week=YYYY-MM-DD`

Two-column: a 400px left rail of summary cards, a fluid right column of the day-by-day entry list.

**Left rail cards:**
1. *Hours* - Total hours and Capacity as two hero numbers side by side, a proportional bar beneath, then legend rows for Billable and Non-billable with their values.
2. *Weekday strip* - seven mini columns with day abbreviations and totals.
3. *Projects breakdown* - a stacked proportional bar using the categorical palette, then a legend list of project name and hours, sorted descending, capped at 8 with the remainder folded into "Other".
4. *Tasks breakdown* - same treatment.

**Right column:** one card per day, from Monday to Sunday. Each card has a `--bg-subtle` header with the date, then entry rows (start/end times, project with client, task, note, duration, Edit), then a right-aligned day total. Days with no time read "No time tracked" in `--text-tertiary`.

**Header:** back link to Team (or to whatever list you arrived from), the person's avatar at 56px, name at `--fs-2xl` with a profile badge chip, their role and email beneath, then `Edit profile` and an `Actions ▾` menu (Edit rates, Assign to projects, Send reminder, Archive, Reset password).

**Permissions:** a Member reaching `/team/:id` for anyone but themselves gets a 404, not a 403 (do not confirm the existence of records the user cannot see). Cost rate figures render only for `rates:view_cost`; billable figures only for `rates:view_billable`.

### 8.3 Person settings

**Route:** `/team/:userId/settings/:section`

A two-pane layout: a 280px left nav listing sections, the form on the right. The person's avatar, name, email, and profile badge sit above the nav.

| Section | Contents |
|---|---|
| **Basic info** | First name, Last name, Work email (read-only when SSO-provisioned, with a hint naming Google Workspace as the source: read-only and disabled must look different, or people hunt for a button that does not exist), Employee ID, Roles (multi-select token input, creatable), Departments (multi-select), Capacity (a dropdown of 20/30/35/40/custom hours per week), Rates (a link to the Rates section), Timezone, Photo, Employment type (Employee / Contractor), Start date, End date. |
| **Photo** | Part of Basic info. A drop target accepting drag, clipboard paste, and the file picker, with the circular mask previewed live at 56px so nobody uploads an image that loses its subject to the crop. JPG, PNG, or WebP, 5MB max. Change and Remove actions. Uploads are re-encoded server-side: EXIF stripped (a phone photo carries GPS coordinates), resized to a 256px square, and a 64px thumbnail generated for table rows. The original is never served back to another user's browser. The fallback chain when there is no photo is initials on a gradient derived from a hash of the user ID, then a generic glyph. The gradient is never derived from list position, which would change the colour when a list re-sorts. |
| **Rates** | Two dated-rate tables, Billable and Cost, each with New / Edit / Delete. Columns: Hourly rate, Start date, End date. A rate row's end date is derived from the next row's start; "All prior" and "All future" render at the boundaries and the current row carries a `Current` chip. Adding a rate that would create a gap or overlap is rejected inline with the specific conflict named. Cost rates are visible only with `rates:view_cost`, and the section is absent otherwise. |
| **Assigned projects** | A table of every project this person can track to, with a `Manages this project` checkbox per row and Select All / None. A `--warning` banner appears when the person is on "assign to all projects" mode, with a Disable link. Search and client grouping match the Projects list. |
| **Assigned people** | For managers: which people they can see and approve. Shows an informational card instead when the profile already grants account-wide access. |
| **Permissions** | Radio list of the six base profiles plus any custom profiles, each with its one-line description. A `--warning` banner explains that Administrators have unrestricted access. Selecting a non-Administrator profile reveals a "Customize" disclosure listing individual capabilities as checkboxes, which forks a custom profile on save. The account Owner's row is disabled with an explanation. |
| **Notifications** | Timesheet reminders (a time-of-day select plus a seven-day toggle group rendered as pill buttons), delivery channels (Email, and Slack with a Connect link when not yet linked; browser push is deliberately out of v1 - email and Slack cover the need without service-worker push infrastructure), Weekly summary email, and Other notifications (project deleted, budget alerts, approval events). Stored in `users.notification_prefs`. |
| **Security** | Sign-in method (SSO or password), a Reset password action, active sessions list with device, IP, last seen and a Revoke button, personal access tokens (create, label, copy once, revoke), and connected integrations (Google Calendar). |

Every section autosaves per field group on blur with a "Saved" flash. The Permissions section is the exception and requires an explicit `Update permissions` button, because the blast radius is large.

### 8.4 Assignments

**Route:** `/team/assignments/:tab` with tabs Roles, Departments, Profiles, Assign Users.

- **Roles** - a table of role name and the people holding it (overlapping avatar stack, capped at 7 with `+N`), Edit and Delete per row, `+ New role` primary. Deleting a role in use asks what to do with its holders.
- **Departments** - same shape.
- **Profiles** - grouped into Base profiles (6, not deletable, each showing a capability count and its people) and Custom profiles (editable and deletable). `+ New profile` opens a full-page capability editor: a two-column checklist of every capability grouped by domain (Time, Expenses, Projects, Clients, People, Rates, Invoices, Reports, Settings), with a "starts from" base-profile selector at the top and a live diff summary ("4 capabilities added, 1 removed vs Project Manager").
- **Assign Users** - the bulk surface. A table of every person with columns Name, Role, Department, Profile, and a capability count. Filters for Role, Membership, Profile, and Permission. Select rows and apply Set role, Set department, Set profile in bulk. This is how a 55-contractor roster gets organised in one sitting.

---

## 9. Organize: Clients

> **Phase:** 1 (client detail financial tabs: 3)

**Route:** `/clients?q=…&status=active|archived`

### 9.1 List

A dense single-column list rather than a wide table, because a client row is mostly a name plus its contacts.

Each row: `Edit` button, client name in `--fw-medium`, then a right-aligned `+ Add contact` button. When a client has contacts, they render as indented sub-rows beneath: name, title, email, phone, each with a hover `Edit` and `Delete`. Rows are grouped alphabetically with sticky letter headers.

Toolbar: a filter field ("Filter by client or contact", matching both), a status segmented control (Active / Archived), `+ New client` primary, an `Actions ▾` overflow, and `Import / Export`.

At `xl` an optional second column shows per-client Active projects count, Open balance, and Last invoiced date, toggled from the Columns popover.

### 9.2 New and edit client

A single-column form, max-width 720px, with a right rail on the edit screen.

Fields: **Client name** (required, uniqueness checked on blur with an inline warning, not an error, since duplicates like `Example Client 44` and `Example Client 43` genuinely exist), **Address** (multi-line, used on invoices), **Preferred currency** (defaults to "Account default (United States Dollar - USD)"), then a hairline, then invoice defaults: **Invoice due date** (Net 15 / Net 30 / Net 45 / Net 60 / Due on receipt / Custom days), **Tax %** with an "Enable second tax" link that reveals a second field, **Discount %**.

Right rail on edit: an *Active projects* card listing the client's live projects as links, and, when archiving is blocked, a `--warning` card reading "You cannot archive *Example Client 05* because it has active projects." with links to each.

`Save client` / `Cancel`. On the edit screen an `Archive` action sits in the header overflow.

### 9.3 Client detail

**Route:** `/clients/:id`

Header: client name, currency chip, and Actions. A KPI strip: Open balance, Paid this year, Uninvoiced amount, Active projects. Then tabs:

- **Projects** - the Projects table scoped to this client.
- **Invoices** - the Invoices table scoped to this client.
- **Contacts** - contact CRUD.
- **Retainer** - the retainer ledger for this client, or an empty state offering to create one.

---

## 10. Organize: Projects

> **Phase:** 1 (list, editor) · 2 (detail page, budgets, charts)

### 10.1 Projects list

**Route:** `/projects?status=active|budgeted|archived&client=…&manager=…&tag=…&q=…`

The financial control panel. Grouped by client, one row per project.

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ Projects        [+ New project] [Actions ▾] [Import] [Export] [🔍 Search    ] │
├───────────────────────────────────────────────────────────────────────────────┤
│ [Active projects (00) ▾]                    [Client ▾] [Manager ▾] [Tags ▾]   │
├───────────────────────────────────────────────────────────────────────────────┤
│ ☐            Project              Budget    Spent      Progress  Remaining Cost│
│  Example Client 03                          │
│ ☐ Example Project 01  $00,000  $00,000  ▇▇▇▇▁▁▁▁  $00,000 (00%) │
│                        [Fixed Fee]                                    $0,000 ⋯ │
│  Example Client 04                                                               │
│ ☐ Example Project 02  00.00  0,000.00 ████████▌ -0,000 (-0000%)│
│                        [Fixed Fee]                                   $00,000 ⋯ │
└───────────────────────────────────────────────────────────────────────────────┘
```

- **Status dropdown** shows counts: `Active projects (40)`, `Budgeted projects (18)`, `Archived projects (463)`.
- **Type chip** after each project name: `Time & Materials`, `Fixed Fee`, or `Non-Billable`, using `--bg-muted` outline chips. A monthly-resetting budget adds a small recycle glyph next to the budget figure with a tooltip "Resets monthly".
- **Budget / Spent** render in the project's own unit: dollars for fee budgets, hours for hour budgets. The header cells relabel themselves when a filter narrows to one budget kind.
- **Progress bar** is the workhorse: an 84px track in `--bg-strong`, a fill that is `--info` under 80%, `--warning` from 80-100%, and, past 100%, a full `--warning` bar plus a `--danger` overflow segment sized to the overage and separated by a 2px surface gap. A project with no budget renders an empty track and an em dash in Remaining.
- **Remaining** shows the value and the percentage; negative values are `--danger`.
- **Costs** is internal cost to date, visible only with `rates:view_cost`.
- **Row overflow menu:** Edit, Pin, Duplicate, New invoice, Archive, Delete. Pinned projects float to a "Pinned" group above the client groups. Pins are per-user, not account-wide; your pins never rearrange a teammate's list.
- **Bulk selection** enables: Add tasks, Remove tasks, Add tags, Remove tags, Set tasks billable, Update projects (type / bill-by / rate), Archive, Reactivate.

### 10.2 Project detail

**Route:** `/projects/:id?tab=tasks|team|invoices|expenses&range=…`

The single most information-dense screen in the product, and the one Jason will live in.

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ ← Back to Projects                                     [🔍 Search projects]   │
│ Example Client 03                           │
│ Example Project 01  [Fixed Fee]     [✎ Edit project] [Actions ▾]│
├───────────────────────────────────────────────────────────────────────────────┤
│ ┌───────────────────────────────────────────────────────────────────────────┐ │
│ │ [Project progress │ Hours per week]                    [← This week →]    │ │
│ │  $00,000 ┤                                          ╭──●                  │ │
│ │  $00,000 ┤                             ╭────────────╯                     │ │
│ │  $00,000 ┤──●──●──●──●──●──●──●────────╯                                  │ │
│ │   $0,000 ┤                                                                │ │
│ │          └────────┬────────┬────────┬────────┬────────┬─────              │ │
│ │              Mar    Apr      May      Jun      Jul                        │ │
│ └───────────────────────────────────────────────────────────────────────────┘ │
│ ┌──────────┬──────────────┬─────────────┬──────────────┬────────────────────┐ │
│ │Total hrs │Budget remain │Internal cost│Invoiced      │Uninvoiced          │ │
│ │000.00    │$00,000.00    │$0,000.00    │$00,000.00    │$0,000.00           │ │
│ │Bill 000.0│  (00%) ▇▇▇▁▁ │Time $0,000  │              │Fees $00,000        │ │
│ │Non-b 0.00│Budget $00,000│Exp    $0.00 │              │→ New invoice       │ │
│ └──────────┴──────────────┴─────────────┴──────────────┴────────────────────┘ │
├───────────────────────────────────────────────────────────────────────────────┤
│ Tasks │ Team │ Invoices │ Expenses           [All time ▾] [Export ▾]          │
├───────────────────────────────────────────────────────────────────────────────┤
│ Billable tasks              Hours ▴    If billed hourly        Costs          │
│ ▸ Meetings/Collaboration    00.00      $0,000.00           $0,000.00          │
│ ▾ Design                    00.00      $0,000.00           $0,000.00          │
│     👤 Sample Person10         00.00      $0,000.00             $000.00          │
│     👤 Sample Person06          00.00      $0,000.00             $000.00          │
│ …                                                                             │
│   Total                    000.00     $00,000.00           $0,000.00          │
├───────────────────────────────────────────────────────────────────────────────┤
│ Non-billable tasks          Hours      If billed hourly        Costs          │
│   Business Development       0.00              $0.00              $0.00       │
└───────────────────────────────────────────────────────────────────────────────┘
```

**Chart card.** A segmented toggle picks the view; a period stepper on the right scrolls the window.
- *Project progress* is a cumulative line of billable value (or hours, for hour budgets) over time. When a budget exists, a horizontal threshold rule in `--danger` sits at the budget value, labelled with a small inline chip (`Budget: 26.67 hours`). When the line crosses it, the line turns `--danger` from the crossing point forward. The current week's band is tinted `--info-bg` and labelled "This week".
- *Hours per week* is a bar chart of weekly hours over the same window, same tinted current week.
- Both get a hover crosshair with a tooltip showing the date, the value, and the delta from the previous point.

**KPI card row.** Five equal cards at `--r-lg` with `--border`, each with a `--fs-base` `--text-secondary` label, a `--fs-2xl` `--fw-semibold` value, and supporting rows in `--fs-base`.
1. *Total hours* with Billable / Non-billable sub-rows.
2. *Budget remaining* with the percentage in the label, the total budget, and a progress bar. Over budget flips the value to `--danger` and the bar to the overflow treatment.
3. *Internal costs* with Time and Expenses sub-rows. Hidden entirely without `rates:view_cost`.
4. *Invoiced amount.*
5. *Uninvoiced amount* with Total project fees and a `New invoice →` link that jumps straight into invoice creation pre-scoped to this project. For Fixed Fee projects the figure is fees to date minus invoiced, floored at zero ([BACKEND_PRD.md §4.11](BACKEND_PRD.md#411-uninvoiced-amounts)).

An `ⓘ` glyph on Budget remaining opens a popover explaining exactly how it was computed for this project's budget type.

**Tabs.**
- *Tasks* - two tables, Billable and Non-billable, each with expandable task rows that reveal per-person breakdowns. Columns: task, Hours (sortable, the default sort, descending), If billed hourly, Costs. The Hours figures are links that open the detailed time report filtered to that project and task.
- *Team* - the same shape grouped by person, with a `Manager` chip on managers and an `Archived` chip on archived people, expandable into per-task rows.
- *Invoices* - `+ New invoice` and `Link invoice` buttons, then a table of Status, Issue date, Paid on, ID (link), Subject, Pre-tax amount, and an `Unlink` action, with a totals row.
- *Expenses* - the expense list scoped to the project.

**Actions menu:** Edit project, Duplicate, Pin, New invoice, Export time, Archive, Delete.

**Empty states:** a brand-new project shows the KPI row with zeros and a centred card in the tab area: "No time tracked on this project yet." plus `Start a timer` and `Assign people` buttons.

### 10.3 Project editor

**Route:** `/projects/new` and `/projects/:id/edit`

A single long form, max-width 1100px, with section cards. This form encodes most of the product's business rules, so its layout matters.

**Section 1 - Identity**
Client (disabled on edit when invoices are linked, with a hint explaining that unlinking invoices is the way to change it), Project name, Project code, Dates (Starts on / Ends on, both optional, with a hint that time can still be tracked outside the range), Tags (creatable token input, with account-wide delete via the `×` on a tag), Billing currency (defaults to "Same as client"), Notes (visible to Administrators and project managers only, per the Settings toggle).

**Section 2 - Permissions**
Two radio options: "Show project report to Administrators and people who manage this project" or "Show project report to everyone on this project", each with a "What will people see?" link opening a popover that itemises the fields each audience gets.

**Section 3 - Project type**
Three large selectable cards, side by side, each with a title and a one-line description: **Time & Materials** (bill by the hour, with billable rates), **Fixed Fee** (bill a set price regardless of time tracked), **Non-Billable** (not billed to a client). The selected card gets a `--live-bg` fill, a `--live` border, and a caret pointing into the panel beneath it. The panel below changes with the selection:

- *Time & Materials:* **Billable rates** with a select (Project hourly rate / Person hourly rate / Task hourly rate / No billable rate) and a rate field when "Project" is chosen. Then **Budget**: a type select (Total project hours / Total project fees / Hours per task / Fees per task / Hours per person / No budget) and a value field labelled with the matching unit. Then two checkboxes: `Budget resets every month` and `Send email alerts if project exceeds [80.00] % of budget`.
- *Fixed Fee:* **Project fees** with a Single fee / Monthly segmented control and an amount field, then the same Budget block.
- *Non-Billable:* just the Budget block, restricted to hour-based budgets.

**Section 4 - Tasks**
A card listing every task on the project: an `×` remove button, the task name, and a `Billable` checkbox on the right with `Select All / None` in the card header. An "Add a task…" combobox at the bottom searches the global task library and offers "Create *name*" for new ones. Removing a task that has tracked time warns that the time is preserved but will no longer be selectable.

**Section 5 - Team**
A card listing assigned people: `×`, avatar, name, **Cost rate** (read-only, from the person's dated rates, showing `Missing rate` in `--warning` when absent, linking to their Rates page), an `Apply custom rate` link that expands into a billable-rate override field for this project, and a `Manages this project` checkbox with `Select All / None`. An "Assign a person…" combobox at the bottom.

**Section 6 - Invoice values**
Invoice due date (select plus a custom days field), PO Number, Tax % with "Enable second tax", Discount %. All default from the client and show "(from client)" in `--text-tertiary` until overridden.

Footer: `Update project` primary, `Cancel` secondary, both in a sticky bar at the bottom of the viewport once the form is taller than the screen.

---

## 11. Organize: Tasks

> **Phase:** 1

**Route:** `/tasks?q=…&status=active|archived`

The global task library. Every project's task list is drawn from here.

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ Tasks               [+ New task] [Export] [Actions ▾] [View archived tasks →] │
├───────────────────────────────────────────────────────────────────────────────┤
│                    [🔍 Filter by task name                    ]               │
│ ┌───────────────────────────────────────────────────────────────────────────┐ │
│ │ ☐ Common tasks                                        Default billable rate│ │
│ │   These are automatically added to all new projects.                       │ │
│ ├───────────────────────────────────────────────────────────────────────────┤ │
│ │ ☐ Account Management  [Billable]                      $0.00     [Actions ▾]│ │
│ │ ☐ Consulting          [Billable]                      $0.00     [Actions ▾]│ │
│ │ ☐ Design              [Billable]                      $0.00     [Actions ▾]│ │
│ └───────────────────────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────────────────┘
```

Rows expand in place into an editor card (`--live-bg`, `--live-border`) with: Task name, Default billable rate (`$ ___ per hour`, with a hint that setting it improves report accuracy), `This task is billable by default`, `This is a common task, and should be added to all future projects`, then `Update task` / `Cancel`.

Bulk selection enables: Set billable, Set rate, Make common, Archive. `Actions ▾` per row: Edit, Add to projects…, Archive, Delete (disabled when the task has tracked time, with an explanatory tooltip).

---

## 12. Bill: Invoices

> **Phase:** 3

### 12.1 Overview

**Route:** `/invoices?tab=open|all&client=…&range=…&status=…`

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ Invoices                        [+ New invoice] [🔍 Search] [Actions ▾]       │
├───────────────────────────────────────────────────────────────────────────────┤
│ Overview │ Recurring │ Retainers │ Configure                                  │
├───────────────────────────────────────────────────────────────────────────────┤
│ ┌───────────────┐ ┌───────────────────────────────────────────────────────┐   │
│ │ Total open    │ │ [←] Invoices issued in 0000 [→]      ■ Open  ■ Paid   │   │
│ │ $000,000.00   │ │ $000k ┤                                               │   │
│ ├───────────────┤ │  $00k ┤                        ▇                      │   │
│ │ Total paid    │ │  $00k ┤            ▇     ▇     █     ▇                │   │
│ │ $00,000.00    │ │       └──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──         │   │
│ │ Issued 0000.  │ │        Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec│   │
│ └───────────────┘ └───────────────────────────────────────────────────────┘   │
├───────────────────────────────────────────────────────────────────────────────┤
│ Open 000 │ All invoices              [All clients ▾] [All time ▾] [Columns ▾] │
├───────────────────────────────────────────────────────────────────────────────┤
│ Status  Due in         Issue date ▴  ID              Client            Balance │
│ [Sent]  Due in 00 days 00/00/0000   00000-Example Client 39-QBA0  Example Client 39           $0,000.00 │
│ [Draft] Not sent yet   00/00/0000   00000-Example Client 10-M00   Example Client 11    $0,000.00 │
│ [Late]  Due 00 days ago 00/00/0000  00000-Example Client 39-QBA0  Example Client 39          $00,000.00 │
│ …                                                                              │
│                                          Total for all pages       $000,000.00 │
└───────────────────────────────────────────────────────────────────────────────┘
```

**KPI tiles.** Total open and Total paid, stacked in a 320px column beside the chart. Each is a hero number with a `--text-tertiary` caption.

**Chart.** Stacked bars per month, Paid on the bottom in `--success`, Open above it in a 45% tint, 2px surface gap between segments. Year stepper on the left. Hovering a month shows a tooltip with both values and the invoice count, and clicking it filters the table below to that month.

**Table.**
- *Status* pills: `Draft` (`--bg-muted` / `--text-secondary`), `Sent` (`--info-bg` / `--info`), `Late` (`--danger-bg` / `--danger`), `Paid` (`--success-bg` / `--success`), `Written off` (`--bg-muted` outline, struck-through amount), `Partially paid` (`--warning-bg` / `--warning`). Every pill carries a word, never colour alone.
- *Due in* is human ("Due in 3 days", "Due today", "Due 28 days ago" in `--danger`, "Not sent yet" in `--text-tertiary`).
- *Client* cell shows the client name in `--fw-medium` with the invoice subject beneath in `--text-secondary`.
- Optional columns behind the Columns popover: Project, PO number, Issue date, Due date, Sent date, Paid date, Amount, Tax, Balance, Created by.
- Bulk selection enables: Mark as sent, Record payment, Send reminder, Download as PDF (a ZIP, emailed), Write off, Delete.
- Pagination at 50 per page, with the totals row explicitly labelled "Total for all pages".

### 12.2 Invoice editor

**Route:** `/invoices/new?client=…&project=…` and `/invoices/:id/edit`

Two-column: the document on the left (600px+), the settings rail on the right (320px).

**Right rail:** Client (picker, required first), Project (optional, for linking), Invoice ID (auto-generated from the numbering rule, editable, uniqueness validated on blur), PO number, Issue date, Payment term (which drives Due date, itself overridable), Currency, Tax % and second tax, Discount %, Subject, Notes, and a `Show total hours on invoice` toggle.

**Left document:** a live preview of the branded invoice with an editable line-item table. Columns: Item type (select), Description (auto-growing textarea), Quantity, Unit price, Amount (computed, editable to back-solve unit price), plus tax checkboxes when taxes are enabled, and a drag handle plus delete per row. `+ Add line item` at the bottom, plus a totals block (Subtotal, Discount, Tax, Tax 2, **Total**).

**The important part - `Add from tracked time`.** A prominent secondary button above the line items opens a drawer:
- A period picker and project filter.
- A grouping select: `One line per project`, `One line per task`, `One line per person`, `One line per person and task`, `One line per day`, `One line per entry`, `A single summary line`.
- A checkbox tree of uninvoiced time grouped by project then task then person, each row showing hours, rate, and amount, with a running "N entries selected, 42.5 hours, $1,000.00" footer.
- A parallel `Expenses` section listing uninvoiced billable expenses with their receipts.
- `Add to invoice` inserts the generated line items and attaches the entries to the draft. They become locked when the invoice is sent, not when the draft is saved, so a draft can be reworked freely. If an attached entry changes while the invoice is still a draft, Send is blocked with "N entries changed since these lines were generated" and a one-click `Regenerate lines` fix ([BACKEND_PRD.md §4.8](BACKEND_PRD.md#48-invoice-state-machine)) - the number on the invoice can never silently disagree with the time behind it.

For Fixed Fee projects an `Add project fee` button inserts a line item for the outstanding fee amount with a description drawn from the project notes.

Footer: `Save draft`, `Save and send…`, `Cancel`.

### 12.3 Invoice detail

**Route:** `/invoices/:id`

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ ← Back to Invoices                                                            │
│ Invoice 00000-LC0  [Paid] [Synced to QuickBooks]        [Preview][PDF][Print] │
│ Latest activity: Invoice updated. Sample Person02 on 00/00/0000 · View history   │
│ 🔗 Linked to project Example Project 01                         │
│                                                                               │
│ [Send thank-you] [Copy invoice link] [Edit invoice] [Actions ▾]               │
│                                            $00,000.00 paid on 00/00/0000      │
├───────────────────────────────────────────────────────────────────────────────┤
│ ┌───────────────────────────────────────────────────────────────────────────┐ │
│ │  [JHMG LOGO]              ╱PAID╱                From  JH Media Group Inc. │ │
│ │                                                       000 N. Highland Ave │ │
│ │  Invoice For   Ann & Robert H Example Client 28          Invoice ID   00000-LC0       │ │
│ │                Children's Hospital           Issue Date   00/00/0000      │ │
│ │                [Edit info]                   Due Date     00/00/0000      │ │
│ │  ┌──────────┬────────────────────┬──────┬──────────┬──────────┐           │ │
│ │  │Item Type │Description         │Qty   │Unit Price│Amount    │           │ │
│ │  │Service   │Design Completion   │0.00  │$0,000.00 │$0,000.00 │           │ │
│ │  │Service   │Development Complet.│0.00  │$00,000.00│$00,000.00│           │ │
│ │  └──────────┴────────────────────┴──────┴──────────┴──────────┘           │ │
│ │                                             Subtotal    $00,000.00        │ │
│ │                                             Payments   -$00,000.00        │ │
│ │                                             Amount Due       $0.00        │ │
│ │  ┌─────────────────────────────────────────────────────────────────────┐  │ │
│ │  │ [Attach file]  [Attach expense report]                              │  │ │
│ │  └─────────────────────────────────────────────────────────────────────┘  │ │
│ └───────────────────────────────────────────────────────────────────────────┘ │
├───────────────────────────────────────────────────────────────────────────────┤
│ Invoice history                                                               │
│ 👤 Invoice updated.        Sample Person02 on 00/00/0000 at 0:00am               │
│ 👤 Payment received on 00/00/0000.  Sample Person02 …          $00,000.00   [×]  │
│ 👤 Invoice marked as sent. Sample Person03 on 00/00/0000 at 00:00am             │
└───────────────────────────────────────────────────────────────────────────────┘
```

- The invoice document is the *same React component* that renders the PDF and the client-facing pay page. One template, three consumers, zero drift.
- A `PAID` stamp overlays the document at 12 degrees rotation in `--success` when fully paid; `WRITTEN OFF` in `--text-tertiary` when written off. Both are `aria-hidden` because the status badge in the header carries the meaning.
- `Actions ▾`: Record payment, Send invoice, Send reminder, Mark as sent, Mark as closed, Write off, Duplicate, Unlink project, Delete.
- **Record payment** opens a modal with Amount (pre-filled to the outstanding balance), Paid on, Payment method, Reference, Notes, and a "Send a thank-you email" checkbox. Partial payments are supported and roll the status to `Partially paid` with the remaining balance shown.
- **Send invoice** opens a compose modal: recipients (client contacts, multi-select, with a free-text add), CC and BCC, a "send a copy to me" checkbox, subject and body pre-filled from the template with variables already resolved, an attach-PDF toggle, and a preview pane. Sending writes a history row and flips the status to `Sent`.
- **Invoice history** is a reverse-chronological timeline. Payment rows carry the amount in `--success` and an `×` to void the payment (with confirmation). Email rows expand to show the exact message sent and its recipients.
- **Attachments** dropzone accepts files up to 20MB; attached files are included in the send.

### 12.4 Client pay page

**Route:** `/pay/:token` (public, unauthenticated, no app shell)

A single-column page: the JHMG logo, the invoice document, the amount due as a hero number, and a `Pay this invoice` button that opens Stripe Checkout (card and ACH). Below: `Download PDF` and a `Questions? reply to this email` line. Fully themed, respects `prefers-color-scheme`, mobile-first. Access is by unguessable token; the token is single-purpose and rotates when the invoice is edited after sending.

---

## 13. Bill: Recurring invoices

> **Phase:** 3

**Route:** `/invoices/recurring` and `/invoices/recurring/:id`

**List:** Client, Invoice subject, Next invoice (date plus cadence in `--text-secondary`, e.g. `09/01/2026 (every month)`), Amount, and a `Paused` chip where relevant. Rows where the schedule has completed show `None (schedule completed)`. Sorted by next issue date. Filter by client. `+ New recurring invoice` primary.

**Detail:** header with the client, the subject as the title, a status chip, and `Edit recurring template`, `Pause`/`Resume`, `Delete` actions. Below, a table of every invoice this schedule has generated (Status, Issue date, ID, Subject, Amount) and a footnote: "This list shows only invoices generated from your recurring settings." with a link to a full client invoice report.

**Template editor:** the invoice editor with an added **Schedule** card at the top: Frequency (weekly / every N weeks / monthly / every N months / quarterly / annually / every N years), Issue on (day of month, or day of week), Start date, End condition (never / after N invoices / on a date), Time of day, and a `Send automatically when generated` toggle with recipient selection. A live "Next three invoices will be issued on…" preview sits beneath, which catches month-end and leap-day mistakes before they ship.

---

## 14. Bill: Retainers

> **Phase:** 3

**Route:** `/invoices/retainers` and `/invoices/retainers/:id`

**Empty state:** a line-art mark, "Retainers help you track funds when clients pay in advance. You can also add and draw from the retainer over time.", and `+ New retainer`.

**Create:** an inline `--live-bg` card at the top of the page with Client (or `Create new client`) and Project (`Apply to all projects` or a specific project), then `Create retainer` / `Cancel`.

**Detail:** a KPI strip of Retainer balance (hero), Total added, Total drawn, Uninvoiced amount, Uninvoiced fixed fees, Uninvoiced expenses. Then `+ Add funds` (primary) and `Delete` (`--danger`). Below, the transaction ledger: Date, Type (`Added` / `Drawn`), Description, Invoice link, Amount (added in `--success`, drawn in `--text`), Running balance. Empty reads "This retainer has no activity yet."

`Add funds` opens a modal offering two paths: record funds received directly, or create an invoice for the retainer amount that will add to the balance when paid.

When a retainer exists for a client, the invoice editor shows a `--info` card: "This client has $4,200.00 on retainer. Draw from retainer?" with a checkbox and an amount field defaulting to the lesser of the balance and the invoice total. The draw is recorded when the invoice is **sent**, never on a draft, and is automatically reversed if the invoice is later written off or deleted; the ledger shows both movements ([BACKEND_PRD.md §4.12](BACKEND_PRD.md#412-retainer-draws)).

---

## 15. Bill: Invoice configuration

> **Phase:** 3

**Route:** `/invoices/configure/:section`

Two-pane, 280px left nav, form on the right.

| Section | Contents |
|---|---|
| **Company information** | Name, Address (multi-line, appears on all invoices), tax ID, and a hint that the logo is set under Appearance. |
| **Default values** | Time rounding (No rounding / nearest 1, 5, 6, 10, 15, 30, 60 minutes, with up/down/nearest), with the hint "Controls rounding in summary time reports and invoices. Time is never rounded in detailed time reports or timesheets." `Show total hours on invoices`. Payments due (default payment term). Default invoice subject. Default invoice notes. Online payments (Stripe connect state, with a Connect or Disconnect button and the current account shown). |
| **Appearance** | Logo (current image, Change and Remove, with size guidance: at least 1500px wide, JPG/PNG/GIF, 5MB max). Look and feel: a `Use default branding` / `Customize` radio pair. Customize reveals Brand colour and Background colour with swatch pickers, a live invoice thumbnail preview that updates as you type, a Banner upload for the invoice footer, and two links: `Send a test email` and `See how clients will view invoices`. Below: Document title (a checkbox plus a text field defaulting to "INVOICE"), `Snail-mail friendly` (show the client address on the left for a window envelope), and Show invoice columns (Item type, Description, Quantity, Unit price, Amount) as checkboxes. |
| **Messages** | Send-as addresses (add a custom From address with verification). Then a variable reference disclosure listing every token (`%invoice_id%`, `%invoice_issue_date%`, `%invoice_client%`, `%invoice_po_number%`, `%invoice_amount%`, `%invoice_due_date%`, `%company_name%`, `%client_contact_first_name%`, `%payment_link%`). Then three tabs, Invoice message / Reminder message / Thank you message, each with Subject and Body fields and a live preview using the most recent real invoice as sample data. Finally, `Show payment request option on invoices sent to clients`. |
| **Field labels** | Rename every label the invoice document, PDF, and payment emails use, for clients who expect different terminology (renaming "Invoice" to "Statement", or "Amount due" to "Balance due"). The full set: Document title, From, For, Invoice ID, PO number, Issue date, Due date, Upon receipt, Net [days] (with `[days]` as the count token), Tax, Tax 2, Discount, Subject, Item type, Description, Quantity, Unit price, Amount, Subtotal, Amount due, Total hours, Notes, PDF page numbering (with `[page]` and `[toPage]` tokens), File attachments, Payments, Retainer payments, Invoice link (the label on the pay-page link in emails), Paid (the stamp text), and Client message (shown after an online payment). Each is a plain text field with its default pre-filled and a Reset to default action. |
| **Item types** | The list of item types (Product, Service, and custom ones like Direct Costs), each with an inline editor for the name and the mapped QuickBooks income account. Types already synced show the account as read-only with an explanation. Defaults are flagged: `(Default for expenses)`, `(Default for billable hours or fees)`. |
| **Numbering** | The invoice ID pattern builder: a token field supporting `{seq}`, `{seq:4}`, `{year}`, `{yy}`, `{month}`, `{client_code}`, `{project_code}`, with a live example, a starting sequence number, and a per-client prefix override table. |

---

## 16. Review: Reports

> **Phase:** 1 (Time report, read-only) · 2 (Profitability, Team, Contractor) · 3 (Invoicing) · 4 (builder, saved reports)

**Route:** `/reports/:kind` with tabs Time, Profitability, Team, Invoicing, Saved.

Every report shares: the period picker, a filter row, a summary band, a tabbed breakdown table, and Export plus Print. Every figure in every breakdown table is a link that drills down one level, with breadcrumbs above the period picker recording the path (`Profitability overview › Example Client 14 › Example Project 10`).

### 16.1 Time report

**Summary band:** Total hours (hero) beside a donut whose centre carries the billable percentage as a hero number, with Billable and Non-billable legend rows and their hour values. Then Billable amount (hero) with an `Include Fixed Fee projects` checkbox and an explanatory note that fixed-fee billable amounts are computed from billable rates and may not match invoiced amounts. Then Uninvoiced amount (hero) with `Excludes Fixed Fee projects` as its caption.

**Breakdown tabs:** Clients / Projects / Tasks / Teammates. Columns: Name (link), Hours (link, right-aligned), a proportional magnitude bar in the sequential blue ramp, Billable hours with its percentage, Billable amount. `Active projects only` checkbox, `Detailed report` button (switches to the row-level entry view), Export and Print.

**Detailed report** is a flat table of every entry: Date, Person, Client, Project, Task, Notes, Hours, Billable, Billable rate, Billable amount, Cost rate, Cost amount, Invoiced, Approved. Column visibility and ordering are user-configurable and saved. This table is what gets exported for anything the built-in reports do not answer.

### 16.2 Profitability report

The reason this product exists.

**Filter row:** Project status, Project type, Project manager, Tags, Client, plus the period picker and granularity.

**Data-quality banner.** When any project in range is missing a cost rate or a billable rate, a `--warning` banner reads "Some of the data in this timeframe cannot be accurately calculated because there are missing dates and rates." with an `Add missing dates and rates` link opening a focused fix-it drawer listing exactly which people and projects are missing which rates, each with an inline field to set it. Harvest surfaces the problem; we surface the fix.

**Chart.** "Company profit over this quarter" with a `Tracked time` / `Invoiced` toggle chip. Grouped bars per period, Revenue in the categorical green, Costs in the categorical red, plus a Profit line overlay with markers. All three share one currency axis; there is never a second y-axis. Zero line in `--border-strong`. Current period band tinted. Hover crosshair with a tooltip showing all three values and the margin.

**KPI cards.** Three cards: **Revenue** with the period-over-period delta as a coloured percentage, and expandable Invoiced / Uninvoiced sub-rows; **Cost** with Time / Expenses sub-rows; **Profit** with the margin percentage in the label and the value in `--success` or `--danger`. Each has an `ⓘ` explaining the formula for this filter set.

**Breakdown tabs:** Clients / Projects / Team / Tasks. Columns: Name (link), Revenue, Cost, Profit, a margin bar with the percentage beside it, and Return on cost. Rows with data-quality problems carry a `--warning` triangle at the row start with a tooltip naming the missing input; those rows get a `--warning-bg` tint. Archived entities carry an `Archived` chip. Sort defaults to Profit descending.

**Fixed-fee allocation.** On the Team and Tasks tabs, an `Assign fixed fee revenue` select offers `evenly across teammates` / `by hours tracked` / `by billable value` (and the task equivalents). The selection is part of the URL state so a shared link reproduces the exact numbers.

### 16.3 Team and Contractor reports

- **Team** - per person: Total hours, Billable hours, Utilization, Capacity, Cost, Revenue, Profit, with the same grouping and drill-down. Group by Role or Department.
- **Contractor** - contractors only: Name with profile chip, Total hours (link), Utilization, Cost. The cost figure is what gets reconciled against contractor invoices.

### 16.4 Invoicing report

Tabs: **Uninvoiced** (by client and project: uninvoiced hours, uninvoiced amount, uninvoiced expenses, uninvoiced fixed fees, with a `Create invoice` action per row), **Receivables** (aging buckets: current, 1-30, 31-60, 61-90, 90+, per client, with a stacked bar per row and a `Send reminders` bulk action), **Payments** (every payment recorded in the period), and **Sales tax** (tax collected by rate).

### 16.5 Report builder and saved reports

`+ New report ▾` offers `Custom report`, `Detailed time`, `Detailed expense`.

**Filter forms** (Detailed time / Detailed expense) are a card with Timeframe, `Include archived items in filters`, Clients, Projects, Tasks (or Categories), Approval status, a free-text Search across notes, Teammates with a `Search roles` link, then `Run report`.

**Custom report builder** is a four-step panel: (1) Measure - hours, billable amount, cost, revenue, profit, expenses, entries count; (2) Group by - up to two dimensions from client, project, task, person, role, department, week, month, quarter, tag, billable; (3) Filter - the same filter set; (4) Visualize - table, bar, line, or stacked bar. A live preview renders beside the panel as options change. `Save report` names it, chooses Private or Shared, and adds it to the Saved tab.

**Saved reports** lists name, kind, owner, last run, and a Shared chip, with Run, Edit, Duplicate, Share, and Delete. Saved reports can be scheduled: a `Schedule ▾` action sets a cadence and recipients, delivering a CSV and a link by email.

---

## 17. Settings

> **Phase:** 1 (Company, Preferences) · 2 (Modules, Sign-in security) · 3-4 (Integrations, as each ships) · 4 (Import/Export, Bulk actions, Activity log)

**Route:** `/settings/:section`. Two-pane, 280px nav.

### 17.1 Company
Company name, address, logo, base currency, fiscal year start, and the default week start day.

### 17.2 Preferences
- **Timer mode:** `Duration only` or `Start and end times`. A hint explains that start/end mode records clock times and that Week view will infer times for cells entered as durations.
- **Time display:** Decimal (`7.25`) or Hours and minutes (`7:15`).
- **Week starts on:** Monday or Sunday.
- **Date format** and **Number format**.
- **Flag missing time:** off, or "flag weekdays under N hours".
- **Require notes:** never, on all entries, or on non-billable entries only.
- **Allow tracking future dates:** on/off.
- **Lock timesheets after:** never, or N days past the period end (with an Administrator override).
- **Who can see project notes:** Administrators and managers, or everyone on the project.

### 17.3 Modules
A list of toggleable features with a check or a `Disabled` link: Time tracking, Expense tracking, Timesheet approval, Team, Invoices, Activity log. (Estimates and a client dashboard are out of scope for v1 and do not appear here - see [PRD-OVERVIEW.md §4.2](PRD-OVERVIEW.md#42-explicitly-out-of-scope).) Disabling a module hides its nav entries and blocks its routes server-side; it never deletes data. Turning one off asks for confirmation naming what will be hidden.

### 17.4 Sign-in security
- Require two-factor authentication for all members (with an enrolment grace period).
- Require sign in with Google (hosted domain pinned to `jhmediagroup.com`), with an allowlist for external contractors who use password auth.
- Session length.
- SAML configuration (deferred; the section shows "Not configured" with a Configure button that is disabled in v1).

### 17.5 Import / Export
- **Sample data** - add or remove a demo dataset for training.
- **Import data** - Import time, Import expenses, Import projects, Import people, Import clients. Each opens a wizard: upload CSV, map columns (with auto-detection and a saved mapping per file shape), preview the first 20 rows with per-row validation errors, then Import. Every import writes a revert token; `Revert an import` lists past imports with their row counts and a Revert action.
- **Export data** - Export all time, Export all invoices, Export all expenses, plus a full account JSON export. Large exports queue and arrive by email.

### 17.6 Bulk actions

A searchable grid of action cards, filtered by a domain segmented control (All / People / Projects / Clients / Invoices / Time entries / Tasks / Expenses). Each card shows the domain in `--fs-xs` uppercase, the action name in `--fw-medium`, and a plain-language description of exactly what it does and what it preserves.

Selecting a card opens a three-step flow: (1) choose targets with a filterable, selectable table; (2) set the change with the action's own small form; (3) review, which names the count, itemises anything that will be skipped and why, and requires an explicit confirm. `View history` in the page header lists past runs with actor, timestamp, target count, and outcome, each expandable to per-row results.

Actions in v1: Set rates, Assign to projects, Remove from projects, Update people, Archive people, Reactivate people, Add tasks, Remove tasks, Add tags, Remove tags, Set tasks billable, Archive projects, Reactivate projects, Update projects, Archive clients, Reactivate clients, Archive tasks, Update invoices, Mark as sent, Record payment, Write off, Delete invoices, Download as PDF, Delete time entries, Delete expenses, Delete contacts.

### 17.7 Integrations

A card grid grouped by category (Accounting, Calendar, Communication, Automation). Each card shows the logo, name, one-line description, and a Connect / Disconnect button, with connected cards tinted `--success-bg`. In v1: Google Workspace (SSO), Google Calendar, QuickBooks Online, Slack, Stripe, plus `Personal access tokens` and `Webhooks (coming soon)`.

Clicking a connected card opens its settings: for QuickBooks, the account mapping table and sync status with a `Sync now` button and a log of recent syncs; for Slack, the channel to post budget alerts to and whether to enable DM reminders; for Google Calendar, which calendars to pull.

### 17.8 Activity log

A filterable table of every mutation: timestamp, actor (with avatar), action, entity type and name (linked), and a diff disclosure showing before and after for changed fields. Filters: actor, entity type, action, date range. Retention 24 months. Export to CSV.

---

## 18. Component inventory

The build order is roughly this list. Each is a single file with a colocated story and test.

**Primitives:** Button (primary/secondary/ghost/danger/live, sm/md/lg, icon-only), IconButton, Input, InputAffix, Textarea, Select, Combobox, MultiCombobox, TokenInput, Checkbox, Radio, Switch, ChoiceCardGroup, ToggleGroup, DatePicker, DateRangePicker, DurationInput, MoneyInput, PercentInput, ColorInput, Dropzone, Slider, Tooltip, Popover, Dropdown, Dialog, Drawer, Tabs, SegmentedControl, Badge, Chip, StatusPill, Avatar (photo / initials / glyph fallback chain), AvatarUpload, AvatarStack, Skeleton, Spinner, ProgressBar, Toast, Banner, EmptyState, ErrorState, Kbd.

**Composites:** AppShell, TopBar, TimerWidget, Sidebar, CommandPalette, PageHeader, Toolbar, PeriodPicker, FilterBar, DataGrid (the AG Grid wrapper: card frame, ActionRow with its browse/select/act layers, ColumnPicker, density toggle, pinned totals, empty and loading states) + its cell renderers (GroupRow, DetailRow, TwoLineCell, PersonCell, MeterCell, StatusCell, ActionsCell), KpiCard, KpiRow, Chart (+ BarChart, LineChart, DonutChart, Sparkline, ProportionalBar, Legend, ChartTooltip, ChartTableView), ProjectTaskPicker, TimeEntryRow, TimeEntryEditor, WeekGrid, CalendarGrid, ExpenseRow, InvoiceDocument, LineItemTable, ApprovalRow, RateTable, PermissionMatrix, ImportWizard, BulkActionCard.

**Hooks:** `useTimer`, `useLiveStream`, `useShortcut` / `useShortcutMap`, `useOptimisticMutation`, `useUrlState`, `useTheme`, `usePermissions`, `useOfflineQueue`, `useDurationFormat`, `useMoneyFormat`.

---

## 19. Performance budgets

| Metric | Budget |
|---|---|
| First contentful paint, Timesheet, cold, cable | < 1.2s |
| Largest contentful paint, Timesheet | < 1.8s |
| Time to interactive, Timesheet | < 2.2s |
| Initial JS transferred (gzipped) | < 180 KB. **AG Grid is excluded and must never enter this bundle**, which is why Timesheet Day view uses a plain list. |
| Any route's incremental JS | < 60 KB, excluding the grid chunk |
| AG Grid chunk (gzipped, lazy, cached across grid routes) | < 320 KB. Trim to granular Community modules if the bundle report shows it matters. |
| First grid route: load to first row painted | < 1.2s cold, < 400 ms once the chunk is cached |
| Interaction to next paint (INP) p95 | < 200 ms |
| Command palette open to first result painted | < 100 ms (client-cached) |
| Timer start round trip | < 300 ms p95, optimistic paint immediate |
| Profitability report, one quarter, all projects | < 1s p95 |
| Projects list, 463 archived rows | < 500 ms to first paint, virtualized |
| Cumulative layout shift | < 0.05 |

Enforced by a Lighthouse CI run and a bundle-size check in the pipeline; a regression fails the build.

---

## 20. Acceptance criteria

Front-end sign-off requires all of the following to be demonstrably true.

**Foundations**
1. Light and dark themes are complete; no colour has its only definition inside a media query or a `[data-theme]` block; there is no flash of the wrong theme on first paint under either OS setting.
2. Every interactive element is reachable and operable by keyboard, with a visible focus ring.
3. Axe reports zero violations on Timesheet, Projects list, Project detail, Invoices, and every report.
4. `prefers-reduced-motion` removes all non-essential motion including the timer pulse.
5. Every chart passes the vendored palette validator (`node scripts/validate-palette.mjs`, wired into CI against both surfaces), carries a legend where there are two or more series, and offers a table view.

**Track**
6. A user can go from a cold page load to a running timer in four keystrokes or fewer.
7. Starting a timer in one tab stops it in another within one second, without a refresh.
8. Week view is fully editable in both timer modes, and inferred start times are visibly marked.
9. Closing the laptop for an hour and reopening it shows the correct elapsed time, taken from the server, not from a drifted client counter.
10. Going offline, logging three entries, and reconnecting results in exactly three entries with no duplicates.
11. A calendar event can become a time entry in two clicks.

**Organize and Bill**
12. Every grid virtualizes and scrolls at 60fps with 500 rows loaded, and AG Grid appears in no route's initial bundle.
12a. **No-shift, verified mechanically.** For every table in the product, a Playwright test screenshots the grid, ticks a checkbox, ticks a second, opens a row Actions menu, chooses a bulk action, and screenshots again after each step. The bounding box of the grid's first data row is identical in every screenshot. Any vertical movement outside the action row's own contents fails the build.
13. Every destructive action either offers Undo or requires typed confirmation. Nothing is both silent and irreversible.
14. The invoice on screen, the PDF, and the client pay page are pixel-identical for the same invoice.
15. Every filter and period selection is reflected in the URL and survives a refresh and a share.

**Review**
16. Every figure in every report drills down to the underlying entries in at most three clicks, with breadcrumbs recording the path.
17. Missing-rate warnings link directly to an inline fix, not just to a help article.
18. A saved report reproduces identical numbers when reopened a week later, for a closed period.
