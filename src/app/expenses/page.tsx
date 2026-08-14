"use client";

/**
 * Expenses.
 *
 * Three views over one table: everything, just what is owed back to people, and
 * the category library. Adding an expense is a dialog because a receipt upload
 * does not fit an inline row, and because most people add one at a time.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColDef } from "ag-grid-community";
import { Paperclip, Plus, Trash2 } from "lucide-react";
import * as api from "@/lib/api";
import { formatDateUS, formatMoney, isoDate, parseMoney } from "@/lib/format";
import type { Expense } from "@/lib/types";
import {
  Avatar, Badge, Button, Card, Checkbox, Dialog, DialogContent, Dropzone, EmptyState,
  Field, Input, Segmented, Select, Textarea, Affix, Tray,
} from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { PageBody, PageHeader, PeriodPicker, usePeriod, useUrlState } from "@/components/app/page-chrome";
import { DataGrid } from "@/components/app/data-grid";
import { Kpi } from "@/components/app/kpi";
import { ProjectPicker } from "@/components/app/project-picker";
import { useApp, useCan } from "@/components/app/providers";
import type { GridRow } from "@/components/ui/grid";

type View = "all" | "reimbursements" | "categories";

interface Row {
  _id: string; _kind: "data";
  id: string; spentOn: string; userId: string;
  firstName: string; lastName: string; photo?: string; person: string;
  project: string; client: string; category: string;
  notes: string; units?: number; amount: number;
  billable: boolean; reimbursable: boolean; state?: string;
  receipt?: string; invoiced: boolean;
}

export default function ExpensesPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { params, set } = useUrlState();
  /** The expense open in the tray (TALLY-43). A row used to be a dead end. */
  const [openId, setOpenId] = React.useState<string | null>(null);
  const { me, userById, projectById, clientById, categoryById, expenseCategories } = useApp();
  const can = useCan();
  const { granularity, anchor, period, onChange } = usePeriod("month", ["week", "month", "quarter", "year", "all"]);

  const view = (params.get("view") as View) || "all";
  const scope = params.get("scope") || (can("report:view_financial") || can("expense:manage") ? "everyone" : "mine");
  const [creating, setCreating] = React.useState(false);

  const { data: expenses = [], isLoading } = useQuery({
    queryKey: ["expenses", period.from, period.to],
    queryFn: () => api.listExpenses({ from: period.from, to: period.to }),
  });

  const scoped = React.useMemo(() => {
    let list = expenses as Expense[];
    if (scope === "mine") list = list.filter((e) => e.userId === me.id);
    if (view === "reimbursements") list = list.filter((e) => e.isReimbursable);
    return list;
  }, [expenses, scope, view, me.id]);

  const stats = React.useMemo(() => {
    const total = scoped.reduce((a, e) => a + e.totalCents, 0);
    const billable = scoped.filter((e) => e.isBillable).reduce((a, e) => a + e.totalCents, 0);
    const owed = scoped
      .filter((e) => e.isReimbursable && e.reimbursementState !== "paid")
      .reduce((a, e) => a + e.totalCents, 0);
    const uninvoiced = scoped
      .filter((e) => e.isBillable && !e.invoiceId)
      .reduce((a, e) => a + e.totalCents, 0);
    return { total, billable, owed, uninvoiced };
  }, [scoped]);

  const rows = React.useMemo<GridRow<Row>[]>(() =>
    [...scoped]
      .sort((a, b) => b.spentOn.localeCompare(a.spentOn))
      .map((e) => {
        const u = userById.get(e.userId);
        const p = projectById.get(e.projectId);
        return {
          _id: e.id, _kind: "data" as const, id: e.id, spentOn: e.spentOn, userId: e.userId,
          firstName: u?.firstName ?? "?", lastName: u?.lastName ?? "", photo: u?.photo,
          person: u ? `${u.firstName} ${u.lastName}` : "Unknown",
          project: p?.name ?? "Unknown project",
          client: p ? clientById.get(p.clientId)?.name ?? "" : "",
          category: categoryById.get(e.categoryId)?.name ?? "Uncategorised",
          notes: e.notes ?? "", units: e.units, amount: e.totalCents,
          billable: e.isBillable, reimbursable: e.isReimbursable,
          state: e.reimbursementState, receipt: e.receiptName, invoiced: !!e.invoiceId,
        };
      }),
  [scoped, userById, projectById, clientById, categoryById]);

  const columns = React.useMemo<ColDef[]>(() => [
    { colId: "spentOn", field: "spentOn", headerName: "Date", type: "date", width: 120 },
    {
      colId: "person", field: "person", headerName: "Person", width: 190,
      cellRenderer: (p: { data?: Row }) => p.data && (
        <span className="flex min-w-0 items-center gap-2">
          <Avatar user={p.data} size="xs" />
          <span className="truncate">{p.data.person}</span>
        </span>
      ),
    },
    {
      colId: "project", field: "project", headerName: "Project", flex: 1, minWidth: 200,
      cellRenderer: (p: { data?: Row }) => p.data && (
        <span className="flex min-w-0 flex-col justify-center leading-tight">
          <span className="truncate text-ink">{p.data.project}</span>
          <span className="truncate text-sm text-ink-tertiary">{p.data.client}</span>
        </span>
      ),
    },
    { colId: "category", field: "category", headerName: "Category", width: 170 },
    { colId: "notes", field: "notes", headerName: "Notes", flex: 1, minWidth: 180 },
    { colId: "units", field: "units", headerName: "Units", type: "numeric", width: 90 },
    { colId: "amount", field: "amount", headerName: "Amount", type: "money", width: 130 },
    {
      colId: "billable", headerName: "Billable", width: 120, sortable: true,
      valueGetter: (p: { data?: Row }) => !!p.data?.billable,
      cellRenderer: (p: { data?: Row }) => p.data && (
        p.data.billable
          ? <Badge variant={p.data.invoiced ? "success" : "info"}>{p.data.invoiced ? "Invoiced" : "Billable"}</Badge>
          : <span className="text-ink-tertiary">No</span>
      ),
    },
    {
      colId: "state", headerName: "Reimbursement", width: 160, sortable: true,
      valueGetter: (p: { data?: Row }) => (p.data?.reimbursable ? p.data.state ?? "pending" : ""),
      cellRenderer: (p: { data?: Row }) => {
        if (!p.data?.reimbursable) return <span className="text-ink-tertiary">Not reimbursable</span>;
        const s = p.data.state ?? "pending";
        return <Badge variant={s === "paid" ? "success" : s === "approved" ? "info" : "warning"} dot>
          {s === "paid" ? "Paid" : s === "approved" ? "Approved" : "Pending"}
        </Badge>;
      },
    },
    {
      colId: "receipt", headerName: "Receipt", width: 100, sortable: false,
      valueGetter: (p: { data?: Row }) => p.data?.receipt ?? "",
      cellRenderer: (p: { data?: Row }) =>
        p.data?.receipt
          ? <span className="flex items-center gap-1 text-ink-secondary"><Paperclip className="size-3.5" aria-hidden />1</span>
          : <span className="text-ink-tertiary">None</span>,
    },
  ], []);

  const totals = React.useMemo(() => ({
    spentOn: "Total", amount: rows.reduce((a, r) => a + r.amount, 0),
  }), [rows]);

  if (view === "categories") {
    return (
      <>
        <ExpenseHeader view={view} set={set} onNew={() => setCreating(true)} canManage={can("expense:manage")} />
        <PageBody className="pt-4">
          <CategoryList expenses={expenses as Expense[]} />
        </PageBody>
        <ExpenseDialog open={creating} onOpenChange={setCreating} />
      </>
    );
  }

  return (
    <>
      <ExpenseHeader view={view} set={set} onNew={() => setCreating(true)} canManage={can("expense:manage")} />

      <PageBody className="pt-4">
        <div className="mb-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <Kpi label={`Total in ${period.label}`} value={formatMoney(stats.total)} />
          <Kpi label="Billable" value={formatMoney(stats.billable)} />
          <Kpi label="Not yet invoiced" value={formatMoney(stats.uninvoiced)} />
          <Kpi label="Owed to people" value={formatMoney(stats.owed)} danger={stats.owed > 0} />
        </div>

        <div className="mb-3 flex flex-wrap items-center gap-3">
          <PeriodPicker granularity={granularity} anchor={anchor} onChange={onChange} allowed={["week", "month", "quarter", "year", "all"]} />
          <Segmented
            value={scope}
            onChange={(v) => set({ scope: v })}
            options={[{ value: "mine", label: "Mine" }, { value: "everyone", label: "Everyone" }]}
            aria-label="Expense scope"
          />
        </div>

        <DataGrid<Row>
          label="Expenses"
          tableId="expenses"
          rows={rows}
          columns={columns}
          loading={isLoading}
          totals={totals}
          height={600}
          selectable={can("expense:manage")}
          onRowOpen={(r) => setOpenId((cur) => (cur === r.id ? null : r.id))}
          filters={
            <Select
              value={view}
              onChange={(e) => set({ view: e.target.value === "all" ? null : e.target.value })}
              className="w-[210px]"
              aria-label="Expense view"
            >
              <option value="all">All expenses</option>
              <option value="reimbursements">Reimbursements</option>
              <option value="categories">Categories</option>
            </Select>
          }
          bulkActions={[
            {
              key: "billable", label: "Mark billable", input: "immediate",
              run: async (sel) => {
                for (const r of sel as Row[]) await api.updateExpense(r.id, { isBillable: true });
                qc.invalidateQueries({ queryKey: ["expenses"] });
                toast.push({ tone: "success", title: `Marked ${sel.length} expenses billable.` });
              },
            },
            {
              key: "category", label: "Change category", input: "inline",
              inlineLabel: "Category", inlinePlaceholder: "Meals",
              run: async (sel, value) => {
                const match = expenseCategories.find((c) => c.name.toLowerCase() === (value ?? "").trim().toLowerCase());
                if (!match) { toast.push({ tone: "danger", title: `No category named "${value}".` }); return; }
                for (const r of sel as Row[]) await api.updateExpense(r.id, { categoryId: match.id });
                qc.invalidateQueries({ queryKey: ["expenses"] });
                toast.push({ tone: "success", title: `Moved ${sel.length} expenses to ${match.name}.` });
              },
            },
            {
              key: "paid", label: "Mark reimbursed", input: "immediate",
              run: async (sel) => {
                for (const r of sel as Row[]) await api.updateExpense(r.id, { reimbursementState: "paid" });
                qc.invalidateQueries({ queryKey: ["expenses"] });
                toast.push({ tone: "success", title: `Marked ${sel.length} reimbursements paid.` });
              },
            },
            {
              key: "delete", label: "Delete", intent: "danger", input: "immediate", end: true,
              run: async (sel) => {
                const ids = (sel as Row[]).map((r) => r.id);
                for (const id of ids) await api.deleteExpense(id);
                qc.invalidateQueries({ queryKey: ["expenses"] });
                toast.push({ tone: "danger", title: `Deleted ${ids.length} ${ids.length === 1 ? "expense" : "expenses"}.` });
              },
            },
          ]}
          empty={
            <EmptyState
              title={view === "reimbursements" ? "Nothing to reimburse." : "No expenses in this period."}
              action={<Button variant="primary" onClick={() => setCreating(true)}>New expense</Button>}
            >
              {view === "reimbursements"
                ? "Expenses marked reimbursable show up here until they are paid."
                : "Receipts, mileage, and anything else you pay for on a client's behalf."}
            </EmptyState>
          }
        />
      </PageBody>

      <ExpenseDialog open={creating} onOpenChange={setCreating} />
      <ExpenseTray
        expense={(expenses as Expense[] | undefined)?.find((e) => e.id === openId) ?? null}
        onClose={() => setOpenId(null)}
      />
    </>
  );
}

