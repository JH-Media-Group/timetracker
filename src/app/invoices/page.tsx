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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColDef } from "ag-grid-community";
import { Plus } from "lucide-react";
import * as api from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatDateUS, formatDueIn, formatMoney } from "@/lib/format";
import type { Invoice, InvoiceState, RecurringInvoice, Retainer } from "@/lib/types";
import {
  Badge, Button, Card, Dialog, DialogContent, EmptyState, Field, Input, Select, Spinner, Tabs,
} from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { PageBody, PageHeader, useUrlState } from "@/components/app/page-chrome";
import { DataGrid } from "@/components/app/data-grid";
import { InvoiceBadge, Kpi } from "@/components/app/kpi";
import { useApp, useCan } from "@/components/app/providers";
import type { GridRow } from "@/components/ui/grid";

/**
 * A destination and a filter, which used to be one control.
 *
 * `?view=` carried both "which screen" (recurring, retainers) and "which subset
 * of one list" (outstanding, draft, paid, all) in a single dropdown, so opening
 * the Retainers screen and narrowing the invoice list were the same gesture.
 * They are now a tab and a filter, decided in TALLY-35 and written up in
 * FRONTEND_PRD section 12.
 */
type Tab = "overview" | "recurring" | "retainers" | "uninvoiced";
type StatusFilter = "outstanding" | "draft" | "paid" | "all";

const TABS: Tab[] = ["overview", "recurring", "retainers", "uninvoiced"];
const STATUSES: StatusFilter[] = ["outstanding", "draft", "paid", "all"];

const isTab = (v: string): v is Tab => (TABS as string[]).includes(v);
const isStatus = (v: string): v is StatusFilter => (STATUSES as string[]).includes(v);

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
  const qc = useQueryClient();

  /**
   * Old links still work.
   *
   * `?view=draft` used to mean the drafts subset. It now resolves to the
   * overview tab with the drafts filter, rather than 404ing a bookmark or
   * silently showing the wrong screen.
   */
  const rawView = params.get("view") ?? "";
  const tab: Tab = isTab(rawView) ? rawView : "overview";
  const status: StatusFilter =
    isStatus(params.get("status") ?? "") ? (params.get("status") as StatusFilter)
    : isStatus(rawView) ? rawView
    : "outstanding";

  const { data: invoices = [], isLoading } = useQuery({ queryKey: ["invoices"], queryFn: api.listInvoices });
  const refreshInvoices = () => qc.invalidateQueries({ queryKey: ["invoices"] });
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
      status === "draft" ? i.state === "draft"
      : status === "paid" ? i.state === "paid" || i.state === "written_off"
      : status === "all" ? true
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
  }, [all, status, clientById, today]);

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

  /**
   * The tab strip, on every destination.
   *
   * All five now exist. Configure navigates away rather than rendering in
   * place: it is a two-pane screen of its own with seven sections, and nesting
   * it under a tab strip would put two navigations on top of each other.
   */
  const tabs = (
    <Tabs
      value={tab}
      onValueChange={(v) => {
        if (v === "configure") return router.push("/invoices/configure");
        set({ view: v === "overview" ? null : v, status: null });
      }}
      tabs={[
        { value: "overview", label: "Overview", count: counts.all },
        { value: "recurring", label: "Recurring" },
        { value: "retainers", label: "Retainers" },
        { value: "uninvoiced", label: "Uninvoiced" },
        { value: "configure", label: "Configure" },
      ]}
      className="mb-4"
    />
  );

  if (tab !== "overview") {
    return (
      <>
        {header}
        <PageBody className="pt-4">
          {tabs}
          {tab === "recurring" && <RecurringList />}
          {tab === "retainers" && <RetainerList />}
          {tab === "uninvoiced" && <UninvoicedList />}
        </PageBody>
      </>
    );
  }

  return (
    <>
      {header}
      <PageBody className="pt-4">
        {tabs}
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
          filters={<StatusFilterSelect status={status} set={set} counts={counts} />}
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
              run: async (sel) => {
                let recorded = 0;
                let skipped = 0;
                for (const r of sel as Row[]) {
                  const detail = await api.getInvoice(r.id);
                  const contacts = detail ? clientById.get(detail.clientId)?.contacts ?? [] : [];
                  const to = contacts.find((c) => c.isPrimary)?.email ?? contacts.find((c) => c.email)?.email;
                  if (!to) { skipped++; continue; }
                  await api.sendReminder(r.id, [to]);
                  recorded++;
                }
                refreshInvoices();
                toast.push({
                  title: `${recorded} ${recorded === 1 ? "reminder" : "reminders"} recorded on the timeline`
                    + (skipped ? `, ${skipped} skipped for having no contact email` : "")
                    + ". No email was sent: mail delivery is not configured yet.",
                });
              },
            },
            {
              key: "delete", label: "Delete", intent: "danger", input: "modal", end: true,
              run: async (sel) => {
                // Only a draft can be deleted; anything sent is written off, so
                // the ledger keeps the number. Say which happened to which.
                const rows = sel as Row[];
                const drafts = rows.filter((r) => r.state === "draft");
                for (const r of drafts) await api.deleteInvoice(r.id);
                refreshInvoices();
                toast.push({
                  tone: "danger",
                  title: drafts.length === rows.length
                    ? `Deleted ${drafts.length} ${drafts.length === 1 ? "draft" : "drafts"}.`
                    : `Deleted ${drafts.length} of ${rows.length}. The rest have been sent, so write them off instead.`,
                });
              },
            },
          ]}
          empty={
            <EmptyState
              title={status === "draft" ? "No drafts." : status === "paid" ? "Nothing paid yet." : "Nothing outstanding."}
              action={can("invoice:manage") && <Button variant="primary" onClick={() => router.push("/invoices/new")}>New invoice</Button>}
            >
              {status === "outstanding"
                ? "Every invoice has been paid. The Uninvoiced tab has what has not been billed yet."
                : "Try a different filter."}
            </EmptyState>
          }
        />
      </PageBody>
    </>
  );
}

