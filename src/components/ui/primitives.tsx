"use client";

/**
 * UI primitives.
 *
 * Thin components over the recipes in `recipes.ts`, with Radix supplying the
 * behaviour (focus trap, dismiss, roving tabindex) wherever the a11y contract
 * is non-trivial. The visual system lives entirely in the recipes: nothing here
 * hard-codes a colour, a size, or a duration.
 */

import * as React from "react";
import * as RDialog from "@radix-ui/react-dialog";
import * as RPopover from "@radix-ui/react-popover";
import * as RDropdown from "@radix-ui/react-dropdown-menu";
import * as RTooltip from "@radix-ui/react-tooltip";
import * as RSwitch from "@radix-ui/react-switch";
import * as RCheckbox from "@radix-ui/react-checkbox";
import * as RTabs from "@radix-ui/react-tabs";
import { Check, ChevronDown, Minus, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { avatarGradient, initials as makeInitials } from "@/lib/format";
import {
  avatarVariants, badgeVariants, bannerVariants, buttonVariants, cardVariants,
  choiceCardVariants, dialogContentClass, dialogOverlayClass, dropzoneVariants, trayContentClass,
  errorTextClass, helpTextClass, inputVariants, kbdClass, labelClass,
  menuItemClass, menuSeparatorClass, meterTrackClass, popoverClass,
  presenceDotVariants, requiredMarkClass, segmentedItemClass, segmentedRootClass,
  skeletonClass, tabClass, textareaClass, tokenClass, tokenInputClass,
  toggleGroupItemClass, tooltipClass,
} from "./recipes";
import type { VariantProps } from "class-variance-authority";

/* ------------------------------------------------------------------ Button */

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, touch, loading, children, disabled, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(buttonVariants({ variant, size, touch }), className)}
      disabled={disabled || loading}
      {...props}
    >
      {loading && <Spinner className="size-3.5" />}
      {children}
    </button>
  )
);
Button.displayName = "Button";

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cn("animate-spin-slow", className)} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/* ------------------------------------------------------------------- Input */

export interface InputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size">,
    VariantProps<typeof inputVariants> {}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, size, state, align, ...props }, ref) => (
    <input ref={ref} className={cn(inputVariants({ size, state, align }), className)} {...props} />
  )
);
Input.displayName = "Input";

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => <textarea ref={ref} className={cn(textareaClass, className)} {...props} />
);
Textarea.displayName = "Textarea";

export function Field({
  label, help, error, required, children, className, htmlFor, action,
}: {
  label?: React.ReactNode; help?: React.ReactNode; error?: React.ReactNode;
  required?: boolean; children: React.ReactNode; className?: string; htmlFor?: string;
  /**
   * A control on the label row, for the thing you need before you can fill the
   * field in: "Add new client" beside a client picker, say.
   *
   * Outside the `<label>` element rather than inside it, because clicking a
   * label activates its control, and a link that both navigates away and
   * focuses a select is a small trap.
   */
  action?: React.ReactNode;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      {(label || action) && (
        <div className="mb-1.5 flex items-end justify-between gap-2">
          {label ? (
            <label className={cn(labelClass, "mb-0")} htmlFor={htmlFor}>
              {label}{required && <span className={requiredMarkClass} aria-hidden>*</span>}
            </label>
          ) : <span />}
          {action}
        </div>
      )}
      {children}
      {help && !error && <div className={helpTextClass}>{help}</div>}
      {error && (
        <div className={errorTextClass} role="alert">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <circle cx="12" cy="12" r="10" /><path d="M12 8v4M12 16h.01" />
          </svg>
          {error}
        </div>
      )}
    </div>
  );
}

/** Native select styled as our control. Used where the option list is short and
 *  fixed; anything searchable uses the Combobox instead. */
export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, ...props }, ref) => (
    <div className="relative">
      <select
        ref={ref}
        className={cn(inputVariants(), "appearance-none pr-8 cursor-pointer", className)}
        {...props}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-tertiary" aria-hidden />
    </div>
  )
);
Select.displayName = "Select";

