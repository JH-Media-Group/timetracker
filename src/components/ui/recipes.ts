/**
 * Tally - component recipes
 *
 * Ships verbatim into the app at `src/components/ui/recipes.ts`.
 *
 * These are `cva` variant definitions: the exact class strings each component
 * renders. shadcn/ui components are built on `cva`, so a generated component is
 * adapted by swapping in the recipe below and deleting the default one.
 *
 *   pnpm add class-variance-authority
 *
 * WHY RECIPES RATHER THAN COMPONENTS
 * Keeping the class strings separate from the JSX means the visual system has
 * one home. A Radix upgrade rewrites the JSX; the recipes are untouched. It
 * also lets the style guide and the app describe the same thing, because both
 * read from this file.
 *
 * RULES
 *  - No raw colours, sizes, or durations. Everything resolves to a token.
 *  - Every interactive recipe includes its focus-visible and disabled states.
 *  - Size variants come from the three control heights only: 28 / 32 / 36px,
 *    plus 44px at the touch breakpoint.
 */

import { cva, type VariantProps } from "class-variance-authority";

/* =============================================================================
   BUTTON

   One primary action per screen region. `primary` is the near-black/near-white
   accent, never a brand hue, which is what keeps orange meaning "running".
   `live` is reserved for the timer control and appears nowhere else.
   ========================================================================== */

export const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-1.5 whitespace-nowrap",
    "rounded-md border border-transparent font-medium",
    "transition-[background-color,border-color,color] duration-(--dur-fast) ease-(--ease)",
    "outline-none focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2",
    "disabled:pointer-events-none disabled:opacity-50",
    "[&_svg]:size-4 [&_svg]:shrink-0",
  ],
  {
    variants: {
      variant: {
        primary:
          "bg-accent text-accent-ink hover:bg-accent-hover active:bg-accent-active",
        secondary:
          "bg-surface text-ink border-border hover:bg-surface-hover hover:border-border-strong active:bg-surface-active",
        ghost:
          "text-ink-secondary hover:bg-surface-hover hover:text-ink active:bg-surface-active",
        danger:
          "bg-danger text-white hover:bg-danger/90 active:bg-danger/80",
        /** Destructive action that is not the confirm step: reads as dangerous
         *  without shouting, for menu items and secondary placements. */
        "danger-ghost":
          "text-danger hover:bg-danger-bg active:bg-danger-bg",
        /** The running-timer pill in the top bar. Nothing else. */
        live:
          "bg-live-bg text-live-ink border-live-border hover:brightness-[0.98]",
      },
      size: {
        sm: "h-7 px-2.5 text-sm",
        md: "h-8 px-3 text-base",
        lg: "h-9 px-4 text-base",
        icon: "h-8 w-8 p-0",
        "icon-sm": "h-7 w-7 p-0",
        "icon-lg": "h-9 w-9 p-0",
      },
      /** Touch targets: every control grows to 44px at the base breakpoint. */
      touch: {
        true: "max-md:h-11 max-md:min-w-11",
        false: "",
      },
    },
    defaultVariants: { variant: "secondary", size: "md", touch: true },
  }
);
export type ButtonVariants = VariantProps<typeof buttonVariants>;

/* =============================================================================
   INPUT / TEXTAREA / SELECT

   36px tall, taller than a button, because form fields hold content that has to
   stay readable while being edited. The focus treatment is a border swap plus a
   soft ring rather than the default outline, so the ring follows the radius.
   ========================================================================== */

