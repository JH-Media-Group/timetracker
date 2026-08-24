"use client";

/**
 * The small shared display pieces that show up on every detail page: the KPI
 * card, its inner label/value row, and the invoice state pill.
 *
 * These live here rather than in primitives because they carry domain meaning
 * (an invoice state has a fixed set of tones) and would not belong in a
 * product-neutral design system.
 */

import * as React from "react";
import { Info } from "lucide-react";
import { cn } from "@/lib/cn";
import { Badge, Card, Tooltip } from "@/components/ui/primitives";
import type { InvoiceState } from "@/lib/types";

const KPI_ICON_TONE = {
  neutral: "border-border bg-bg-muted text-ink-secondary",
  info: "border-info-border bg-info-bg text-info",
  success: "border-success-border bg-success-bg text-success",
  warning: "border-warning-border bg-warning-bg text-warning",
  danger: "border-danger-border bg-danger-bg text-danger",
  billable: "border-info-border bg-info-bg text-billable",
} as const;

export function Kpi({
  label, value, children, danger, muted, icon, tone = "neutral",
}: {
  label: React.ReactNode; value: string; children?: React.ReactNode;
  danger?: boolean; muted?: boolean; icon?: React.ReactNode;
  tone?: keyof typeof KPI_ICON_TONE;
}) {
  return (
    <Card className="flex flex-col gap-1">
      <div className="flex items-center gap-2 text-base text-ink-secondary">
        {icon && (
          <span className={cn("grid size-7 shrink-0 place-items-center rounded-md border", KPI_ICON_TONE[tone])} aria-hidden>
            {icon}
          </span>
        )}
        {label}
      </div>
      <div className={cn(
        "text-3xl font-semibold tracking-(--ls-tighter)",
        danger ? "text-danger" : muted ? "text-ink-tertiary" : "text-ink"
      )}>
        {value}
      </div>
      {children}
    </Card>
  );
}

export function KpiHelpLabel({ label, help }: { label: string; help: string }) {
  return (
    <span className="flex items-center gap-1.5">
      {label}
      <Tooltip content={help}>
        <button
          type="button"
          aria-label={`What does ${label.toLowerCase()} mean?`}
          className="grid size-5 place-items-center rounded-full text-ink-tertiary hover:bg-info-bg hover:text-info focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-1"
        >
          <Info className="size-3.5" />
        </button>
      </Tooltip>
    </span>
  );
}

export function KpiRow({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="flex items-center justify-between text-base text-ink-secondary">
      <span className="truncate">{label}</span>
      <span className={cn("shrink-0 tabular-nums", danger && "font-medium text-danger")}>{value}</span>
    </div>
  );
}

const INVOICE_STATE: Record<InvoiceState, { variant: "neutral" | "info" | "warning" | "danger" | "success"; label: string }> = {
  draft: { variant: "neutral", label: "Draft" },
  sent: { variant: "info", label: "Sent" },
  partial: { variant: "warning", label: "Partial" },
  late: { variant: "danger", label: "Late" },
  paid: { variant: "success", label: "Paid" },
  written_off: { variant: "neutral", label: "Written off" },
};

export function InvoiceBadge({ state }: { state: string }) {
  const m = INVOICE_STATE[state as InvoiceState] ?? INVOICE_STATE.draft;
  return <Badge variant={m.variant} dot={m.variant !== "neutral"}>{m.label}</Badge>;
}

/** Section heading used inside detail cards. */
export function SectionTitle({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="text-md font-semibold text-ink">{children}</h2>
      {action}
    </div>
  );
}