/**
 * Which subset of the invoice list, not which screen.
 *
 * This used to be both. Recurring schedules and retainers sat in the same
 * dropdown as the status filters, so they read as two more ways of looking at
 * the invoice table rather than as separate things, and there was no way to
 * tell from the control that picking one changed the page entirely.
 */
function StatusFilterSelect({
  status, set, counts,
}: {
  status: StatusFilter; set: (p: Record<string, string | null>) => void;
  counts: { outstanding: number; draft: number; paid: number; all: number };
}) {
  return (
    <Select
      value={status}
      onChange={(e) => set({ status: e.target.value === "outstanding" ? null : e.target.value })}
      className="w-[230px]"
      aria-label="Filter invoices by status"
    >
      <option value="outstanding">Outstanding ({counts.outstanding})</option>
      <option value="draft">Drafts ({counts.draft})</option>
      <option value="paid">Paid and written off ({counts.paid})</option>
      <option value="all">All invoices ({counts.all})</option>
    </Select>
  );
}

/* -------------------------------------------------------------- recurring */

const FREQUENCY_LABEL: Record<RecurringInvoice["frequency"], string> = {
  weekly: "Weekly", monthly: "Monthly", quarterly: "Quarterly", yearly: "Yearly",
};

function RecurringList() {
  const router = useRouter();
  const toast = useToast();
  const qc = useQueryClient();
  const can = useCan();
  const { clientById } = useApp();
  const { data: schedules = [] } = useQuery({ queryKey: ["recurring"], queryFn: api.listRecurringInvoices });
  const list = schedules as RecurringInvoice[];
  const manage = can("invoice:manage");

  const refresh = () => qc.invalidateQueries({ queryKey: ["recurring"] });

  const toggle = useMutation({
    mutationFn: ({ id, state }: { id: string; state: "active" | "paused" }) =>
      api.setRecurringInvoiceState(id, state),
    onSuccess: (r) => {
      toast.push({ tone: "success", title: r.state === "paused" ? "Schedule paused." : "Schedule resumed." });
      refresh();
    },
    onError: (e: unknown) => toast.push({ tone: "danger", title: e instanceof Error ? e.message : "Could not change the schedule." }),
  });

  /**
   * Raising one by hand, which is what makes the schedule usable before the
   * daily job in TALLY-26 exists. It advances the schedule in the same
   * transaction, so pressing it twice does not bill the same period twice.
   */
  const issue = useMutation({
    mutationFn: (id: string) => api.issueRecurringInvoice(id),
    onSuccess: ({ invoiceId }) => {
      toast.push({ tone: "success", title: "Invoice raised from the schedule." });
      refresh();
      qc.invalidateQueries({ queryKey: ["invoices"] });
      router.push(`/invoices/${invoiceId}`);
    },
    onError: (e: unknown) => toast.push({ tone: "danger", title: e instanceof Error ? e.message : "Could not raise the invoice." }),
  });

  const newButton = manage && (
    <Button variant="primary" onClick={() => router.push("/invoices/recurring/new")}>
      <Plus className="size-4" />New recurring invoice
    </Button>
  );

  if (!list.length) {
    return (
      <Card>
        <EmptyState title="No recurring invoices." action={newButton}>
          A schedule issues the same invoice on a fixed cadence.
        </EmptyState>
      </Card>
    );
  }

  return (
    <>
      {manage && <div className="mb-3 flex justify-end">{newButton}</div>}
      <Card padded={false}>
        <div className="flex items-center border-b border-border bg-bg-muted px-4 py-2 text-xs font-semibold uppercase tracking-[0.04em] text-ink-tertiary">
          <span className="flex-1">Client and subject</span>
          <span className="w-32">Frequency</span>
          <span className="w-32">Next issue</span>
          <span className="w-32 text-right">Amount</span>
          <span className="w-28 pl-3">Status</span>
          {manage && <span className="w-[210px] pl-3 text-right">Actions</span>}
        </div>
        {list.map((r) => (
          <div key={r.id} className="flex items-center border-b border-border px-4 py-2.5 text-base last:border-b-0">
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium leading-tight text-ink">{clientById.get(r.clientId)?.name}</span>
              <span className="block truncate text-sm leading-tight text-ink-tertiary">{r.subject}</span>
            </span>
            <span className="w-32 text-ink-secondary">
              {FREQUENCY_LABEL[r.frequency]}
              {r.interval > 1 && <span className="text-ink-tertiary"> ×{r.interval}</span>}
            </span>
            <span className="w-32 tabular-nums text-ink-secondary">
              {r.state === "paused" ? "Paused" : r.nextIssueOn ? formatDateUS(r.nextIssueOn) : "Not scheduled"}
            </span>
            <span className="w-32 text-right font-medium tabular-nums">{formatMoney(r.amountCents)}</span>
            <span className="w-28 pl-3">
              <Badge variant={r.state === "active" ? "success" : r.state === "paused" ? "warning" : "neutral"} dot={r.state !== "completed"}>
                {r.state === "active" ? "Active" : r.state === "paused" ? "Paused" : "Completed"}
              </Badge>
            </span>
            {manage && (
              <span className="flex w-[210px] items-center justify-end gap-1 pl-3">
                {r.state !== "completed" && (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={issue.isPending && issue.variables === r.id}
                      disabled={r.state === "paused" || !r.nextIssueOn}
                      onClick={() => issue.mutate(r.id)}
                    >
                      Issue now
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => toggle.mutate({ id: r.id, state: r.state === "active" ? "paused" : "active" })}
                    >
                      {r.state === "active" ? "Pause" : "Resume"}
                    </Button>
                  </>
                )}
                <Button variant="ghost" size="sm" onClick={() => router.push(`/invoices/recurring/${r.id}`)}>
                  Edit
                </Button>
              </span>
            )}
          </div>
        ))}
      </Card>
    </>
  );
}

