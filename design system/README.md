# Tally Design System

The visual and interaction system for Tally. Built to be **ported, not translated**: five of the six files here ship into the app verbatim.

> **Open [`preview/index.html`](preview/index.html) in a browser.** No build step, no install. It imports the real `tokens.css`, so every value on the page is the value the app renders.

---

## What is here

```
design system/
├── README.md                 this file
├── tokens/
│   ├── tokens.css            SHIPS  every colour, size, radius, shadow, duration
│   ├── theme.css             SHIPS  Tailwind v4 bridge: tokens become utilities
│   ├── base.css              SHIPS  reset, focus, scrollbars, print, reduced motion
│   ├── tokens.ts             SHIPS  typed tokens for JS: charts, layout maths, theme
│   ├── ag-grid-theme.ts      SHIPS  AG Grid params mapped onto our tokens
│   └── ag-grid-overrides.css SHIPS  the few grid rules a theme param cannot express
├── recipes/
│   ├── recipes.ts     SHIPS   cva variant definitions per component
│   ├── grid.ts        SHIPS   grid options, column types, row model, DataGrid contract
│   └── cn.ts          SHIPS   clsx + tailwind-merge helper
└── preview/
    ├── index.html             the living style guide
    └── preview.css            presentation only, does NOT ship
```

## Porting checklist

```
tokens/tokens.css             ->  src/styles/tokens.css
tokens/theme.css              ->  src/styles/theme.css      imported once, in app/layout.tsx
tokens/base.css               ->  src/styles/base.css
tokens/tokens.ts              ->  src/styles/tokens.ts
tokens/ag-grid-theme.ts       ->  src/styles/ag-grid-theme.ts
tokens/ag-grid-overrides.css  ->  src/styles/ag-grid-overrides.css
recipes/recipes.ts            ->  src/components/ui/recipes.ts
recipes/grid.ts               ->  src/components/ui/grid.ts
recipes/cn.ts                 ->  src/lib/cn.ts
```

```bash
pnpm add class-variance-authority clsx tailwind-merge
pnpm add ag-grid-community ag-grid-react
```

`theme.css` imports Tailwind and `tokens.css` itself, so the app's root layout needs two imports:

```tsx
import "@/styles/theme.css";   // pulls in tailwindcss + tokens.css
import "@/styles/base.css";
```

And the theme script goes in `<head>`, render-blocking, before any stylesheet:

```tsx
import { THEME_INIT_SCRIPT } from "@/styles/tokens";
// ...
<head>
  <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
</head>
```

That is the whole integration. There is no config file to write: Tailwind v4 is CSS-first, and `theme.css` *is* the config.

---

## The four ideas

### 1. One definition per token, via `light-dark()`

```css
--surface: light-dark(#FFFFFF, #111113);
```

Three theme states fall out of one declaration:

| Root | Behaviour |
|---|---|
| `<html>` | follows the OS |
| `<html data-theme="light">` | forced light |
| `<html data-theme="dark">` | forced dark |

`light-dark()` resolves against the inherited `color-scheme`, which the three selectors at the top of `tokens.css` set. Setting the attribute is the entire implementation.

**Why it matters.** The conventional pattern needs the same token declared in three places: `:root`, a `prefers-color-scheme` media query, and a `[data-theme="dark"]` block. Every colour change is then three edits, and forgetting one produces a bug that only appears for users in one specific theme state. This removes that failure mode by construction.

Browser floor is Chrome 123, Safari 17.5, Firefox 120, all shipped during 2024.

### 2. Tailwind reads the tokens, it does not copy them

```css
@theme inline {
  --color-surface: var(--surface);
}
```

The `inline` keyword makes Tailwind emit `background-color: var(--surface)` rather than resolving to a hex at build time. That is what lets one utility class respond to a runtime theme change. Without it, `bg-surface` would bake in whichever value existed when the build ran and dark mode would silently break.

A useful consequence: **the `dark:` variant is almost never needed.** Colour is already theme-aware. Reach for `dark:` only when a non-colour property differs between themes, which is rare and should be justified in a comment.