export const inputVariants = cva(
  [
    "w-full rounded-md border bg-surface text-ink",
    "transition-[border-color,box-shadow] duration-(--dur-fast) ease-(--ease)",
    "placeholder:text-ink-tertiary",
    "hover:border-border-strong",
    "focus:border-focus focus:shadow-[var(--focus-ring)] focus:outline-none",
    "disabled:cursor-not-allowed disabled:bg-bg-muted disabled:text-ink-tertiary",
    "read-only:bg-bg-subtle",
  ],
  {
    variants: {
      size: {
        sm: "h-8 px-2 text-sm",
        md: "h-9 px-2.5 text-base",
      },
      state: {
        default: "border-border",
        /** Paired with a message below the field. Never colour alone. */
        invalid: "border-danger focus:border-danger focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--danger)_20%,transparent)]",
      },
      align: { left: "text-left", right: "text-right tabular-nums" },
    },
    defaultVariants: { size: "md", state: "default", align: "left" },
  }
);
export type InputVariants = VariantProps<typeof inputVariants>;

/** Duration and money fields are numeric columns: right-aligned, tabular. */
export const numericInputClass = "text-right tabular-nums font-mono";

export const textareaClass = [
  "w-full min-h-20 resize-y rounded-md border border-border bg-surface px-2.5 py-2",
  "text-base text-ink placeholder:text-ink-tertiary",
  "transition-[border-color,box-shadow] duration-(--dur-fast) ease-(--ease)",
  "hover:border-border-strong",
  "focus:border-focus focus:shadow-[var(--focus-ring)] focus:outline-none",
].join(" ");

/** The borderless title field used on entry and project pages. */
export const titleInputClass = [
  "w-full border-0 bg-transparent p-0 text-xl font-semibold tracking-(--ls-tight)",
  "text-ink placeholder:text-ink-tertiary focus:outline-none",
].join(" ");

export const labelClass = "block text-base font-medium text-ink";
export const helpTextClass = "mt-1 text-sm text-ink-tertiary";
export const errorTextClass = "mt-1 flex items-center gap-1 text-sm text-danger";

/* =============================================================================
   CONTROLS
   ========================================================================== */

export const checkboxClass = [
  "size-4 shrink-0 rounded-sm border border-border-strong bg-surface",
  "transition-colors duration-(--dur-fast)",
  "hover:border-focus",
  "focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2",
  "data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=checked]:text-accent-ink",
  "disabled:cursor-not-allowed disabled:opacity-50",
].join(" ");

export const radioClass = checkboxClass.replace("rounded-sm", "rounded-full");

export const switchVariants = cva(
  [
    "relative inline-flex shrink-0 cursor-pointer items-center rounded-full",
    "border-2 border-transparent transition-colors duration-(--dur-fast) ease-(--ease)",
    "focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2",
    "data-[state=unchecked]:bg-bg-strong data-[state=checked]:bg-accent",
    "disabled:cursor-not-allowed disabled:opacity-50",
  ],
  {
    variants: { size: { md: "h-5 w-9", sm: "h-4 w-7" } },
    defaultVariants: { size: "md" },
  }
);

/** Day/Week/Calendar, density, and every other exclusive choice of 2 to 4. */
export const segmentedRootClass =
  "inline-flex items-center gap-0.5 rounded-md bg-bg-muted p-0.5";

export const segmentedItemClass = [
  "inline-flex h-7 items-center justify-center rounded-[5px] px-3",
  "text-base font-medium text-ink-secondary",
  "transition-[background-color,color] duration-(--dur-fast) ease-(--ease)",
  "hover:text-ink",
  "focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-1",
  "data-[state=on]:bg-surface data-[state=on]:text-ink data-[state=on]:shadow-xs",
].join(" ");

/* =============================================================================
   BADGES, CHIPS, STATUS PILLS

   Badge  - a label on an entity (Billable, Fixed Fee, Archived)
   Chip   - a removable filter token
   Pill   - a state (invoice status, approval status). Always carries a word.
   ========================================================================== */

