"use client";

/**
 * Invoices.
 *
 * One table with four saved views over it, plus the two things that are not
 * invoices but live in the same part of someone's head: recurring schedules and
 * retainer balances.
 */

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColDef } from "ag-grid-community";
import { Plus } from "lucide-react";
import * as api from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatDateUS, formatDueIn, formatMoney } from "@/lib/format";
import type { Invoice, InvoiceState, RecurringInvoice, Retainer } from "@/lib/types";
import { Badge, Button, Card, EmptyState, Select } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { PageBody, PageHeader, useUrlState } from "@/components/app/page-chrome";
import { DataGrid } from "@/components/app/data-grid";
import { InvoiceBadge, Kpi } from "@/components/app/kpi";
import { useApp, useCan } from "@/components/app/providers";
import type { GridRow } from "@/components/ui/grid";

type View = "outstanding" | "draft" | "paid" | "all" | "recurring" | "retainers";

interface Row {
  _id: string; _kind: "data";
  id: string; number: string; client: string; subject: string;
  issueDate: string; dueDate: string; state: InvoiceState;
  amount: number; balance: number; due: string;
}

export default function InvoicesPage() {
  const router = useRouter();
  const toast = useToast();
  const { params, set } = useUrlState();
  const { clientById } = useApp();
  const can = useCan();

  const view = (params.get("view") as View) || "outstanding";

  const { data: invoices = [], isLoading } = useQuery({ queryKey: ["invoices"], queryFn: api.listInvoices });
  const all = invoices as Invoice[];
  const today = React.useMemo(() => new Date(), []);

  const stats = React.useMemo(() => {
    let outstanding = 0, overdue = 0, draft = 0, paidThisYear = 0;
    const year = String(today.getFullYear());
    for (const i of all) {
      const balance = i.totalCents - i.paidCents;
      if (i.state === "draft") draft += i.totalCents;
      if (i.state === "sent" || i.state === "partial" || i.state === "late") outstanding += balance;
      if (i.state === "late") overdue += balance;
      if (i.paidAt?.startsWith(year)) paidThisYear += i.paidCents;
    }
    return { outstanding, overdue, draft, paidThisYear };
  }, [all, today]);

  const counts = React.useMemo(() => ({
    outstanding: all.filter((i) => i.state === "sent" || i.state === "partial" || i.state === "late").length,
    draft: all.filter((i) => i.state === "draft").length,
    paid: all.filter((i) => i.state === "paid").length,
    all: all.length,
  }), [all]);

  const rows = React.useMemo<GridRow<Row>[]>(() => {
    const filtered = all.filter((i) =>
      view === "draft" ? i.state === "draft"
      : view === "paid" ? i.state === "paid" || i.state === "written_off"
      : view === "all" ? true
      : i.state === "sent" || i.state === "partial" || i.state === "late"
    );
    return filtered
      .sort((a, b) => b.issueDate.localeCompare(a.issueDate))
      .map((i) => ({
        _id: i.id, _kind: "data" as const, id: i.id, number: i.number,
        client: clientById.get(i.clientId)?.name ?? "Unknown client",
        subject: i.subject ?? "Services rendered",
        issueDate: i.issueDate, dueDate: i.dueDate, state: i.state,
        amount: i.totalCents, balance: i.totalCents - i.paidCents,
        due: i.state === "paid" || i.state === "written_off" ? "" : formatDueIn(i.dueDate, today),
      }));
  }, [all, view, clientById, today]);

  const columns = React.useMemo<ColDef[]>(() => [
    {
      colId: "number", field: "number", headerName: "Invoice", width: 170,
      cellRenderer: (p: { data?: Row }) => p.data && (
        <span className="font-medium tabular-nums text-ink">{p.data.number}</span>
      ),
    },
    {
      colId: "client", field: "client", headerName: "Client", flex: 1, minWidth: 220,
      cellRenderer: (p: { data?: Row }) => p.data && (
        <span className="flex min-w-0 flex-col justify-center leading-tight">
          <span className="truncate text-ink">{p.data.client}</span>
          <span className="truncate text-sm text-ink-tertiary">{p.data.subject}</span>
        </span>
      ),
    },
    { colId: "issueDate", field: "issueDate", headerName: "Issued", type: "date", width: 120 },
    {
      colId: "dueDate", field: "dueDate", headerName: "Due", width: 150,
      cellRenderer: (p: { data?: Row }) => p.data && (
        <span className="flex min-w-0 flex-col justify-center leading-tight">
          <span className="tabular-nums text-ink">{formatDateUS(p.data.dueDate)}</span>
          {p.data.due && (
            <span className={cn("text-sm", p.data.state === "late" ? "text-danger" : "text-ink-tertiary")}>{p.data.due}</span>
          )}
        </span>
      ),
    },
    { colId: "amount", field: "amount", headerName: "Amount", type: "money", width: 140 },
    {
      colId: "balance", field: "balance", headerName: "Balance", type: "money", width: 140,
      cellRenderer: (p: { data?: Row; value: number }) => (
        <span className={p.data?.state === "late" ? "font-medium text-danger" : p.value === 0 ? "text-ink-tertiary" : ""}>
          {formatMoney(p.value)}
        </span>
      ),
    },
    {
      colId: "state", field: "state", headerName: "Status", width: 140,
      cellRenderer: (p: { data?: Row }) => p.data?.state && <InvoiceBadge state={p.data.state} />,
    },
  ], []);

  const totals = React.useMemo(() => ({
    number: "Total",
    amount: rows.reduce((a, r) => a + r.amount, 0),
    balance: rows.reduce((a, r) => a + r.balance, 0),
  }), [rows]);

  const header = (
    <PageHeader
      title="Invoices"
      actions={can("invoice:manage") && (
        <Button variant="primary" onClick={() => router.push("/invoices/new")}>
          <Plus className="size-4" />New invoice
        </Button>
      )}
    />
  );

  if (view === "recurring" || view === "retainers") {
    return (
      <>
        {header}
        <PageBody className="pt-4">
          <div className="mb-3">
            <ViewSelect view={view} set={set} counts={counts} />
          </div>
          {view === "recurring" ? <RecurringList /> : <RetainerList />}
        </PageBody>
      </>
    );
  }

  return (
    <>
      {header}
      <PageBody className="pt-4">
        <div className="mb-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <Kpi label="Outstanding" value={formatMoney(stats.outstanding)}>
            <div className="mt-2 text-base text-ink-secondary">{counts.outstanding} open invoices</div>
          </Kpi>
          <Kpi label="Overdue" value={formatMoney(stats.overdue)} danger={stats.overdue > 0}>
            <div className="mt-2 text-base text-ink-secondary">
              {stats.overdue > 0 ? "Past the due date" : "Nothing past due"}
            </div>
          </Kpi>
          <Kpi label="In draft" value={formatMoney(stats.draft)} muted={stats.draft === 0}>
            <div className="mt-2 text-base text-ink-secondary">{counts.draft} not yet sent</div>
          </Kpi>
          <Kpi label={`Paid in ${today.getFullYear()}`} value={formatMoney(stats.paidThisYear)} />
        </div>

        <DataGrid<Row>
          label="Invoices"
          tableId="invoices"
          rows={rows}
          columns={columns}
          loading={isLoading}
          totals={totals}
          height={620}
          selectable={can("invoice:manage")}
          onRowOpen={(r) => router.push(`/invoices/${r.id}`)}
          onExport={() => toast.push({ title: "Export queued. You will get an email when it is ready." })}
          filters={<ViewSelect view={view} set={set} counts={counts} />}
          bulkActions={[
            {
              key: "send", label: "Mark as sent", input: "immediate",
              run: async (sel) => {
                for (const r of sel as Row[]) await api.markInvoiceSent(r.id);
                toast.push({ tone: "success", title: `Marked ${sel.length} invoices as sent.` });
              },
            },
            {
              key: "remind", label: "Send reminder", input: "immediate",
              run: (sel) => { toast.push({ tone: "success", title: `Reminder emailed for ${sel.length} invoices.` }); },
            },
            {
              key: "delete", label: "Delete", intent: "danger", input: "modal", end: true,
              run: () => { toast.push({ tone: "danger", title: "Only draft invoices can be deleted. Sent invoices are written off." }); },
            },
          ]}
          empty={
            <EmptyState
              title={view === "draft" ? "No drafts." : view === "paid" ? "Nothing paid yet." : "Nothing outstanding."}
              action={can("invoice:manage") && <Button variant="primary" onClick={() => router.push("/invoices/new")}>New invoice</Button>}
            >
              {view === "outstanding"
                ? "Every invoice has been paid. Uninvoiced time is on the client pages."
                : "Try a different view."}
            </EmptyState>
          }
        />
      </PageBody>
    </>
  );
}