The spacing scale lines up 1:1 by setting one value. `--spacing: 4px` means `p-3` is 12px, exactly like `--sp-3`. One grid, two syntaxes, no conversion table.

### 3. Recipes, not components

`recipes.ts` holds the class strings; the JSX lives in the app. shadcn/ui components are built on `cva`, so adapting one is: generate it, swap in the recipe, delete the default.

The separation earns its keep when Radix ships a breaking change. The JSX gets rewritten; the visual system is untouched. It also means the style guide and the app can describe the same component without a shared runtime.

### 4. Colour is rationed

Chrome is neutral. Colour carries exactly four meanings:

| Colour | Means |
|---|---|
| `--live` orange | a timer is running |
| `--info` blue | billable, and the sequential ramp for magnitude |
| success / warning / danger | budget health, invoice state, approval state, always with a word |
| `--viz-*` | chart series identity only |

Primary buttons use `--accent`, the near-black/near-white inverse of the background, **not** a brand hue. That is deliberate. It keeps orange meaning exactly one thing, and in a time tracker the running state is the one thing that must never be ambiguous.

---

## Tables

Every table is an **AG Grid Community** instance (MIT) behind one `DataGrid` wrapper. One grid engine means one keyboard model, one selection model, one export path, and one place to fix a bug. `ag-grid-theme.ts` maps AG Grid's parameters onto our tokens as `var()` references, so the grid inherits both themes with **no dark-mode grid code and no theme-change listener**: `browserColorScheme: "inherit"` ties it to the same `color-scheme` signal that drives `light-dark()`.

Requires AG Grid v33+ for the Theming API. Do not import `ag-grid-community/styles/*.css`; the Theming API emits its own.

### The Community boundary

Read the header of [`recipes/grid.ts`](recipes/grid.ts) before adding a table feature. These are Enterprise and unavailable to us:

> Row grouping · Aggregation · Pivoting · Master/detail · Tree data · Set filter · Range selection · Fill handle · Tool panels · Status bar · Context menu · Excel export · Server-side row model

Three are specced in the PRD, so each has a Community pattern:

| Enterprise | Instead |
|---|---|
| Row grouping | `groupRow()` full-width rows injected into the flat array, in server order |
| Aggregation | Totals computed server-side, carried on the group row and in `meta.totals` |
| Master/detail | `detailRow()` full-width rows injected on expand |

**The workaround is the better design.** Client-side aggregation would re-derive totals in the browser under different rounding than the server applies, and would happily sum a column the current user is not permitted to see. Server-computed totals cannot drift from the reports that run the same SQL.

The rest we never needed: the PRD already specifies our own toolbar filters, Columns popover, and row Actions menu.

### The no-shift rule

**Clicking anything in a table must never move the table.** Someone ticking checkboxes down a column is aiming at a target; if the first tick pushes the grid down a row, the second lands on the wrong record.

Every grid sits under an **action row** that is always in the layout at `--action-row-h`, with three states (browse, select, act) layered and cross-faded. All three are absolutely positioned inside a fixed-height container, so the height cannot change even mid-transition. An action that does not fit one row opens a modal; there is no option that grows the row.

The six normal culprits, and what we do instead: selection uses a background and an *inset* shadow rather than a border; row actions occupy their space always and toggle `opacity`, never `display`; menus are portalled overlays; the action row is reserved rather than appearing; action forms are inline-or-modal; and the page owns the grid's height so loading rows never resizes the container.

Enforced by `tokens/ag-grid-overrides.css` and verified by a Playwright diff (FRONTEND_PRD acceptance criterion 12a). A floating bottom bar was considered and rejected: it shifts nothing but covers the last rows of the table, which are the ones someone scrolled down to select.

### Where the grid is not used

- **The invoice document.** It must be pixel-identical in the app, the PDF, and the pay page. A virtualized grid inside a Playwright render is not identical to anything.
- **Anything printed.** Only visible rows exist in the DOM, so a printed grid is a screenshot of the viewport. `ag-grid-overrides.css` prints a note saying so rather than letting the truncation pass silently.
- **Short fixed lists** under roughly twenty rows with no sort or selection: the Day view entry list, rate history, invoice history. Loading 300KB to render six rows is a poor trade.