export const badgeVariants = cva(
  [
    "inline-flex items-center gap-1 whitespace-nowrap rounded-full",
    "border border-transparent px-2 text-xs font-medium",
    "h-5",
  ],
  {
    variants: {
      variant: {
        neutral: "bg-bg-muted text-ink-secondary",
        outline: "border-border text-ink-secondary",
        solid:   "bg-accent text-accent-ink",
        success: "bg-success-bg text-success border-success-border",
        warning: "bg-warning-bg text-warning border-warning-border",
        danger:  "bg-danger-bg text-danger border-danger-border",
        info:    "bg-info-bg text-info border-info-border",
        live:    "bg-live-bg text-live-ink border-live-border font-semibold",
      },
    },
    defaultVariants: { variant: "neutral" },
  }
);
export type BadgeVariants = VariantProps<typeof badgeVariants>;

/**
 * Status pill. Identical shape to a badge, but the API takes a domain state and
 * resolves the variant through INVOICE_STATE_VARIANT / APPROVAL_STATE_VARIANT in
 * tokens.ts, so no component decides what "late" looks like.
 * A dot is included for the states where an icon would be too heavy.
 */
export const statusPillClass = "gap-1.5 [&>[data-dot]]:size-1.5 [&>[data-dot]]:rounded-full [&>[data-dot]]:bg-current";

export const chipClass = [
  "inline-flex h-6 items-center gap-1 rounded-md border border-border bg-surface pl-2 pr-1",
  "text-sm text-ink transition-colors duration-(--dur-fast)",
  "hover:border-border-strong hover:bg-surface-hover",
].join(" ");

/** Keyboard hint, in the command palette and the shortcut sheet. */
export const kbdClass = [
  "inline-flex h-5 min-w-5 items-center justify-center rounded-sm",
  "border border-border bg-bg-muted px-1.5",
  "font-mono text-xs text-ink-tertiary",
].join(" ");

/* =============================================================================
   AVATAR
   ========================================================================== */

export const avatarVariants = cva(
  [
    "relative inline-grid shrink-0 place-items-center overflow-hidden rounded-full",
    "bg-bg-strong font-semibold text-white select-none",
  ],
  {
    variants: {
      size: {
        xs: "size-[18px] text-[9px]",
        sm: "size-[22px] text-[10px]",
        md: "size-7 text-[11px]",
        lg: "size-9 text-base",
        xl: "size-14 text-lg",
      },
      /** System and integration actors get a squircle so a bot is never mistaken
       *  for a person at a glance. */
      shape: { round: "rounded-full", square: "rounded-md" },
    },
    defaultVariants: { size: "md", shape: "round" },
  }
);
export type AvatarVariants = VariantProps<typeof avatarVariants>;

/** Overlapping stack for project members and role holders. */
export const avatarStackClass =
  "flex -space-x-1.5 [&>*]:ring-2 [&>*]:ring-surface";

/**
 * Avatar fallback chain: photo, then initials on a deterministic gradient, then
 * a generic glyph. The photo is the primary treatment; most people upload one.
 *
 * The gradient is derived from a hash of the USER ID, never from list position.
 * Position-derived colour changes when a list re-sorts, which destroys the one
 * thing an avatar is for: being recognisable at 18px without reading it.
 */
export const avatarImageClass = "size-full object-cover";

export function avatarGradient(userId: string): string {
  let h = 0;
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) >>> 0;
  const a = h % 360;
  const b = (a + 40) % 360;
  return `linear-gradient(135deg, hsl(${a} 62% 58%), hsl(${b} 58% 45%))`;
}

/* =============================================================================
   MORE FORM CONTROLS

   Beyond the text input: the controls the product actually needs, each with the
   states that make it usable.
   ========================================================================== */

/** Drop target for receipts, logos, and invoice attachments. Accepts drag,
 *  paste from clipboard, and the file picker; all three are wired, because
 *  screenshot-to-clipboard is how most receipts arrive. */
export const dropzoneVariants = cva(
  [
    "flex flex-col items-center gap-1.5 rounded-lg border border-dashed px-4 py-6 text-center",
    "transition-[border-color,background-color] duration-(--dur-fast) ease-(--ease)",
    "cursor-pointer",
  ],
  {
    variants: {
      state: {
        idle:     "border-border-strong bg-bg-subtle text-ink-secondary hover:border-focus hover:bg-info-bg",
        dragging: "border-focus bg-info-bg text-ink",
        invalid:  "border-danger bg-danger-bg text-danger",
      },
    },
    defaultVariants: { state: "idle" },
  }
);