/* -------------------------------------------------------------- retainers */

/**
 * Retainers, and the two things you do with one: open it and put money in.
 *
 * The ledger was built and tested before any of this existed, so every retainer
 * in the system was there because the seed wrote it. Nothing here computes a
 * balance: the server moves it under a row lock and sends back the result,
 * because a balance the browser worked out is a balance that can disagree with
 * the ledger behind it.
 */
function RetainerList() {
  const { clientById, projectById } = useApp();
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const [opening, setOpening] = React.useState(false);
  const [funding, setFunding] = React.useState<Retainer | null>(null);

  const { data: retainers = [] } = useQuery({ queryKey: ["retainers"], queryFn: api.listRetainers });
  const list = retainers as Retainer[];
  const manage = can("invoice:manage");

  const refresh = () => qc.invalidateQueries({ queryKey: ["retainers"] });

  const newButton = manage && (
    <Button variant="primary" onClick={() => setOpening(true)}>
      <Plus className="size-4" />New retainer
    </Button>
  );

  const dialogs = (
    <>
      {opening && (
        <RetainerDialog
          title="New retainer"
          submitLabel="Open retainer"
          onClose={() => setOpening(false)}
          onDone={refresh}
        />
      )}
      {funding && (
        <RetainerDialog
          title={`Add funds: ${clientById.get(funding.clientId)?.name ?? "retainer"}`}
          submitLabel="Add funds"
          retainer={funding}
          onClose={() => setFunding(null)}
          onDone={refresh}
        />
      )}
    </>
  );

  if (!list.length) {
    return (
      <>
        <Card>
          <EmptyState title="No retainers." action={newButton}>
            A retainer holds a balance that invoices draw down.
          </EmptyState>
        </Card>
        {dialogs}
      </>
    );
  }

  return (
    <>
      {manage && <div className="mb-3 flex justify-end">{newButton}</div>}
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

              {manage && (
                <div className="mt-1 flex justify-end">
                  <Button size="sm" variant="secondary" onClick={() => setFunding(r)}>
                    Add funds
                  </Button>
                </div>
              )}
            </Card>
          );
        })}
      </div>
      {dialogs}
    </>
  );
}