/**
 * One expense, opened from its row (TALLY-43).
 *
 * A row used to go nowhere, so the receipt column could say a receipt existed
 * and there was no way to look at it. The same tray Approvals uses, because two
 * screens inventing two ways to open a record is how they drift.
 *
 * Everything already stored is shown. **The receipt is the one thing that is
 * not**, because receipts need object storage (TALLY-21) and there is nothing
 * behind the indicator yet. It says so, rather than offering a link to nothing.
 */
function ExpenseTray({ expense, onClose }: { expense: Expense | null; onClose: () => void }) {
  const { projectById, clientById, categoryById, userById } = useApp();
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();

  const project = expense ? projectById.get(expense.projectId) : undefined;
  const client = project ? clientById.get(project.clientId) : undefined;
  const category = expense ? categoryById.get(expense.categoryId) : undefined;
  const person = expense ? userById.get(expense.userId) : undefined;

  /**
   * An expense on a sent invoice is locked, exactly as a time entry is: the
   * client has the document, so the number behind it cannot move.
   */
  const locked = !!expense?.invoiceId;
  const editable = can("expense:manage") && !locked;

  const patch = useMutation({
    mutationFn: (p: Parameters<typeof api.updateExpense>[1]) => api.updateExpense(expense!.id, p),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["expenses"] });
      toast.push({ tone: "success", title: "Expense updated." });
    },
    onError: (e: unknown) =>
      toast.push({ tone: "danger", title: e instanceof Error ? e.message : "Could not update it." }),
  });

  const remove = useMutation({
    mutationFn: () => api.deleteExpense(expense!.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["expenses"] });
      toast.push({ tone: "danger", title: "Expense deleted." });
      onClose();
    },
  });

  if (!expense) return <Tray open={false} onOpenChange={onClose} title="">{null}</Tray>;

  const rows: [string, React.ReactNode][] = [
    ["Project", project?.name ?? "Unknown project"],
    ["Client", client?.name ?? "Unknown client"],
    ["Category", category?.name ?? "Uncategorised"],
    ["Date", formatDateUS(expense.spentOn)],
    ["Person", person ? `${person.firstName} ${person.lastName}` : "Unknown"],
    ["Amount", <span key="a" className="tabular-nums font-medium text-ink">{formatMoney(expense.totalCents)}</span>],
    ...(expense.units != null ? ([["Units", String(expense.units)]] as [string, React.ReactNode][]) : []),
  ];

  return (
    <Tray
      open
      onOpenChange={(v) => !v && onClose()}
      title={formatMoney(expense.totalCents)}
      subtitle={`${project?.name ?? "Unknown project"} · ${formatDateUS(expense.spentOn)}`}
      footer={
        editable ? (
          <Button variant="ghost" loading={remove.isPending} onClick={() => remove.mutate()}>
            <Trash2 className="size-4" />Delete
          </Button>
        ) : (
          <span className="text-base text-ink-tertiary">
            {locked ? "On a sent invoice, so it cannot be changed." : "You can see this expense but not change it."}
          </span>
        )
      }
    >
      <div className="flex flex-col gap-5 p-5">
        <dl className="grid grid-cols-[130px_1fr] gap-y-2.5 text-base">
          {rows.map(([label, value]) => (
            <React.Fragment key={label}>
              <dt className="text-ink-tertiary">{label}</dt>
              <dd className="min-w-0 text-ink">{value}</dd>
            </React.Fragment>
          ))}
        </dl>

        {expense.notes && (
          <div>
            <div className="mb-1 text-sm font-medium text-ink-secondary">Notes</div>
            <p className="whitespace-pre-line text-base text-ink">{expense.notes}</p>
          </div>
        )}

        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-base text-ink">
            <Checkbox
              checked={expense.isBillable}
              disabled={!editable || patch.isPending}
              onCheckedChange={(v) => patch.mutate({ isBillable: v })}
            />
            Bill this back to the client
          </label>
          <label className="flex items-center gap-2 text-base text-ink">
            <Checkbox
              checked={expense.isReimbursable}
              disabled={!editable || patch.isPending}
              onCheckedChange={(v) => patch.mutate({ isReimbursable: v })}
            />
            Reimburse the person for this
          </label>
        </div>

        {/*
          Said plainly. The grid shows a receipt indicator, and until object
          storage exists (TALLY-21) there is nothing behind it. A disabled
          "View receipt" button would imply the file is there and merely
          unavailable, which is a different and untrue claim.
        */}
        <div className="rounded-md border border-border bg-bg-muted px-4 py-3">
          <div className="text-base font-medium text-ink">Receipt</div>
          <p className="mt-0.5 text-base text-ink-secondary">
            {expense.receiptName
              ? `"${expense.receiptName}" was recorded against this expense. Receipts cannot be shown yet: they need file storage, which is not configured.`
              : "No receipt on this expense."}
          </p>
        </div>

        {expense.invoiceId && (
          <Link
            href={`/invoices/${expense.invoiceId}`}
            className="text-base text-accent hover:underline"
          >
            On an invoice
          </Link>
        )}
      </div>
    </Tray>
  );
}