/** Prefix or suffix unit affix, e.g. "%" or "hours / week". */
export function Affix({ prefix, suffix, children }: { prefix?: React.ReactNode; suffix?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-stretch">
      {prefix != null && (
        <span className="grid place-items-center rounded-l-md border border-r-0 border-border bg-bg-muted px-2.5 text-base text-ink-tertiary">{prefix}</span>
      )}
      <div className={cn("min-w-0 flex-1 [&_input]:rounded-none", prefix != null ? "" : "[&_input]:rounded-l-md", suffix != null ? "" : "[&_input]:rounded-r-md")}>
        {children}
      </div>
      {suffix != null && (
        <span className="grid place-items-center rounded-r-md border border-l-0 border-border bg-bg-muted px-2.5 text-base text-ink-tertiary whitespace-nowrap">{suffix}</span>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- Controls */

export function Checkbox({
  checked, onCheckedChange, indeterminate, className, id, "aria-label": ariaLabel, disabled,
}: {
  checked?: boolean; onCheckedChange?: (v: boolean) => void; indeterminate?: boolean;
  className?: string; id?: string; "aria-label"?: string; disabled?: boolean;
}) {
  return (
    <RCheckbox.Root
      id={id}
      aria-label={ariaLabel}
      disabled={disabled}
      checked={indeterminate ? "indeterminate" : !!checked}
      onCheckedChange={(v) => onCheckedChange?.(v === true)}
      className={cn(
        "grid size-4 shrink-0 place-items-center rounded-sm border border-border-strong bg-surface",
        "transition-colors duration-(--dur-fast) hover:border-focus",
        "focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2",
        "data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=checked]:text-accent-ink",
        "data-[state=indeterminate]:border-accent data-[state=indeterminate]:bg-accent data-[state=indeterminate]:text-accent-ink",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
    >
      <RCheckbox.Indicator>
        {indeterminate ? <Minus className="size-3" strokeWidth={3} /> : <Check className="size-3" strokeWidth={3} />}
      </RCheckbox.Indicator>
    </RCheckbox.Root>
  );
}

export function Switch({ checked, onCheckedChange, id, "aria-label": ariaLabel }: {
  checked?: boolean; onCheckedChange?: (v: boolean) => void; id?: string; "aria-label"?: string;
}) {
  return (
    <RSwitch.Root
      id={id} aria-label={ariaLabel} checked={checked} onCheckedChange={onCheckedChange}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent",
        "transition-colors duration-(--dur-fast) ease-(--ease)",
        "focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2",
        "data-[state=unchecked]:bg-bg-strong data-[state=checked]:bg-accent"
      )}
    >
      <RSwitch.Thumb className="block size-4 rounded-full bg-white transition-transform duration-(--dur-fast) data-[state=checked]:translate-x-4" />
    </RSwitch.Root>
  );
}

export function Segmented<T extends string>({
  value, onChange, options, className, "aria-label": ariaLabel,
}: {
  value: T; onChange: (v: T) => void;
  options: { value: T; label: React.ReactNode }[];
  className?: string; "aria-label"?: string;
}) {
  return (
    <div className={cn(segmentedRootClass, className)} role="group" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={segmentedItemClass}
          data-state={value === o.value ? "on" : "off"}
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function ToggleGroup({ value, onChange, options }: {
  value: string[]; onChange: (v: string[]) => void; options: { value: string; label: string }[];
}) {
  return (
    <div className="flex gap-1">
      {options.map((o) => {
        const on = value.includes(o.value);
        return (
          <button
            key={o.value} type="button" className={toggleGroupItemClass} aria-pressed={on}
            onClick={() => onChange(on ? value.filter((v) => v !== o.value) : [...value, o.value])}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function ChoiceCard({
  selected, disabled, title, description, onClick,
}: { selected?: boolean; disabled?: boolean; title: string; description: string; onClick?: () => void }) {
  return (
    <button
      type="button" onClick={disabled ? undefined : onClick} disabled={disabled}
      className={choiceCardVariants({ state: disabled ? "disabled" : selected ? "selected" : "default" })}
      aria-pressed={selected}
    >
      <strong className="block text-base font-medium text-ink">{title}</strong>
      <span className="text-sm text-ink-secondary">{description}</span>
    </button>
  );
}

/* ----------------------------------------------------------------- Badges */

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {
  dot?: boolean;
}
export function Badge({ className, variant, dot, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props}>
      {dot && <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden />}
      {children}
    </span>
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className={kbdClass}>{children}</kbd>;
}

/* ---------------------------------------------------------------- Avatars */

export function Avatar({
  user, size = "md", className,
}: {
  user: { id: string; firstName: string; lastName: string; photo?: string };
  size?: "xs" | "sm" | "md" | "lg" | "xl"; className?: string;
}) {
  const label = `${user.firstName} ${user.lastName}`;
  return (
    <span
      className={cn(avatarVariants({ size }), className)}
      style={user.photo ? undefined : { background: avatarGradient(user.id) }}
      title={label}
      aria-label={label}
      role="img"
    >
      {user.photo
        ? <img src={user.photo} alt="" className="size-full object-cover" />
        : makeInitials(user.firstName, user.lastName)}
    </span>
  );
}

export function AvatarStack({ users, max = 7, size = "sm" }: {
  users: { id: string; firstName: string; lastName: string; photo?: string }[];
  max?: number; size?: "xs" | "sm" | "md";
}) {
  const shown = users.slice(0, max);
  const rest = users.length - shown.length;
  return (
    <span
      className="flex -space-x-1.5"
      role="img"
      aria-label={users.map((u) => `${u.firstName} ${u.lastName}`).join(", ")}
    >
      {shown.map((u) => <Avatar key={u.id} user={u} size={size} className="ring-2 ring-surface" />)}
      {rest > 0 && (
        <span className={cn(avatarVariants({ size }), "bg-bg-strong font-medium text-ink-secondary ring-2 ring-surface")} aria-hidden>
          +{rest}
        </span>
      )}
    </span>
  );
}

export function PresenceDot({ tracking, title }: { tracking?: boolean; title?: string }) {
  return <span className={presenceDotVariants({ state: tracking ? "tracking" : "idle" })} title={title} aria-label={title} />;
}

/* ------------------------------------------------------------------ Cards */

export function Card({ className, interactive, padded = true, children, ...props }: React.HTMLAttributes<HTMLDivElement> & { interactive?: boolean; padded?: boolean }) {
  return <div className={cn(cardVariants({ interactive, padded }), className)} {...props}>{children}</div>;
}

/* ----------------------------------------------------------------- Meters */

export function Meter({
  segments, className, outlined, height = "h-2",
}: {
  segments: { value: number; tone: "billable" | "nonBillable" | "ok" | "near" | "over" }[];
  className?: string; outlined?: boolean; height?: string;
}) {
  const tone: Record<string, string> = {
    billable: "bg-billable", nonBillable: "bg-non-billable",
    ok: "bg-budget-ok", near: "bg-budget-near", over: "bg-budget-over",
  };
  return (
    <div className={cn(meterTrackClass, height, outlined && "bg-transparent ring-1 ring-inset ring-border", "flex", className)}>
      {segments.map((s, i) => (
        <React.Fragment key={i}>
          {i > 0 && s.tone === "over" && <span className="w-0.5 shrink-0 bg-surface" />}
          <span className={cn("h-full", tone[s.tone])} style={{ width: `${Math.max(0, Math.min(s.value, 1)) * 100}%` }} />
        </React.Fragment>
      ))}
    </div>
  );
}

/* ------------------------------------------------------- Overlays: Dialog */

/**
 * Whether the subtree is inside a modal Dialog.
 *
 * This exists so that an overlay does not have to be told. A modal Dialog traps
 * focus and blocks pointer events outside its own DOM subtree, so a popover
 * that portals to the document root is dismissed the instant it opens. The rule
 * was written in prose on `PopoverContent` and on `ProjectPicker`, and the most
 * used dialog in the product broke it anyway: the picker in the new time entry
 * dialog opened and shut, and the report read "clicking project doesn't do
 * anything".
 *
 * A default nobody has to remember is worth more than a comment everybody can
 * read. `Tray` deliberately does not provide this: it is `modal={false}`, traps
 * nothing, and its body scrolls, so a portalled popover is right there.
 */
const InsideDialogContext = React.createContext(false);

/** True when the calling component is rendered inside a modal Dialog. */
export const useInsideDialog = () => React.useContext(InsideDialogContext);

export function Dialog({ open, onOpenChange, children }: { open: boolean; onOpenChange: (v: boolean) => void; children: React.ReactNode }) {
  return <RDialog.Root open={open} onOpenChange={onOpenChange}>{children}</RDialog.Root>;
}

export function DialogContent({
  title, description, children, footer, className, size = "md",
}: {
  title: string; description?: string; children?: React.ReactNode;
  footer?: React.ReactNode; className?: string; size?: "sm" | "md" | "lg" | "xl";
}) {
  const widths: Record<"sm" | "md" | "lg" | "xl", string> = {
    sm: "max-w-md", md: "max-w-lg", lg: "max-w-2xl", xl: "max-w-4xl",
  };
  return (
    <RDialog.Portal>
      <RDialog.Overlay className={dialogOverlayClass} />
      <RDialog.Content className={cn(dialogContentClass, widths[size], "max-h-[88vh] overflow-y-auto", className)}>
        <InsideDialogContext.Provider value={true}>
          <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
            <div>
              <RDialog.Title className="text-lg font-semibold text-ink">{title}</RDialog.Title>
              {description && <RDialog.Description className="mt-1 text-base text-ink-secondary">{description}</RDialog.Description>}
            </div>
            <RDialog.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Close"><X className="size-4" /></Button>
            </RDialog.Close>
          </div>
          <div className="px-5 py-4">{children}</div>
          {footer && <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>}
        </InsideDialogContext.Provider>
      </RDialog.Content>
    </RDialog.Portal>
  );
}

export const DialogTrigger = RDialog.Trigger;
export const DialogClose = RDialog.Close;

/**
 * A detail tray, docked to the right, beside a list rather than on top of it.
 *
 * **Deliberately not modal**, which is the whole design:
 *
 *   - **No overlay.** Nothing behind it dims or blurs.
 *   - **The page stays live.** Clicking another row on the left swaps what the
 *     tray shows instead of closing it, so a queue can be worked straight down.
 *     Editing on the left keeps working with the tray open.
 *   - **The page yields space** rather than being covered: `--tray-w` of right
 *     padding while one is open, so no row is hidden underneath.
 *
 * It still uses `RDialog` for the parts that are genuinely a dialog's: Escape,
 * the role and labelling, and returning focus on close. `modal={false}` turns
 * off the focus trap and the pointer-event blocking, and outside clicks are
 * explicitly not a dismissal, because an outside click is how you choose the
 * next record.
 *
 * Since it does not trap focus, a picker inside it does **not** need
 * `portal={false}`, unlike inside a real dialog (TALLY-39).
 */
export function Tray({
  open, onOpenChange, title, subtitle, actions, children, footer,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Sits in the header, where it stays reachable however far the body scrolls. */
  actions?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  /**
   * Tells the page to make room. One tray is open at a time, so a single
   * attribute on the root is enough and `base.css` owns the layout rule.
   */
  React.useEffect(() => {
    if (!open) return;
    document.documentElement.setAttribute("data-tray-open", "");
    return () => document.documentElement.removeAttribute("data-tray-open");
  }, [open]);

  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange} modal={false}>
      <RDialog.Portal>
        <RDialog.Content
          className={trayContentClass}
          aria-describedby={undefined}
          /* Opening must not steal focus from the list being worked through. */
          onOpenAutoFocus={(e) => e.preventDefault()}
          /* An outside click chooses the next record; it does not dismiss. */
          onInteractOutside={(e) => e.preventDefault()}
        >
          <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
            <div className="min-w-0">
              <RDialog.Title className="truncate text-lg font-semibold text-ink">{title}</RDialog.Title>
              {subtitle && <div className="mt-0.5 truncate text-base text-ink-secondary">{subtitle}</div>}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {actions}
              <RDialog.Close asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Close"><X className="size-4" /></Button>
              </RDialog.Close>
            </div>
          </div>

          {/* The body is the only scroll region, so the header and footer stay put. */}
          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>

          {footer && (
            <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>
          )}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

/* ------------------------------------------------------ Overlays: Popover */

export function Popover({ open, onOpenChange, children }: { open?: boolean; onOpenChange?: (v: boolean) => void; children: React.ReactNode }) {
  return <RPopover.Root open={open} onOpenChange={onOpenChange}>{children}</RPopover.Root>;
}
export const PopoverTrigger = RPopover.Trigger;
export const PopoverAnchor = RPopover.Anchor;

export function PopoverContent({
  children, className, align = "start", sideOffset = 6, onOpenAutoFocus, portal,
}: {
  children: React.ReactNode; className?: string; align?: "start" | "center" | "end"; sideOffset?: number;
  onOpenAutoFocus?: (e: Event) => void;
  /**
   * Whether to render in a portal at the document root. **Leave it unset.**
   *
   * Portalling is right almost everywhere: it escapes any `overflow: hidden`
   * ancestor, which is what a popover inside a scrolling grid cell needs.
   *
   * **It is wrong inside a modal Dialog.** The dialog traps focus and blocks
   * pointer events outside its own subtree, so a portalled popover renders
   * outside that subtree, is pulled straight back out, and dismisses itself:
   * the picker opened, closed, and sent typing to the topbar search instead
   * (TALLY-39).
   *
   * Unset, that decision is made here from `useInsideDialog`, and no caller has
   * to know. Passing a boolean overrides it, which is for the case that has not
   * happened yet; `tests/dialog-portal.test.ts` is what stops it being used to
   * put the bug back.
   */
  portal?: boolean;
}) {
  const insideDialog = useInsideDialog();
  const shouldPortal = portal ?? !insideDialog;

  const content = (
    <RPopover.Content align={align} sideOffset={sideOffset} onOpenAutoFocus={onOpenAutoFocus}
      className={cn(popoverClass, "p-0", className)}>
      {children}
    </RPopover.Content>
  );
  return shouldPortal ? <RPopover.Portal>{content}</RPopover.Portal> : content;
}

/* ----------------------------------------------------- Overlays: Dropdown */

export function Menu({ trigger, children, align = "end" }: { trigger: React.ReactNode; children: React.ReactNode; align?: "start" | "end" }) {
  return (
    <RDropdown.Root>
      <RDropdown.Trigger asChild>{trigger}</RDropdown.Trigger>
      <RDropdown.Portal>
        <RDropdown.Content align={align} sideOffset={6} className={cn(popoverClass, "min-w-[190px]")}>
          {children}
        </RDropdown.Content>
      </RDropdown.Portal>
    </RDropdown.Root>
  );
}

export function MenuItem({ children, onSelect, danger, shortcut, disabled }: {
  children: React.ReactNode; onSelect?: () => void; danger?: boolean; shortcut?: string; disabled?: boolean;
}) {
  return (
    <RDropdown.Item
      disabled={disabled}
      onSelect={(e) => { e.preventDefault(); onSelect?.(); }}
      className={cn(menuItemClass, danger && "text-danger data-[highlighted]:bg-danger-bg")}
    >
      {children}
      {shortcut && <span className="ml-auto"><Kbd>{shortcut}</Kbd></span>}
    </RDropdown.Item>
  );
}
export const MenuSeparator = () => <RDropdown.Separator className={menuSeparatorClass} />;
export const MenuLabel = ({ children }: { children: React.ReactNode }) => (
  <RDropdown.Label className="px-2 py-1.5 text-xs font-semibold uppercase tracking-[0.06em] text-ink-tertiary">{children}</RDropdown.Label>
);

/* ------------------------------------------------------- Overlays: Tooltip */

export function TooltipProvider({ children }: { children: React.ReactNode }) {
  return <RTooltip.Provider delayDuration={400} skipDelayDuration={200}>{children}</RTooltip.Provider>;
}

export function Tooltip({ content, children, side = "top" }: { content: React.ReactNode; children: React.ReactNode; side?: "top" | "bottom" | "left" | "right" }) {
  if (!content) return <>{children}</>;
  return (
    <RTooltip.Root>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content side={side} sideOffset={6} className={tooltipClass}>{content}</RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  );
}

/* ------------------------------------------------------------------- Tabs */

export function Tabs({ value, onValueChange, tabs, className }: {
  value: string; onValueChange: (v: string) => void;
  tabs: { value: string; label: React.ReactNode; count?: number }[]; className?: string;
}) {
  return (
    <RTabs.Root value={value} onValueChange={onValueChange}>
      <RTabs.List className={cn("flex gap-4 border-b border-border", className)}>
        {tabs.map((t) => (
          <RTabs.Trigger key={t.value} value={t.value} className={tabClass}>
            {t.label}
            {t.count != null && <span className="rounded-full bg-bg-muted px-1.5 font-mono text-xs text-ink-tertiary">{t.count}</span>}
          </RTabs.Trigger>
        ))}
      </RTabs.List>
    </RTabs.Root>
  );
}

/* ------------------------------------------------------------- Feedback */

export function Banner({ variant, title, children, onDismiss, action }: {
  variant?: "info" | "warning" | "danger" | "success"; title?: React.ReactNode;
  children?: React.ReactNode; onDismiss?: () => void; action?: React.ReactNode;
}) {
  return (
    <div className={bannerVariants({ variant })} role={variant === "danger" ? "alert" : "status"}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mt-0.5 shrink-0" aria-hidden>
        {variant === "warning"
          ? <><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" /><path d="M12 9v4M12 17h.01" /></>
          : <><circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" /></>}
      </svg>
      <div className="min-w-0 flex-1">
        {title && <strong className="block font-semibold">{title}</strong>}
        {children && <span className="text-ink-secondary">{children}</span>}
      </div>
      {action}
      {onDismiss && (
        <button onClick={onDismiss} aria-label="Dismiss" className="shrink-0 text-ink-tertiary hover:text-ink"><X className="size-4" /></button>
      )}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn(skeletonClass, className)} aria-hidden />;
}

export function EmptyState({ title, children, action, icon }: {
  title: React.ReactNode; children?: React.ReactNode; action?: React.ReactNode; icon?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg bg-bg-subtle px-6 py-12 text-center">
      {icon && <div className="text-ink-tertiary">{icon}</div>}
      <div className="font-medium text-ink">{title}</div>
      {children && <p className="max-w-[46ch] text-base text-ink-secondary">{children}</p>}
      {action && <div className="flex items-center gap-2 pt-1">{action}</div>}
    </div>
  );
}

export function Dropzone({ label, hint, onFiles, state }: {
  label?: React.ReactNode; hint?: React.ReactNode; onFiles?: (files: FileList) => void;
  state?: "idle" | "dragging" | "invalid";
}) {
  const [drag, setDrag] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  return (
    <div
      className={dropzoneVariants({ state: state ?? (drag ? "dragging" : "idle") })}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files.length) onFiles?.(e.dataTransfer.files); }}
      onClick={() => inputRef.current?.click()}
      role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); inputRef.current?.click(); } }}
    >
      <input ref={inputRef} type="file" className="sr-only" onChange={(e) => e.target.files && onFiles?.(e.target.files)} />
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-ink-tertiary" aria-hidden>
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5-5 5 5M12 5v12" />
      </svg>
      <div className="font-medium text-ink">{label ?? <>Drop a file, or <span className="text-link underline">choose one</span></>}</div>
      {hint && <div className="text-sm text-ink-tertiary">{hint}</div>}
    </div>
  );
}

/* ------------------------------------------------------------ Token input */

export function TokenInput({ values, onChange, placeholder, suggestions = [] }: {
  values: string[]; onChange: (v: string[]) => void; placeholder?: string; suggestions?: string[];
}) {
  const [draft, setDraft] = React.useState("");
  const add = (v: string) => { const t = v.trim(); if (t && !values.includes(t)) onChange([...values, t]); setDraft(""); };
  return (
    <div className={tokenInputClass}>
      {values.map((v) => (
        <span key={v} className={tokenClass}>
          {v}
          <button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))}
            className="grid size-3.5 place-items-center rounded-[3px] text-ink-tertiary hover:bg-bg-strong hover:text-ink">
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        className="min-w-[90px] flex-1 border-0 bg-transparent p-1 outline-none placeholder:text-ink-tertiary"
        value={draft} placeholder={placeholder}
        list={suggestions.length ? "token-suggestions" : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(draft); }
          if (e.key === "Backspace" && !draft && values.length) onChange(values.slice(0, -1));
        }}
        onBlur={() => draft && add(draft)}
      />
      {suggestions.length > 0 && (
        <datalist id="token-suggestions">{suggestions.map((s) => <option key={s} value={s} />)}</datalist>
      )}
    </div>
  );
}