/**
 * Opening a retainer and funding one are the same form.
 *
 * Both take an amount and a note; opening also takes a client. Keeping them one
 * component means the money field, its parsing and its validation exist once,
 * and cents never get divided by a hundred in two slightly different places.
 */
function RetainerDialog({
  title,
  submitLabel,
  retainer,
  onClose,
  onDone,
}: {
  title: string;
  submitLabel: string;
  retainer?: Retainer;
  onClose: () => void;
  onDone: () => void;
}) {
  const { clients } = useApp();
  const toast = useToast();
  const [clientId, setClientId] = React.useState("");
  const [amount, setAmount] = React.useState("");
  const [note, setNote] = React.useState("");

  const cents = Math.round((Number(amount) || 0) * 100);

  const submit = useMutation({
    mutationFn: () =>
      retainer
        ? api.addRetainerFunds(retainer.id, { amountCents: cents, note: note.trim() || null })
        : api.createRetainer({ clientId, openingCents: cents, note: note.trim() || null }),
    onSuccess: () => {
      toast.push({ tone: "success", title: retainer ? "Funds added." : "Retainer opened." });
      onDone();
      onClose();
    },
    onError: (e: unknown) =>
      toast.push({
        tone: "danger",
        title: e instanceof Error ? e.message : "That did not work.",
      }),
  });

  const canSubmit = retainer ? cents > 0 : clientId !== "" && cents >= 0;

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        title={title}
        footer={
          <>
            <Button variant="ghost" type="button" onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!canSubmit}
              loading={submit.isPending}
              onClick={() => canSubmit && submit.mutate()}
            >
              {submitLabel}
            </Button>
          </>
        }
      >
      <div className="flex flex-col gap-4">
        {!retainer && (
          <Field label="Client" required>
            <Select value={clientId} onChange={(e) => setClientId(e.target.value)}>
              <option value="">Choose a client</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </Select>
          </Field>
        )}

        <Field
          label={retainer ? "Amount to add" : "Opening amount"}
          required={!!retainer}
          help={retainer ? undefined : "Leave at zero to open an empty retainer and fund it later."}
        >
          <Input
            inputMode="decimal"
            value={amount}
            placeholder="0.00"
            onChange={(e) => setAmount(e.target.value)}
          />
        </Field>

        <Field label="Note" help="What this payment was, for the ledger.">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Q3 retainer" />
        </Field>

      </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * What has been done and not billed, by client.
 *
 * The screen somebody opens at the start of a billing run. Until TALLY-34 the
 * figure was computed in three places and browsable in none, and this list's own
 * empty state used to send people to the client pages one at a time.
 *
 * Every number here comes from the server and none of it is recomputed in the
 * browser. The total on a row is the total the invoice will come to, and the
 * only way to keep that true is to have one place do the arithmetic:
 * `tests/uninvoiced.test.ts` asserts the row equals what the preview then
 * offers, to the cent.
 */