function ViewSelect({
  view, set, counts,
}: {
  view: View; set: (p: Record<string, string | null>) => void;
  counts: { outstanding: number; draft: number; paid: number; all: number };
}) {
  return (
    <Select
      value={view}
      onChange={(e) => set({ view: e.target.value === "outstanding" ? null : e.target.value })}
      className="w-[230px]"
      aria-label="Invoice view"
    >
      <option value="outstanding">Outstanding ({counts.outstanding})</option>
      <option value="draft">Drafts ({counts.draft})</option>
      <option value="paid">Paid and written off ({counts.paid})</option>
      <option value="all">All invoices ({counts.all})</option>
      <option value="recurring">Recurring schedules</option>
      <option value="retainers">Retainers</option>
    </Select>
  );
}

/* -------------------------------------------------------------- recurring */

const FREQUENCY_LABEL: Record<RecurringInvoice["frequency"], string> = {
  monthly: "Monthly", quarterly: "Quarterly", yearly: "Yearly",
};

function RecurringList() {
  const { clientById } = useApp();
  const { data: schedules = [] } = useQuery({ queryKey: ["recurring"], queryFn: api.listRecurringInvoices });
  const list = schedules as RecurringInvoice[];

  if (!list.length) {
    return <Card><EmptyState title="No recurring invoices.">A schedule issues the same invoice on a fixed cadence.</EmptyState></Card>;
  }

  return (
    <Card padded={false}>
      <div className="flex items-center border-b border-border bg-bg-muted px-4 py-2 text-xs font-semibold uppercase tracking-[0.04em] text-ink-tertiary">
        <span className="flex-1">Client and subject</span>
        <span className="w-32">Frequency</span>
        <span className="w-32">Next issue</span>
        <span className="w-32 text-right">Amount</span>
        <span className="w-28 pl-3">Status</span>
      </div>
      {list.map((r) => (
        <div key={r.id} className="flex items-center border-b border-border px-4 py-2.5 text-base last:border-b-0">
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium leading-tight text-ink">{clientById.get(r.clientId)?.name}</span>
            <span className="block truncate text-sm leading-tight text-ink-tertiary">{r.subject}</span>
          </span>
          <span className="w-32 text-ink-secondary">{FREQUENCY_LABEL[r.frequency]}</span>
          <span className="w-32 tabular-nums text-ink-secondary">{r.nextIssueOn ? formatDateUS(r.nextIssueOn) : "Not scheduled"}</span>
          <span className="w-32 text-right font-medium tabular-nums">{formatMoney(r.amountCents)}</span>
          <span className="w-28 pl-3">
            <Badge variant={r.state === "active" ? "success" : r.state === "paused" ? "warning" : "neutral"} dot={r.state !== "completed"}>
              {r.state === "active" ? "Active" : r.state === "paused" ? "Paused" : "Completed"}
            </Badge>
          </span>
        </div>
      ))}
    </Card>
  );
}