### Bundle

AG Grid is roughly 300KB gzipped against a 180KB initial-JS budget, so it is **route-level lazy loaded and never in the initial bundle**. We ship `AllCommunityModule` first for simplicity; swap to granular modules only when the bundle report says it matters.

## Charts

The categorical palette is validated, not chosen by eye. Slots are assigned in fixed order and never cycled.

```bash
node scripts/validate-palette.mjs "#2a78d6,#eb6834,#1baf7a,#eda100,#e87ba4,#008300,#4a3aa7,#e34948" --mode light --surface "#FFFFFF"
node scripts/validate-palette.mjs "#3987e5,#d95926,#199e70,#c98500,#d55181,#008300,#9085e9,#e66767" --mode dark  --surface "#111113"
```

Both pass every gate against our own surfaces. This runs in CI; a palette edit that fails any check fails the build.

Four rules the `<Chart>` wrapper enforces so no chart can opt out:

1. **Scatter, bubble, and small multiples cap at three series.** Only the first three slots clear the all-pairs separation floor, which those forms need because every series can sit adjacent to every other. Bars, lines, and stacks only compare neighbours, so all eight are safe.
2. **Slots 3, 4, and 5 are below 3:1 contrast on the light surface.** Charts using them ship visible direct labels or a table view.
3. **Colour follows the entity, never its rank.** Slot assignment is by stable entity ID, computed once per report and cached, so filtering never repaints the survivors.
4. **Never a dual-axis chart.** Two measures of different scale become two charts, small multiples, or one indexed chart.

---

## Conventions

**Never hard-code a value.** No hex, no px, no ms in a component. If a token is missing, add it here rather than inlining. This is the rule that keeps a theme swap to one file.

**Three control heights, no others.** 28px small, 32px default, 36px for form fields, which hold content being edited and need the room. Everything grows to 44px at the touch breakpoint.

**Numbers in columns get tabular figures.** `base.css` applies this to `td`, `th`, `time`, and anything marked `.tabular`. Standalone hero figures keep proportional figures, which are better spaced. Without this, a ticking timer makes its row jitter every second.

**Every interactive recipe ships its own focus-visible and disabled state.** A recipe that omits them is incomplete, not minimal.

**Motion is `transform` and `opacity` only.** Never height, never top. Durations come from the three tokens, and `prefers-reduced-motion` collapses all three to 1ms at the token layer.

---

## Extending it

Adding a token:

1. Add it to `tokens.css` under the right section, with a comment saying what it is for.
2. Expose it in `theme.css` if components should reach it as a utility.
3. Add it to `tokens.ts` only if JavaScript genuinely needs the value.
4. Add a swatch or scale row to `preview/index.html` so it is discoverable.

Adding a component:

1. Write the recipe in `recipes.ts`, including focus and disabled states.
2. Add a specimen to the style guide showing every variant, plus a Do/Don't if there is a way to misuse it.
3. If it introduces a rule, write the rule down in a callout. A rule that lives only in someone's head is not a rule.

---

## Relationship to the PRDs

[FRONTEND_PRD.md §2](../docs/FRONTEND_PRD.md) describes the design foundations as product requirements. **This folder supersedes it as the implementation**, on two points:

- The PRD sketches the conventional three-block theming pattern. The system ships `light-dark()` instead, which satisfies the same requirement ("no colour has its only definition inside a media query or a `[data-theme]` block") more strictly, since every colour is defined once on bare `:root`.
- The PRD lists tokens inline. `tokens.css` is canonical; the PRD's block is a summary.

Everything else in §2 (the palette, the chart rules, the accessibility baseline) is implemented here as specified.

---

## A note on the folder name

`design system` contains a space, which is fine because these files are **copied** into the app rather than imported from here. If it ever becomes an imported package, rename it to `design-system` first: a space in a path breaks enough tooling to be worth avoiding at that point.