function ExpenseHeader({
  view, set, onNew, canManage,
}: {
  view: View; set: (p: Record<string, string | null>) => void; onNew: () => void; canManage: boolean;
}) {
  return (
    <PageHeader
      title="Expenses"
      actions={
        <>
          {view === "categories" && canManage && (
            <Button variant="secondary" onClick={() => set({ view: null })}>Back to expenses</Button>
          )}
          <Button variant="primary" onClick={onNew}><Plus className="size-4" />New expense</Button>
        </>
      }
    />
  );
}

/* ------------------------------------------------------------- categories */

function CategoryList({ expenses }: { expenses: Expense[] }) {
  const { expenseCategories } = useApp();
  const router = useRouter();

  const stats = React.useMemo(() => {
    const m = new Map<string, { count: number; total: number }>();
    for (const e of expenses) {
      const cur = m.get(e.categoryId) ?? { count: 0, total: 0 };
      cur.count += 1; cur.total += e.totalCents;
      m.set(e.categoryId, cur);
    }
    return m;
  }, [expenses]);

  return (
    <Card padded={false}>
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div>
          <h2 className="text-md font-semibold text-ink">Expense categories</h2>
          <p className="text-base text-ink-secondary">
            A category with a unit price bills by quantity, like mileage. Everything else takes a plain amount.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => router.push("/settings?tab=expenses")}>
          <Plus className="size-3.5" />New category
        </Button>
      </div>

      <div className="flex items-center border-b border-border bg-bg-muted px-4 py-2 text-xs font-semibold uppercase tracking-[0.04em] text-ink-tertiary">
        <span className="flex-1">Category</span>
        <span className="w-40 text-right">Unit price</span>
        <span className="w-28 text-right">Expenses</span>
        <span className="w-32 text-right">Total</span>
      </div>
      {expenseCategories.map((c) => {
        const s = stats.get(c.id) ?? { count: 0, total: 0 };
        return (
          <div key={c.id} className="flex items-center border-b border-border px-4 py-2.5 text-base last:border-b-0">
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <span className="truncate font-medium text-ink">{c.name}</span>
              {c.archivedAt && <Badge variant="neutral">Archived</Badge>}
            </span>
            <span className="w-40 text-right tabular-nums text-ink-secondary">
              {c.unitPriceCents ? `${formatMoney(c.unitPriceCents)} / ${c.unitName}` : "By amount"}
            </span>
            <span className="w-28 text-right tabular-nums">{s.count}</span>
            <span className="w-32 text-right font-medium tabular-nums">{formatMoney(s.total)}</span>
          </div>
        );
      })}
    </Card>
  );
}

