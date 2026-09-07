"use client";

/**
 * New invoice.
 *
 * Built around the only question that matters at this point: which uninvoiced
 * work goes on it. The lines are found for you and every one is ticked by
 * default, because the common case is billing everything since last time.
 */

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "@/lib/api";
import type { UninvoicedLine } from "@/lib/api";
import { cn } from "@/lib/cn";
import { addDays, formatMoney, isoDate, parseMoney } from "@/lib/format";
import { TERM_DAYS } from "@/lib/labels";
import {
  Affix, Badge, Banner, Button, Card, Checkbox, EmptyState, Field, Input, Segmented, Select,
  Spinner, Textarea,
} from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { PageBody, PageHeader } from "@/components/app/page-chrome";
import { SectionTitle } from "@/components/app/kpi";
import { useApp } from "@/components/app/providers";

type GroupBy = "project" | "task" | "person";

export default function NewInvoicePage() {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const search = useSearchParams();
  const { clients, clientById } = useApp();

  const active = React.useMemo(() => clients.filter((c) => !c.archivedAt).sort((a, b) => a.name.localeCompare(b.name)), [clients]);
  const [clientId, setClientId] = React.useState(search.get("client") ?? "");
  const [groupBy, setGroupBy] = React.useState<GroupBy>("project");
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState(isoDate(new Date()));
  const [chosen, setChosen] = React.useState<Set<string>>(new Set());

  const [subject, setSubject] = React.useState("");
  const [poNumber, setPoNumber] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [issueDate, setIssueDate] = React.useState(isoDate(new Date()));
  const [tax, setTax] = React.useState("");
  const [discount, setDiscount] = React.useState("");

  const client = clientId ? clientById.get(clientId) : undefined;

  // The due date follows the client's terms until someone types over it.
  const [dueDate, setDueDate] = React.useState("");
  const [dueTouched, setDueTouched] = React.useState(false);
  React.useEffect(() => {
    if (dueTouched) return;
    const days = client ? TERM_DAYS[client.paymentTerm] : 30;
    setDueDate(isoDate(addDays(new Date(`${issueDate}T00:00:00`), days)));
  }, [client, issueDate, dueTouched]);

  React.useEffect(() => {
    if (!client) return;
    setTax(client.taxPercent != null ? String(client.taxPercent) : "");
    setDiscount(client.discountPercent != null ? String(client.discountPercent) : "");
  }, [client]);

  const { data: lines, isFetching } = useQuery({
    queryKey: ["uninvoiced", clientId, from, to, groupBy],
    queryFn: () => api.getUninvoiced(clientId, { from: from || undefined, to: to || undefined, groupBy }),
    enabled: !!clientId,
  });

  // Every freshly found line starts ticked.
  React.useEffect(() => {
    if (lines) setChosen(new Set(lines.map((l) => l.key)));
  }, [lines]);

  const selected = React.useMemo(() => (lines ?? []).filter((l) => chosen.has(l.key)), [lines, chosen]);

  const totals = React.useMemo(() => {
    const subtotal = selected.reduce((a, l) => a + l.amountCents, 0);
    const discountCents = Math.round(subtotal * ((Number(discount) || 0) / 100));
    const taxable = selected.filter((l) => l.kind !== "expense").reduce((a, l) => a + l.amountCents, 0) - discountCents;
    const taxCents = Math.round(Math.max(0, taxable) * ((Number(tax) || 0) / 100));
    return { subtotal, discountCents, taxCents, total: subtotal - discountCents + taxCents };
  }, [selected, tax, discount]);

  const create = useMutation({
    mutationFn: () => api.createInvoice({
      clientId, subject, notes, poNumber, issueDate, dueDate,
      taxPercent: tax.trim() ? Number(tax) : undefined,
      discountPercent: discount.trim() ? Number(discount) : undefined,
      lines: selected,
    }),
    onSuccess: (inv) => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["time"] });
      qc.invalidateQueries({ queryKey: ["expenses"] });
      toast.push({ tone: "success", title: `Draft ${inv.number} created for ${formatMoney(inv.totalCents, inv.currency)}.` });
      router.push(`/invoices/${inv.id}`);
    },
  });

  /*
    Billed in QuickBooks, rather than billed here.

    JH Media Group invoices through QuickBooks and logs the time in Tally.
    Without a way to say so, every hour they bill sits on the Uninvoiced screen
    for ever and reads as a receivable nobody is going to collect through this
    system.

    It shares this screen's selection deliberately. Choosing what to bill is the
    same act whichever system produces the document, so the difference is the
    button at the end and not a second screen to learn.

    No invoice is created: there is no number and no total, because the document
    lives in QuickBooks. Undo puts the work straight back on the list.
  */
  const external = useMutation({
    mutationFn: () =>
      api.markBilledExternally({
        clientId,
        timeEntryIds: selected.flatMap((l) => l.entryIds),
        expenseIds: selected.flatMap((l) => l.expenseIds),
      }),
    onSuccess: (result) => {
      const timeEntryIds = selected.flatMap((l) => l.entryIds);
      const expenseIds = selected.flatMap((l) => l.expenseIds);
      qc.invalidateQueries({ queryKey: ["uninvoiced"] });
      qc.invalidateQueries({ queryKey: ["time"] });
      qc.invalidateQueries({ queryKey: ["expenses"] });
      toast.push({
        tone: "success",
        title: `Marked as invoiced in QuickBooks: ${result.timeEntries} ${result.timeEntries === 1 ? "entry" : "entries"}${result.expenses ? ` and ${result.expenses} ${result.expenses === 1 ? "expense" : "expenses"}` : ""}.`,
        undo: async () => {
          await api.markBilledExternally({ clientId, timeEntryIds, expenseIds, billed: false });
          qc.invalidateQueries({ queryKey: ["uninvoiced"] });
          qc.invalidateQueries({ queryKey: ["time"] });
          qc.invalidateQueries({ queryKey: ["expenses"] });
        },
      });
      router.push("/invoices?tab=uninvoiced");
    },
    onError: (e: unknown) =>
      toast.push({ tone: "danger", title: e instanceof Error ? e.message : "Could not mark that work." }),
  });

  const canCreate = !!clientId && selected.length > 0 && !!issueDate && !!dueDate;
  const canMarkExternal = !!clientId && selected.length > 0;

  const toggle = (key: string) => setChosen((s) => {
    const next = new Set(s);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  return (
    <>
      <PageHeader
        breadcrumb={[{ label: "Invoices", href: "/invoices" }]}
        title="New invoice"
        actions={
          <>
            <Button variant="ghost" onClick={() => router.back()}>Cancel</Button>
            <Button
              variant="secondary"
              disabled={!canMarkExternal}
              loading={external.isPending}
              onClick={() => external.mutate()}
            >
              Invoiced in QuickBooks
            </Button>
            <Button variant="primary" disabled={!canCreate} loading={create.isPending} onClick={() => create.mutate()}>
              Create draft
            </Button>
          </>
        }
      />

      <PageBody className="max-w-[1200px] pt-5">
        <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
          <div className="flex flex-col gap-4">
            <Card>
              <SectionTitle>Who and when</SectionTitle>
              <div className="grid gap-4 md:grid-cols-3">
                <Field label="Client" required className="md:col-span-3">
                  <Select value={clientId} onChange={(e) => setClientId(e.target.value)}>
                    <option value="">Choose a client</option>
                    {active.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </Select>
                </Field>
                <Field label="Include work from" help="Leave blank for everything uninvoiced.">
                  <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
                </Field>
                <Field label="Through">
                  <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
                </Field>
                <Field label="Group lines by">
                  <Segmented
                    value={groupBy}
                    onChange={setGroupBy}
                    options={[
                      { value: "project", label: "Project" },
                      { value: "task", label: "Task" },
                      { value: "person", label: "Person" },
                    ]}
                    aria-label="Group invoice lines by"
                  />
                </Field>
              </div>
            </Card>

            <Card padded={false}>
              <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                <h2 className="text-md font-semibold text-ink">Uninvoiced work</h2>
                {lines && lines.length > 0 && (
                  <div className="flex items-center gap-2 text-base text-ink-secondary">
                    <span>{selected.length} of {lines.length} lines</span>
                    <Button variant="ghost" size="sm" onClick={() => setChosen(new Set(lines.map((l) => l.key)))}>Select all</Button>
                    <Button variant="ghost" size="sm" onClick={() => setChosen(new Set())}>Clear</Button>
                  </div>
                )}
              </div>

              {!clientId ? (
                <div className="p-4">
                  <EmptyState title="Choose a client first.">
                    Billable time and expenses that are not on an invoice yet will show up here.
                  </EmptyState>
                </div>
              ) : isFetching ? (
                <div className="flex items-center gap-2 p-4 text-base text-ink-secondary"><Spinner className="size-4" />Finding uninvoiced work…</div>
              ) : !lines?.length ? (
                <div className="p-4">
                  <EmptyState title="Nothing to invoice.">
                    Everything billable for this client in that range is already on an invoice.
                  </EmptyState>
                </div>
              ) : (
                <>
                  {lines.some((l: UninvoicedLine) => l.rateMissing) && (
                    /*
                      Say why the total is zero, at the point the total is zero.

                      An invoice reading $0.00 with real hours on it is the
                      symptom of a project with no billable rate. The system
                      already knew: `resolveRates` returns `rateMissing` when it
                      cannot find one, and nothing had ever read it, so the
                      first anybody heard was a client-facing document valued
                      at nothing (t-Fg-4v7).
                    */
                    <Banner variant="warning" title="Some of these hours have no billable rate">
                      The lines marked below value at $0.00 because their project has no
                      rate to bill at. Set an hourly rate on the project, or a rate for the
                      people on it, then reload this page. Hours already logged keep the rate
                      they were written with, so they will need re-rating.
                    </Banner>
                  )}
                  <div className="flex items-center border-y border-border bg-bg-muted px-4 py-2 text-xs font-semibold uppercase tracking-[0.04em] text-ink-tertiary">
                    <span className="w-8" />
                    <span className="flex-1">Line</span>
                    <span className="w-24 text-right">Quantity</span>
                    <span className="w-32 text-right">Rate</span>
                    <span className="w-32 text-right">Amount</span>
                  </div>
                  {lines.map((l: UninvoicedLine) => {
                    const on = chosen.has(l.key);
                    return (
                      <label
                        key={l.key}
                        className={cn(
                          "flex cursor-pointer items-center border-b border-border px-4 py-2.5 text-base last:border-b-0 hover:bg-surface-hover",
                          !on && "opacity-55"
                        )}
                      >
                        <span className="w-8"><Checkbox checked={on} onCheckedChange={() => toggle(l.key)} aria-label={`Include ${l.label}`} /></span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium leading-tight text-ink">{l.label}</span>
                          <span className="block truncate text-sm leading-tight text-ink-tertiary">
                            {l.sublabel}
                            {l.kind === "time"
                              ? ` · ${l.entryIds.length} ${l.entryIds.length === 1 ? "entry" : "entries"}`
                              : ` · ${l.expenseIds.length} ${l.expenseIds.length === 1 ? "expense" : "expenses"}`}
                          </span>
                        </span>
                        {l.rateMissing && <Badge variant="warning" className="mr-2">No rate</Badge>}
                        <span className="w-24 text-right tabular-nums text-ink-secondary">{l.quantity}</span>
                        <span className="w-32 text-right tabular-nums text-ink-secondary">{formatMoney(Math.round(l.unitPriceCents))}</span>
                        <span className="w-32 text-right font-medium tabular-nums">{formatMoney(l.amountCents)}</span>
                      </label>
                    );
                  })}
                </>
              )}
            </Card>

            <Card>
              <SectionTitle>Details</SectionTitle>
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="Subject" help="Shown under the header on the invoice.">
                  <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Services for August 2026" />
                </Field>
                <Field label="PO number">
                  <Input value={poNumber} onChange={(e) => setPoNumber(e.target.value)} placeholder="Optional" />
                </Field>
                <Field label="Notes" className="md:col-span-2">
                  <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Payment instructions, thank you note, anything the client should read." />
                </Field>
              </div>
            </Card>
          </div>

          {/* The running total, sticky so it stays put while the line list scrolls. */}
          <div className="flex flex-col gap-4 xl:sticky xl:top-[calc(var(--topbar-h)+96px)] xl:self-start">
            <Card>
              <SectionTitle>Dates</SectionTitle>
              <div className="grid gap-4">
                <Field label="Issue date" required>
                  <Input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} />
                </Field>
                <Field
                  label="Due date"
                  required
                  help={client && !dueTouched ? `Following ${client.name}'s terms.` : undefined}
                >
                  <Input type="date" value={dueDate} onChange={(e) => { setDueTouched(true); setDueDate(e.target.value); }} />
                </Field>
              </div>
            </Card>

            <Card>
              <SectionTitle>Totals</SectionTitle>
              <div className="grid gap-3 md:grid-cols-2">
                <Field label="Tax">
                  <Affix suffix="%"><Input inputMode="decimal" align="right" value={tax} onChange={(e) => setTax(e.target.value)} placeholder="0" /></Affix>
                </Field>
                <Field label="Discount">
                  <Affix suffix="%"><Input inputMode="decimal" align="right" value={discount} onChange={(e) => setDiscount(e.target.value)} placeholder="0" /></Affix>
                </Field>
              </div>

              <div className="mt-4 flex flex-col gap-1.5">
                <Row label="Subtotal" value={formatMoney(totals.subtotal)} />
                {totals.discountCents > 0 && <Row label="Discount" value={`-${formatMoney(totals.discountCents)}`} />}
                {totals.taxCents > 0 && <Row label="Tax" value={formatMoney(totals.taxCents)} />}
                <div className="mt-1 flex items-center justify-between border-t border-border-strong pt-2 text-lg font-semibold">
                  <span>Total</span>
                  <span className="tabular-nums">{formatMoney(totals.total)}</span>
                </div>
              </div>

              <Button
                variant="primary"
                className="mt-4 w-full"
                disabled={!canCreate}
                loading={create.isPending}
                onClick={() => create.mutate()}
              >
                Create draft
              </Button>
              <p className="mt-2 text-sm text-ink-tertiary">
                Creating a draft marks the underlying time and expenses as invoiced, so nothing gets billed twice.
              </p>
            </Card>
          </div>
        </div>
      </PageBody>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-base text-ink-secondary">
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}