/** Multi-select token input: roles, departments, tags, invoice recipients. */
export const tokenInputClass = [
  "flex min-h-9 w-full flex-wrap items-center gap-1 rounded-md border border-border bg-surface px-1.5 py-1",
  "transition-[border-color,box-shadow] duration-(--dur-fast)",
  "focus-within:border-focus focus-within:shadow-[var(--focus-ring)]",
].join(" ");

export const tokenClass =
  "inline-flex h-[22px] items-center gap-1 rounded-sm bg-bg-muted pl-2 pr-1 text-sm text-ink";

/**
 * Choice card. For a small mutually exclusive set where each option needs a
 * sentence of explanation, such as project type, where picking wrong has real
 * billing consequences. Uses the live treatment for selection because the
 * choice is consequential and should be unmissable.
 */
export const choiceCardVariants = cva(
  [
    "relative cursor-pointer rounded-lg border px-4 py-3 text-left",
    "transition-[border-color,background-color] duration-(--dur-fast) ease-(--ease)",
    "focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2",
  ],
  {
    variants: {
      state: {
        default:  "border-border bg-surface hover:border-border-strong",
        selected: "border-live bg-live-bg",
        disabled: "cursor-not-allowed border-border bg-bg-muted opacity-55",
      },
    },
    defaultVariants: { state: "default" },
  }
);

/** Multi-select toggle group: reminder days, weekday filters. */
export const toggleGroupItemClass = [
  "h-[30px] min-w-[42px] rounded-md border border-border bg-surface px-2",
  "text-sm text-ink-secondary transition-colors duration-(--dur-fast)",
  "hover:border-border-strong",
  "focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-1",
  "aria-pressed:border-live-border aria-pressed:bg-live-bg aria-pressed:font-medium aria-pressed:text-live-ink",
].join(" ");

/** Input with a unit affix: percent, currency, hours per week. The affix is
 *  chrome, not content, so it is `--bg-muted` and never focusable. */
export const affixWrapClass = "flex items-stretch";
export const affixClass =
  "grid place-items-center border border-border bg-bg-muted px-2.5 text-base text-ink-tertiary";

/** Colour input: a swatch button that opens the picker, plus the hex field. */
export const colorSwatchClass =
  "h-9 w-[34px] shrink-0 cursor-pointer rounded-l-md border border-r-0 border-border";

/** Date picker calendar. Today is OUTLINED, the selection is FILLED: two
 *  different questions need two different affordances, or someone who picked a
 *  past date can no longer find today. */
export const calendarDayVariants = cva(
  "grid h-8 place-items-center rounded-md text-base transition-colors duration-(--dur-fast)",
  {
    variants: {
      state: {
        default:  "text-ink hover:bg-surface-hover",
        outside:  "text-ink-tertiary hover:bg-surface-hover",
        today:    "text-ink shadow-[inset_0_0_0_1px_var(--border-strong)] hover:bg-surface-hover",
        selected: "bg-accent font-medium text-accent-ink",
        inRange:  "rounded-none bg-info-bg text-ink",
        disabled: "cursor-not-allowed text-ink-tertiary opacity-40",
      },
    },
    defaultVariants: { state: "default" },
  }
);

/** Required marker. Paired with `aria-required`, never colour alone. */
export const requiredMarkClass = "ml-0.5 text-danger";

/** Presence dot rendered before an avatar in the Team list. */
export const presenceDotVariants = cva(
  "inline-block size-1.5 shrink-0 rounded-full",
  {
    variants: {
      state: {
        tracking: "bg-live animate-pulse-live",
        idle: "bg-transparent ring-1 ring-inset ring-border-strong",
      },
    },
    defaultVariants: { state: "idle" },
  }
);

