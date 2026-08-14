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
import { cn } from "@/lib/cn";
import { Badge, Card } from "@/components/ui/primitives";
import type { InvoiceState } from "@/lib/types";

export function Kpi({
  label, value, children, danger, muted,
}: {
  label: React.ReactNode; value: string; children?: React.ReactNode;
  danger?: boolean; muted?: boolean;
}) {
  return (
    <Card className="flex flex-col gap-1">
      <div className="text-base text-ink-secondary">{label}</div>
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