/* -------------------------------------------------------------- retainers */

function RetainerList() {
  const { clientById, projectById } = useApp();
  const { data: retainers = [] } = useQuery({ queryKey: ["retainers"], queryFn: api.listRetainers });
  const list = retainers as Retainer[];

  if (!list.length) {
    return <Card><EmptyState title="No retainers.">A retainer holds a balance that invoices draw down.</EmptyState></Card>;
  }

  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {list.map((r) => {
        const added = r.transactions.filter((t) => t.kind === "add").reduce((a, t) => a + t.amountCents, 0);
        const drawn = r.transactions.filter((t) => t.kind === "draw").reduce((a, t) => a + t.amountCents, 0);
        const pct = added ? Math.max(0, Math.min(1, r.balanceCents / added)) : 0;
        return (
          <Card key={r.id} className="flex flex-col gap-2">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <Link href={`/clients/${r.clientId}`} className="block truncate font-medium text-ink hover:underline">
                  {clientById.get(r.clientId)?.name}
                </Link>
                <div className="truncate text-sm text-ink-tertiary">
                  {r.projectId ? projectById.get(r.projectId)?.name : "All projects"}
                </div>
              </div>
              <Badge variant={r.balanceCents > 0 ? "success" : "warning"}>
                {r.balanceCents > 0 ? "In credit" : "Exhausted"}
              </Badge>
            </div>

            <div className="text-3xl font-semibold tracking-(--ls-tighter) text-ink">{formatMoney(r.balanceCents)}</div>

            <div className="h-2 overflow-hidden rounded-full bg-bg-strong">
              <div className="h-full rounded-full bg-accent" style={{ width: `${pct * 100}%` }} />
            </div>

            <div className="flex items-center justify-between text-sm text-ink-secondary">
              <span>{formatMoney(added)} added</span>
              <span>{formatMoney(drawn)} drawn</span>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