/* =============================================================================
   SURFACES: card, panel, popover, dialog
   ========================================================================== */

export const cardVariants = cva(
  "rounded-lg border border-border bg-surface",
  {
    variants: {
      interactive: {
        true: [
          "cursor-pointer transition-[border-color,box-shadow,transform] duration-(--dur-fast) ease-(--ease)",
          "hover:-translate-y-px hover:border-border-strong hover:shadow-sm",
          "focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2",
        ].join(" "),
        false: "",
      },
      padded: { true: "p-4", false: "" },
    },
    defaultVariants: { interactive: false, padded: true },
  }
);

export const popoverClass = [
  "z-(--z-dropdown) rounded-xl border border-border bg-surface p-1 shadow-md",
  "origin-(--radix-popover-content-transform-origin)",
  "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
  "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
].join(" ");

export const menuItemClass = [
  "flex cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5",
  "text-base text-ink outline-none",
  "data-[highlighted]:bg-surface-hover",
  "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
  "[&_svg]:size-4 [&_svg]:text-ink-tertiary",
].join(" ");

export const menuSeparatorClass = "my-1 h-px bg-border";

export const dialogOverlayClass = [
  "fixed inset-0 z-(--z-modal) bg-overlay backdrop-blur-[2px]",
  "data-[state=open]:animate-in data-[state=open]:fade-in-0",
  "data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
].join(" ");

export const dialogContentClass = [
  "fixed left-1/2 top-1/2 z-(--z-modal) w-full max-w-lg -translate-x-1/2 -translate-y-1/2",
  "rounded-2xl border border-border bg-surface shadow-xl",
  "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
  "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
  /* Full-height sheet on phones: modals are unusable centred on a small screen. */
  "max-md:inset-x-0 max-md:bottom-0 max-md:top-auto max-md:max-w-none max-md:translate-x-0 max-md:translate-y-0",
  "max-md:rounded-b-none",
].join(" ");

export const tooltipClass = [
  "z-(--z-tooltip) rounded-md bg-ink px-2 py-1 text-sm text-ink-inverse shadow-md",
  "data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0",
].join(" ");

/* -----------------------------------------------------------------------------
   CHART TOOLTIP

   Distinct from the UI tooltip above, which is a dark chip explaining a control.
   This one is a light panel carrying a table of values, so it reads as data.

   `pointer-events: none` is load-bearing: a tooltip that can receive the pointer
   will sit between the cursor and the mark it describes, steal the mouseleave,
   and flicker. Position it from the hit target's bounding box rather than from
   raw pointer coordinates, so it stays put while the pointer moves inside a slot.
   -------------------------------------------------------------------------- */

export const chartTooltipClass = [
  "pointer-events-none fixed z-(--z-tooltip) min-w-[170px] max-w-[280px]",
  "rounded-md border border-border bg-surface px-2.5 py-2 text-sm shadow-md",
  "transition-opacity duration-(--dur-fast) motion-reduce:transition-none",
].join(" ");

export const chartTooltipTitleClass = "mb-1.5 font-medium text-ink";
export const chartTooltipRowClass = "flex items-center gap-2 py-0.5";
export const chartTooltipSwatchClass = "size-2 shrink-0 rounded-[2px]";
export const chartTooltipLabelClass = "text-ink-secondary";
export const chartTooltipValueClass = "ms-auto ps-4 tabular-nums text-ink";
/** The derived figure that is the actual reason someone hovered: the total on a
 *  stack, the margin on profit, over/under budget on progress. Never a repeat of
 *  the axis value, which the axis already stated. */
export const chartTooltipFootClass =
  "mt-1.5 flex items-center border-t border-border pt-1.5";

/** Full-height transparent hit target per slot. The mark itself is never the
 *  hit target: chasing an 8px dot with a pointer is miserable. */
export const chartHitClass = "cursor-crosshair fill-transparent";