/* ----------------------------------------------------------- new expense */

/**
 * What an amount field will accept as it is typed (TALLY-45).
 *
 * `inputMode="decimal"` only hints to a soft keyboard; on a desktop it lets
 * letters straight through, and "abc" parsed to zero without ever saying so.
 * `type="number"` is the other obvious answer and is worse: it silently drops
 * the whole value on a stray character, and its spinners are useless on money.
 *
 * So the value is filtered rather than validated: digits and at most one
 * decimal point survive, everything else never appears. Formatting to two
 * places happens on blur, so typing "12.5" is not fought with mid-keystroke.
 */
function acceptMoney(raw: string): string {
  const cleaned = raw.replace(/[^\d.]/g, "");
  const [whole, ...rest] = cleaned.split(".");
  return rest.length ? `${whole}.${rest.join("").slice(0, 2)}` : whole!;
}

function ExpenseDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { me, expenseCategories, projectById } = useApp();

  const [projectId, setProjectId] = React.useState("");
  const [categoryId, setCategoryId] = React.useState(expenseCategories[0]?.id ?? "");
  const [spentOn, setSpentOn] = React.useState(isoDate(new Date()));
  const [units, setUnits] = React.useState("");
  const [amount, setAmount] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [billable, setBillable] = React.useState(true);
  const [reimbursable, setReimbursable] = React.useState(false);
  const [receipt, setReceipt] = React.useState<string | undefined>();
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setProjectId(""); setSpentOn(isoDate(new Date())); setUnits(""); setAmount("");
    setNotes(""); setBillable(true); setReimbursable(false); setReceipt(undefined);
    setCategoryId(expenseCategories[0]?.id ?? "");
  }, [open, expenseCategories]);

  const category = expenseCategories.find((c) => c.id === categoryId);
  const byUnit = !!category?.unitPriceCents;
  const computed = byUnit && units ? Math.round(Number(units) * category!.unitPriceCents!) : parseMoney(amount) ?? 0;

  const canSave = !!projectId && !!categoryId && computed > 0;

  const create = async () => {
    if (!canSave) return;
    setSaving(true);
    await api.createExpense({
      userId: me.id, projectId, categoryId, spentOn,
      units: byUnit && units ? Number(units) : undefined,
      totalCents: computed,
      notes: notes.trim() || undefined,
      isBillable: billable, isReimbursable: reimbursable,
      reimbursementState: reimbursable ? "pending" : undefined,
      receiptName: receipt,
    });
    setSaving(false);
    qc.invalidateQueries({ queryKey: ["expenses"] });
    toast.push({ tone: "success", title: `Expense of ${formatMoney(computed)} added to ${projectById.get(projectId)?.name}.` });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="New expense"
        description="Anything you paid for on a client's behalf."
        footer={
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button variant="primary" disabled={!canSave} loading={saving} onClick={create}>Save expense</Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="Project" required>
            <ProjectPicker projectId={projectId} onChange={setProjectId} portal={false} />
          </Field>

          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Category" required>
              <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                {expenseCategories.filter((c) => !c.archivedAt).map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </Select>
            </Field>
            <Field label="Date" required>
              <Input type="date" value={spentOn} onChange={(e) => setSpentOn(e.target.value)} />
            </Field>
          </div>

          {byUnit ? (
            <div className="grid gap-4 md:grid-cols-2">
              <Field label={`${category!.unitName ?? "Units"}s`} required help={`${formatMoney(category!.unitPriceCents!)} per ${category!.unitName}`}>
                <Input inputMode="decimal" align="right" value={units} onChange={(e) => setUnits(acceptMoney(e.target.value))} placeholder="0" />
              </Field>
              <Field label="Total">
                <Input readOnly align="right" value={formatMoney(computed)} className="bg-bg-muted" />
              </Field>
            </div>
          ) : (
            <Field label="Amount" required>
              <Affix prefix="$">
                <Input
                  inputMode="decimal"
                  align="right"
                  value={amount}
                  onChange={(e) => setAmount(acceptMoney(e.target.value))}
                  onBlur={() => setAmount((a) => (a ? (parseMoney(a) ?? 0) / 100 : 0).toFixed(2))}
                  placeholder="0.00"
                />
              </Affix>
            </Field>
          )}

          <Field label="Notes">
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What was it for?" />
          </Field>

          <Field label="Receipt">
            <Dropzone
              label={receipt ? `Attached: ${receipt}` : "Drop a receipt, or click to choose"}
              hint="PDF, PNG, or JPG up to 10 MB"
              onFiles={(files) => setReceipt(files[0]?.name)}
            />
          </Field>

          <div className="flex flex-col gap-2.5">
            <label className="flex cursor-pointer items-center gap-2.5">
              <Checkbox checked={billable} onCheckedChange={setBillable} />
              <span className="text-base text-ink">Bill this back to the client</span>
            </label>
            <label className="flex cursor-pointer items-center gap-2.5">
              <Checkbox checked={reimbursable} onCheckedChange={setReimbursable} />
              <span className="text-base text-ink">Reimburse me for this</span>
            </label>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