function UninvoicedList() {
  const router = useRouter();
  const can = useCan();
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["uninvoiced-clients"],
    queryFn: api.listUninvoicedClients,
  });

  const total = rows.reduce((sum, r) => sum + r.totalCents, 0);
  const manage = can("invoice:manage");

  if (isLoading) {
    return (
      <Card>
        <div className="flex items-center gap-2 py-6 text-base text-ink-secondary">
          <Spinner className="size-4" />
          Working out what has not been billed…
        </div>
      </Card>
    );
  }

  if (!rows.length) {
    return (
      <Card>
        <EmptyState title="Everything billable has been invoiced.">
          Billable time and expenses appear here as soon as they are logged.
        </EmptyState>
      </Card>
    );
  }

  return (
    <Card padded={false}>
      <div className="flex items-center border-b border-border bg-bg-muted px-4 py-2 text-xs font-semibold uppercase tracking-[0.04em] text-ink-tertiary">
        <span className="flex-1">Client</span>
        <span className="w-40">Period</span>
        <span className="w-24 text-right">Hours</span>
        <span className="w-32 text-right">Time</span>
        <span className="w-32 text-right">Expenses</span>
        <span className="w-32 text-right">Total</span>
        {manage && <span className="w-[150px] pl-3 text-right">Actions</span>}
      </div>

      {rows.map((r) => (
        <div
          key={r.clientId}
          className="flex items-center border-b border-border px-4 py-2.5 text-base last:border-b-0"
        >
          <span className="min-w-0 flex-1">
            <Link
              href={`/clients/${r.clientId}`}
              className="block truncate font-medium leading-tight text-ink hover:underline"
            >
              {r.clientName}
            </Link>
          </span>
          <span className="w-40 text-sm tabular-nums text-ink-tertiary">
            {r.from && r.to
              ? r.from === r.to
                ? formatDateUS(r.from)
                : `${formatDateUS(r.from)} to ${formatDateUS(r.to)}`
              : "—"}
          </span>
          <span className="w-24 text-right tabular-nums text-ink-secondary">
            {r.hours ? r.hours.toFixed(2) : "—"}
          </span>
          <span className="w-32 text-right tabular-nums text-ink-secondary">
            {r.timeCents ? formatMoney(r.timeCents, r.currency) : "—"}
          </span>
          <span className="w-32 text-right tabular-nums text-ink-secondary">
            {r.expenseCents ? formatMoney(r.expenseCents, r.currency) : "—"}
          </span>
          <span className="w-32 text-right font-semibold tabular-nums text-ink">
            {formatMoney(r.totalCents, r.currency)}
          </span>
          {manage && (
            <span className="w-[150px] pl-3 text-right">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => router.push(`/invoices/new?client=${r.clientId}`)}
              >
                Create invoice
              </Button>
            </span>
          )}
        </div>
      ))}

      <div className="flex items-center bg-bg-muted px-4 py-2.5 text-base font-semibold">
        <span className="flex-1 text-ink-secondary">
          {rows.length} client{rows.length === 1 ? "" : "s"} with unbilled work
        </span>
        <span className="w-32 text-right tabular-nums text-ink">{formatMoney(total)}</span>
        {manage && <span className="w-[150px]" />}
      </div>
    </Card>
  );
}