/** Tint behind the hovered column, and the focus ring when the chart is tabbed to. */
export const chartHoverBandClass = "pointer-events-none fill-surface-hover";
export const chartRootClass =
  "cursor-crosshair focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2 focus-visible:rounded-md";

/* =============================================================================
   NAVIGATION
   ========================================================================== */

export const navItemClass = [
  "group relative flex items-center gap-2 rounded-md px-2 py-1.5",
  "text-base text-ink-secondary",
  "transition-[background-color,color] duration-(--dur-fast) ease-(--ease)",
  "hover:bg-nav-hover hover:text-ink",
  "focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-1",
  /* Active state carries a 2px accent rail as well as the fill, so the current
     page is identifiable without relying on a subtle background difference.
     The fills are nav-specific tokens: the shared surface steps are measured
     against --surface, and against the sidebar's --bg-subtle they were too
     close to see (TALLY-10). */
  "aria-[current=page]:bg-nav-active aria-[current=page]:font-medium aria-[current=page]:text-ink",
  "aria-[current=page]:before:absolute aria-[current=page]:before:left-0 aria-[current=page]:before:top-1/2",
  "aria-[current=page]:before:h-4 aria-[current=page]:before:w-0.5 aria-[current=page]:before:-translate-y-1/2",
  "aria-[current=page]:before:rounded-full aria-[current=page]:before:bg-accent",
  "[&_svg]:size-4 [&_svg]:shrink-0",
].join(" ");

export const navSectionLabelClass =
  "px-2 pb-2 text-xs font-semibold uppercase tracking-[0.06em] text-ink-tertiary";

export const tabClass = [
  "relative inline-flex items-center gap-1.5 border-b-2 border-transparent px-0.5 py-2",
  "text-base text-ink-secondary",
  "transition-colors duration-(--dur-fast) ease-(--ease)",
  "hover:text-ink",
  "focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2",
  "data-[state=active]:border-ink data-[state=active]:font-medium data-[state=active]:text-ink",
].join(" ");

export const tabCountClass =
  "rounded-full bg-bg-muted px-1.5 font-mono text-xs text-ink-tertiary";

/* =============================================================================
   FEEDBACK: banner, toast, skeleton, empty state
   ========================================================================== */

export const bannerVariants = cva(
  "flex items-start gap-3 rounded-md border px-4 py-2.5 text-base",
  {
    variants: {
      variant: {
        info:    "border-info-border bg-info-bg text-info",
        warning: "border-warning-border bg-warning-bg text-warning",
        danger:  "border-danger-border bg-danger-bg text-danger",
        success: "border-success-border bg-success-bg text-success",
      },
    },
    defaultVariants: { variant: "info" },
  }
);
export type BannerVariants = VariantProps<typeof bannerVariants>;

export const toastClass = [
  "pointer-events-auto flex w-full max-w-sm items-start gap-3",
  "rounded-xl border border-border bg-surface p-3 shadow-lg",
  "data-[state=open]:animate-in data-[state=open]:slide-in-from-bottom-2 data-[state=open]:fade-in-0",
  "data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
].join(" ");

/**
 * Skeletons match the geometry of what they replace, so nothing shifts when the
 * data lands. Never a full-page spinner.
 */
export const skeletonClass = [
  "rounded-md bg-bg-muted",
  "bg-[linear-gradient(90deg,var(--bg-muted)_25%,var(--bg-strong)_37%,var(--bg-muted)_63%)]",
  "bg-[length:200%_100%] animate-shimmer",
].join(" ");

export const emptyStateClass =
  "flex flex-col items-center justify-center gap-3 rounded-lg bg-bg-subtle px-6 py-12 text-center";

/* =============================================================================
   DATA DISPLAY
   ========================================================================== */

export const tableRootClass = "w-full border-separate border-spacing-0 text-base";

export const tableHeadClass = [
  "sticky top-(--topbar-h) z-(--z-sticky) bg-bg-muted",
  "h-9 px-3 text-left text-xs font-semibold uppercase tracking-[0.04em] text-ink-tertiary",
  "border-b border-border",
].join(" ");

