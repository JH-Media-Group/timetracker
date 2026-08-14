"use client";

/**
 * Invoice detail.
 *
 * The left column is the document as the client will see it. The right column is
 * everything we know about it that they do not: what is still owed, what has
 * been paid, and every state change with a name and a timestamp against it.
 */

import * as React from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Send } from "lucide-react";
import * as api from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatDateUS, formatDueIn, formatMoney, isoDate, parseMoney, relativeTime } from "@/lib/format";
import { TERM_LABEL } from "@/lib/labels";
import type { Invoice } from "@/lib/types";
import {
  Badge, Button, Card, Dialog, DialogContent, EmptyState, Field, Input, Menu, MenuItem, Select, Spinner,
} from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { PageBody, PageHeader } from "@/components/app/page-chrome";
import { InvoiceBadge, KpiRow, SectionTitle } from "@/components/app/kpi";
import { useApp, useCan } from "@/components/app/providers";

export default function InvoiceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const { clientById, projectById, userById, settings } = useApp();
  const can = useCan();
  const [paying, setPaying] = React.useState(false);

  const { data: invoice, isLoading } = useQuery({
    queryKey: ["invoice", id], queryFn: () => api.getInvoice(id), enabled: !!id,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["invoice", id] });
    qc.invalidateQueries({ queryKey: ["invoices"] });
  };

  const invoiceClient = invoice ? clientById.get(invoice.clientId) : undefined;
  const primaryEmail =
    invoiceClient?.contacts.find((c) => c.isPrimary)?.email ??
    invoiceClient?.contacts.find((c) => c.email)?.email ??
    null;

  const reminder = useMutation({
    mutationFn: () => api.sendReminder(id, primaryEmail ? [primaryEmail] : []),
    onSuccess: (r) => {
      refresh();
      // Says what happened, not what was hoped for. With no mail transport
      // configured the row is written and nothing leaves the building, and the
      // person chasing a payment needs to know which of those it was.
      toast.push({
        tone: r.delivered ? "success" : undefined,
        title: r.delivered
          ? `Reminder sent to ${primaryEmail}.`
          : "Reminder recorded on the timeline. No email was sent: mail delivery is not configured yet.",
      });
    },
    onError: (e) => toast.push({ tone: "danger", title: e instanceof Error ? e.message : "Could not send that reminder." }),
  });

  const duplicate = useMutation({
    mutationFn: () => api.duplicateInvoice(id),
    onSuccess: (copy) => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      toast.push({ tone: "success", title: `Duplicated as ${copy.number}.` });
      router.push(`/invoices/${copy.id}`);
    },
    onError: (e) => toast.push({ tone: "danger", title: e instanceof Error ? e.message : "Could not duplicate that invoice." }),
  });

  if (isLoading) {
    return (
      <PageBody className="pt-10">
        <div className="flex items-center gap-2 text-base text-ink-secondary"><Spinner className="size-4" />Loading the invoice…</div>
      </PageBody>
    );
  }

  if (!invoice) {
    return (
      <PageBody className="pt-10">
        <EmptyState title="Invoice not found." action={<Button onClick={() => router.push("/invoices")}>Back to invoices</Button>}>
          It may have been deleted, or the link may be wrong.
        </EmptyState>
      </PageBody>
    );
  }

  const inv = invoice as Invoice;
  const client = clientById.get(inv.clientId);
  const balance = inv.totalCents - inv.paidCents;
  const editable = inv.state === "draft";

  return (
    <>
      <PageHeader
        breadcrumb={[{ label: "Invoices", href: "/invoices" }, { label: client?.name ?? "Client", href: `/clients/${inv.clientId}` }]}
        title={`Invoice ${inv.number}`}
        badge={<InvoiceBadge state={inv.state} />}
        actions={can("invoice:manage") && (
          <>
            {editable && (
              <Button variant="secondary" onClick={async () => { await api.markInvoiceSent(inv.id); refresh(); toast.push({ tone: "success", title: "Invoice marked as sent." }); }}>
                <Send className="size-3.5" />Mark as sent
              </Button>
            )}
            {balance > 0 && !editable && (
              <Button variant="primary" onClick={() => setPaying(true)}>Record payment</Button>
            )}
            <Button variant="secondary" onClick={() => window.print()}>
              <Download className="size-3.5" />Print or save as PDF
            </Button>
            <Menu trigger={<Button variant="secondary">Actions</Button>}>
              <MenuItem disabled={reminder.isPending || !primaryEmail} onSelect={() => reminder.mutate()}>
                {primaryEmail ? "Email reminder" : "Email reminder (no contact email)"}
              </MenuItem>
              <MenuItem disabled={duplicate.isPending} onSelect={() => duplicate.mutate()}>Duplicate</MenuItem>
              <MenuItem onSelect={async () => { await api.updateInvoice(inv.id, { state: "written_off" }); refresh(); toast.push({ title: "Invoice written off." }); }}>
                Write off
              </MenuItem>
              <MenuItem
                danger
                disabled={!editable}
                onSelect={async () => {
                  await api.deleteInvoice(inv.id);
                  qc.invalidateQueries({ queryKey: ["invoices"] });
                  toast.push({ tone: "danger", title: "Draft deleted. Its time is uninvoiced again." });
                  router.push("/invoices");
                }}
              >
                Delete draft
              </MenuItem>
            </Menu>
          </>
        )}
      />

      <PageBody className="pt-4">
        <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
          {/* The document */}
          <Card padded={false} className="overflow-hidden">
            <div className="flex flex-wrap items-start justify-between gap-6 border-b border-border p-6">
              <div>
                <div className="text-xs font-semibold uppercase tracking-[0.06em] text-ink-tertiary">From</div>
                <div className="mt-1 font-medium text-ink">{settings.companyName || "JH Media Group"}</div>
                <div className="whitespace-pre-line text-base text-ink-secondary">{settings.companyAddress}</div>
              </div>
              <div>
                <div className="text-xs font-semibold uppercase tracking-[0.06em] text-ink-tertiary">Bill to</div>
                <Link href={`/clients/${inv.clientId}`} className="mt-1 block font-medium text-ink hover:underline">
                  {client?.name}
                </Link>
                <div className="whitespace-pre-line text-base text-ink-secondary">{client?.address}</div>
              </div>
              <div className="text-right">
                <div className="text-2xl font-semibold tracking-(--ls-tight) text-ink">{formatMoney(inv.totalCents, inv.currency)}</div>
                <div className="mt-1 text-base text-ink-secondary">
                  {inv.state === "paid" ? `Paid ${inv.paidAt ? formatDateUS(inv.paidAt.slice(0, 10)) : ""}` : `Due ${formatDateUS(inv.dueDate)}`}
                </div>
                {inv.poNumber && <div className="text-sm text-ink-tertiary">PO {inv.poNumber}</div>}
              </div>
            </div>

            {inv.subject && (
              <div className="border-b border-border px-6 py-3 font-medium text-ink">{inv.subject}</div>
            )}

            <div className="flex items-center border-b border-border bg-bg-muted px-6 py-2 text-xs font-semibold uppercase tracking-[0.04em] text-ink-tertiary">
              <span className="flex-1">Description</span>
              <span className="w-24 text-right">Quantity</span>
              <span className="w-32 text-right">Unit price</span>
              <span className="w-32 text-right">Amount</span>
            </div>
            {inv.lineItems.map((li) => (
              <div key={li.id} className="flex items-start border-b border-border px-6 py-3 text-base">
                <span className="min-w-0 flex-1 pr-4">
                  <span className="block text-ink">{li.description}</span>
                  <span className="block text-sm text-ink-tertiary">
                    {li.itemType}
                    {(() => {
                      // The project only earns a mention when the description
                      // does not already lead with it.
                      const project = li.projectId ? projectById.get(li.projectId) : undefined;
                      return project && !li.description.startsWith(project.name) ? ` · ${project.name}` : "";
                    })()}
                  </span>
                </span>
                <span className="w-24 text-right tabular-nums text-ink-secondary">{li.quantity}</span>
                <span className="w-32 text-right tabular-nums text-ink-secondary">{formatMoney(li.unitPriceCents, inv.currency)}</span>
                <span className="w-32 text-right font-medium tabular-nums">{formatMoney(li.amountCents, inv.currency)}</span>
              </div>
            ))}

            <div className="flex justify-end px-6 py-4">
              <div className="w-full max-w-[320px]">
                <SumRow label="Subtotal" value={formatMoney(inv.subtotalCents, inv.currency)} />
                {inv.discountCents > 0 && (
                  <SumRow label={`Discount${inv.discountPercent ? ` (${inv.discountPercent}%)` : ""}`} value={`-${formatMoney(inv.discountCents, inv.currency)}`} />
                )}
                {inv.taxCents > 0 && (
                  <SumRow label={`Tax${inv.taxPercent ? ` (${inv.taxPercent}%)` : ""}`} value={formatMoney(inv.taxCents, inv.currency)} />
                )}
                <div className="mt-1 flex items-center justify-between border-t border-border-strong pt-2 text-lg font-semibold">
                  <span>Total</span>
                  <span className="tabular-nums">{formatMoney(inv.totalCents, inv.currency)}</span>
                </div>
                {inv.paidCents > 0 && (
                  <>
                    <SumRow label="Paid" value={`-${formatMoney(inv.paidCents, inv.currency)}`} />
                    <div className="flex items-center justify-between border-t border-border pt-2 font-medium">
                      <span>Balance due</span>
                      <span className={cn("tabular-nums", balance > 0 && "text-danger")}>{formatMoney(balance, inv.currency)}</span>
                    </div>
                  </>
                )}
              </div>
            </div>

            {inv.notes && (
              <div className="border-t border-border px-6 py-4">
                <div className="text-xs font-semibold uppercase tracking-[0.06em] text-ink-tertiary">Notes</div>
                <p className="mt-1 whitespace-pre-line text-base text-ink-secondary">{inv.notes}</p>
              </div>
            )}
          </Card>

          {/* The ledger */}
          <div className="flex flex-col gap-4">
            <Card>
              <SectionTitle>Summary</SectionTitle>
              <div className="flex flex-col gap-2">
                <KpiRow label="Amount" value={formatMoney(inv.totalCents, inv.currency)} />
                <KpiRow label="Paid" value={formatMoney(inv.paidCents, inv.currency)} />
                <KpiRow label="Balance" value={formatMoney(balance, inv.currency)} danger={inv.state === "late"} />
                <div className="my-1 h-px bg-border" />
                <KpiRow label="Issued" value={formatDateUS(inv.issueDate)} />
                <KpiRow label="Due" value={formatDateUS(inv.dueDate)} />
                {client && <KpiRow label="Terms" value={TERM_LABEL[client.paymentTerm]} />}
                {/* A draft has no clock running against it, so it is never late. */}
                {inv.state !== "draft" && inv.state !== "paid" && inv.state !== "written_off" && (
                  <KpiRow label="Timing" value={formatDueIn(inv.dueDate, new Date())} danger={inv.state === "late"} />
                )}
              </div>
            </Card>

            <Card>
              <SectionTitle
                action={can("invoice:manage") && balance > 0 && inv.state !== "draft" && (
                  <Button variant="secondary" size="sm" onClick={() => setPaying(true)}>Record</Button>
                )}
              >
                Payments
              </SectionTitle>
              {inv.payments.length === 0 ? (
                <p className="text-base text-ink-secondary">No payments recorded.</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {inv.payments.map((p) => (
                    <div key={p.id} className="flex items-center justify-between text-base">
                      <span className="min-w-0">
                        <span className="block leading-tight text-ink">{formatMoney(p.amountCents, inv.currency)}</span>
                        <span className="block text-sm leading-tight text-ink-tertiary">
                          {formatDateUS(p.paidAt.slice(0, 10))}{p.method ? ` · ${p.method}` : ""}
                        </span>
                      </span>
                      <Badge variant="success">Received</Badge>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            {/* Internal. The timeline names who sent what and when, which is
                our record of the conversation, not the client's copy of it. */}
            <Card data-print="hide">
              <SectionTitle>Activity</SectionTitle>
              <ol className="flex flex-col gap-3">
                {inv.events.map((e) => (
                  <li key={e.id} className="flex gap-2.5">
                    <span className="mt-1.5 size-2 shrink-0 rounded-full bg-border-strong" aria-hidden />
                    <span className="min-w-0">
                      <span className="block text-base leading-tight text-ink">{e.label}</span>
                      <span className="block text-sm leading-tight text-ink-tertiary">
                        {e.actorId && userById.get(e.actorId)
                          ? `${userById.get(e.actorId)!.firstName} ${userById.get(e.actorId)!.lastName} · `
                          : ""}
                        {relativeTime(e.at)}
                        {e.amountCents ? ` · ${formatMoney(e.amountCents, inv.currency)}` : ""}
                      </span>
                    </span>
                  </li>
                ))}
              </ol>
            </Card>
          </div>
        </div>
      </PageBody>

      <PaymentDialog invoice={inv} open={paying} onOpenChange={setPaying} onDone={refresh} />
    </>
  );
}

function SumRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-1 text-base text-ink-secondary">
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

function PaymentDialog({
  invoice, open, onOpenChange, onDone,
}: {
  invoice: Invoice; open: boolean; onOpenChange: (v: boolean) => void; onDone: () => void;
}) {
  const toast = useToast();
  const balance = invoice.totalCents - invoice.paidCents;
  const [amount, setAmount] = React.useState("");
  const [paidAt, setPaidAt] = React.useState(isoDate(new Date()));
  const [method, setMethod] = React.useState("ACH");
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (open) { setAmount((balance / 100).toFixed(2)); setPaidAt(isoDate(new Date())); setMethod("ACH"); }
  }, [open, balance]);

  const cents = parseMoney(amount) ?? 0;
  const canSave = cents > 0 && cents <= balance;

  const record = async () => {
    if (!canSave) return;
    setSaving(true);
    await api.recordPayment(invoice.id, cents, new Date(`${paidAt}T12:00:00`).toISOString());
    setSaving(false);
    onDone();
    toast.push({ tone: "success", title: `Recorded ${formatMoney(cents, invoice.currency)} against ${invoice.number}.` });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Record a payment"
        description={`${formatMoney(balance, invoice.currency)} outstanding on ${invoice.number}.`}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button variant="primary" disabled={!canSave} loading={saving} onClick={record}>Record payment</Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field
            label="Amount"
            required
            error={cents > balance ? "More than the outstanding balance." : undefined}
          >
            <Input
              inputMode="decimal" align="right" autoFocus
              value={amount} onChange={(e) => setAmount(e.target.value)}
              state={cents > balance ? "invalid" : undefined}
            />
          </Field>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Received on" required>
              <Input type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />
            </Field>
            <Field label="Method">
              <Select value={method} onChange={(e) => setMethod(e.target.value)}>
                {["ACH", "Wire", "Check", "Card", "Cash", "Other"].map((m) => <option key={m} value={m}>{m}</option>)}
              </Select>
            </Field>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