export const tableRowClass = [
  "h-(--row-h) border-b border-border",
  "transition-colors duration-(--dur-fast)",
  "hover:bg-surface-hover",
  "data-[selected=true]:bg-info-bg",
].join(" ");

export const tableCellClass = "px-3 align-middle";
export const tableNumericCellClass = "px-3 text-right align-middle tabular-nums";

/** Group header, e.g. a client name above its projects. */
export const tableGroupRowClass =
  "bg-bg-subtle text-base font-medium text-ink";

export const tableTotalRowClass =
  "border-t border-border-strong font-semibold text-ink";

/**
 * Proportional bar. Used for utilization, billable split, and budget
 * consumption. The over-budget overflow is a separate segment in danger,
 * separated by a 2px surface gap so the boundary is unmistakable.
 */
export const meterTrackClass =
  "relative h-2 w-full overflow-hidden rounded-full bg-bg-strong";

export const meterFillVariants = cva(
  "h-full rounded-full transition-[width] duration-(--dur) ease-(--ease)",
  {
    variants: {
      tone: {
        billable:    "bg-billable",
        nonBillable: "bg-non-billable",
        ok:          "bg-budget-ok",
        near:        "bg-budget-near",
        over:        "bg-budget-over",
      },
    },
    defaultVariants: { tone: "ok" },
  }
);

/* =============================================================================
   TALLY PATTERNS
   The composites that only exist in this product.
   ========================================================================== */

/** Top-bar timer pill. Idle uses the accent; running uses the live treatment. */
export const timerPillVariants = cva(
  [
    "inline-flex h-8 items-center gap-2 rounded-full border px-3",
    "font-medium transition-colors duration-(--dur-fast) ease-(--ease)",
    "focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2",
  ],
  {
    variants: {
      state: {
        idle:    "border-transparent bg-accent text-accent-ink hover:bg-accent-hover",
        running: "border-live-border bg-live-bg text-live-ink",
      },
    },
    defaultVariants: { state: "idle" },
  }
);

/** The elapsed readout. Mono and tabular so a ticking second never shifts width. */
export const timerReadoutClass = "font-mono text-base tabular-nums";

/** A time entry row in Day view. */
export const entryRowVariants = cva(
  [
    "group relative flex items-center gap-3 border-b border-border px-3 py-3",
    "transition-colors duration-(--dur-fast)",
    "hover:bg-surface-hover",
  ],
  {
    variants: {
      state: {
        default: "",
        running: "bg-live-bg before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-live",
        locked:  "bg-bg-subtle text-ink-secondary",
      },
    },
    defaultVariants: { state: "default" },
  }
);

/** A calendar block. The project colour is passed inline as a CSS variable. */
export const calendarBlockClass = [
  "absolute inset-x-0.5 overflow-hidden rounded-md px-1.5 py-1",
  "text-xs leading-tight text-white",
  "ring-2 ring-surface",  /* the 2px gap that separates overlapping blocks */
  "cursor-pointer transition-[filter] duration-(--dur-fast) hover:brightness-95",
].join(" ");

/** Ghost block for an imported calendar event that is not yet tracked. */
export const calendarGhostClass = [
  "absolute inset-x-0.5 overflow-hidden rounded-md border border-dashed border-border-strong",
  "bg-bg-muted px-1.5 py-1 text-xs leading-tight text-ink-secondary",
].join(" ");

/** Week-grid cell: looks like text until focused, then reveals the input. */
export const weekCellClass = [
  "h-9 w-full rounded-md border border-transparent bg-transparent px-2 text-right",
  "text-base tabular-nums text-ink",
  "transition-[border-color,background-color] duration-(--dur-fast)",
  "hover:border-border",
  "focus:border-focus focus:bg-surface focus:shadow-[var(--focus-ring)] focus:outline-none",
].join(" ");

/* -----------------------------------------------------------------------------
   THE ACTION ROW

   The single most important layout rule in the product: **clicking anything in a
   table must never move the table.**

   A user ticks a checkbox to act on a row. If that tick pushes the grid down by
   even one row, the next row they meant to tick is no longer under the pointer,
   and on a 40-row bulk edit that is a guaranteed mis-click. The same applies to
   opening a row's Actions menu, and to choosing a bulk action.

   The mechanism: one row above the grid that is ALWAYS present at exactly
   `--action-row-h`, with three states layered on top of each other and
   cross-faded. Because all three are absolutely positioned inside a
   fixed-height container, the height cannot change even mid-transition.

     browse  filters, column picker, density, export        (nothing selected)
     select  "N selected", bulk actions, clear              (rows ticked)
     act     the chosen action's inline form                (action chosen)

   An action whose form does not fit one row opens a MODAL instead. Growing the
   action row is not an option; a modal is an overlay and shifts nothing.
   -------------------------------------------------------------------------- */

/**
 * The card frame a grid lives in. Block-level, so the action row and the grid
 * stack flush and the radius clips both. Give it a height; the grid scrolls
 * inside it rather than growing the page.
 */
export const tableFrameClass =
  "flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-surface";

/**
 * The fixed-height container. Its height is the contract.
 *
 * `w-full` is load-bearing: every layer inside is `position: absolute`, so this
 * element has no in-flow content and would collapse to its padding width if a
 * parent ever sized it by content. Do not remove it.
 */
export const actionRowClass = [
  "relative flex w-full items-center",
  "h-(--action-row-h) min-h-(--action-row-h) shrink-0",
  "border-b border-border px-3",
].join(" ");

/**
 * Each state layer. Absolutely positioned so it is out of flow and therefore
 * cannot contribute height. Only the active layer accepts pointer events, so an
 * invisible layer can never swallow a click.
 */
export const actionRowLayerVariants = cva(
  [
    "absolute inset-x-3 inset-y-0 flex items-center gap-2",
    "transition-opacity duration-(--dur-fast) ease-(--ease)",
    "motion-reduce:transition-none",
  ],
  {
    variants: {
      active: {
        true: "opacity-100 pointer-events-auto",
        false: "opacity-0 pointer-events-none",
      },
    },
    defaultVariants: { active: false },
  }
);

/** "3 selected" plus the count chip. */
export const selectionCountClass =
  "flex items-center gap-2 text-base font-medium text-ink whitespace-nowrap";

/**
 * The action group. Scrolls horizontally rather than wrapping: wrapping is the
 * one thing that would break the fixed height.
 */
export const actionGroupClass =
  "flex items-center gap-2 overflow-x-auto scrollbar-none min-w-0";

/** Vertical hairline separating action groups. */
export const actionSeparatorClass = "h-5 w-px shrink-0 bg-border";

/**
 * Pushes this control and everything after it to the trailing edge.
 *
 * The select layer is ordered in two groups: MODIFY actions on the left (add
 * tags, set rate, set billable) and REMOVAL actions on the right (archive,
 * delete). The gap between them is deliberate distance, not decoration: a user
 * clicking down a row of small buttons should not be one pixel of misjudgement
 * away from deleting forty records. Order within each group is by frequency.
 *
 * When the row overflows on a narrow screen the auto margin collapses and the
 * group scrolls normally, so nothing is ever unreachable.
 */
export const actionEndClass = "ms-auto";

/** Inline action form, the `act` state. Label, control, confirm, cancel. */
export const actionFormClass =
  "flex items-center gap-2 min-w-0 text-base";

/** KPI card, the five-across row on the project page. */
export const kpiCardClass =
  "flex flex-col gap-1 rounded-lg border border-border bg-surface p-4";
export const kpiLabelClass = "text-base text-ink-secondary";
export const kpiValueClass = "text-3xl font-semibold tracking-(--ls-tighter) text-ink";
export const kpiSubRowClass =
  "flex items-center justify-between text-base text-ink-secondary";
