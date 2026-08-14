"use client";

/**
 * Recurring invoice editor.
 *
 * A schedule is a template plus a cadence, so the form is those two things and
 * nothing else. There is no issue date or due date on it: both are computed
 * when the invoice is raised, so a schedule set up in January bills with
 * February's numbering and the client's tax rate as it stands that day.
 *
 * Every rule this form appears to enforce is enforced again in
 * `src/server/services/recurring.ts`. The form avoids offering what would be
 * refused; the server is what refuses it.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import * as api from "@/lib/api";
import { formatMoney } from "@/lib/format";
import type { RecurringInvoice, RecurringInvoiceLine } from "@/lib/types";
import {
  Button, Card, EmptyState, Field, Input, Select, Spinner, Textarea,
} from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { PageBody, PageHeader } from "@/components/app/page-chrome";
import { SectionTitle } from "@/components/app/kpi";
import { useApp } from "@/components/app/providers";

const CADENCE: { value: RecurringInvoice["frequency"]; label: string; every: string }[] = [
  { value: "weekly", label: "Weekly", every: "weeks" },
  { value: "monthly", label: "Monthly", every: "months" },
  { value: "quarterly", label: "Quarterly", every: "quarters" },
  { value: "yearly", label: "Yearly", every: "years" },
];

type DraftLine = RecurringInvoiceLine & { key: string };

const emptyLine = (): DraftLine => ({
  key: `l-${Math.random().toString(36).slice(2, 8)}`,
  description: "",
  quantity: 1,
  unitPriceCents: 0,
});

const toCents = (v: string) => Math.round((Number(v) || 0) * 100);
const fromCents = (c: number) => (c / 100).toFixed(2);

/**
 * The record has to be in hand before the form mounts, or field state
 * initialises from nothing and saves the blanks back. Same rule as the client
 * and person editors.
 */
export function RecurringEditor({ scheduleId }: { scheduleId?: string }) {
  const router = useRouter();
  const { data: existing, isLoading } = useQuery({
    queryKey: ["recurring", scheduleId],
    queryFn: () => api.getRecurringInvoice(scheduleId!),
    enabled: Boolean(scheduleId),
  });

  if (scheduleId && isLoading) {
    return (
      <PageBody className="pt-10">
        <div className="flex items-center gap-2 text-base text-ink-secondary">
          <Spinner className="size-4" />
          Loading the schedule…
        </div>
      </PageBody>
    );
  }

  if (scheduleId && !existing) {
    return (
      <PageBody className="pt-10">
        <EmptyState
          title="Schedule not found."
          action={<Button onClick={() => router.push("/invoices?view=recurring")}>Back to recurring</Button>}
        >
          It may have been deleted, or the link may be wrong.
        </EmptyState>
      </PageBody>
    );
  }

  return <RecurringForm existing={existing ?? undefined} />;
}

function RecurringForm({ existing }: { existing?: RecurringInvoice }) {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const { clients } = useApp();

  const today = React.useMemo(() => new Date().toISOString().slice(0, 10), []);

  const [form, setForm] = React.useState(() => ({
    clientId: existing?.clientId ?? "",
    subject: existing?.subject ?? "",
    notes: existing?.notes ?? "",
    frequency: existing?.frequency ?? ("monthly" as RecurringInvoice["frequency"]),
    interval: String(existing?.interval ?? 1),
    startsOn: existing?.startsOn ?? today,
    endsOn: existing?.endsOn ?? "",
    occurrences: existing?.occurrencesRemaining != null ? String(existing.occurrencesRemaining) : "",
    paymentTermDays: String(existing?.paymentTermDays ?? 30),
    taxPercent: existing?.taxPercent != null ? String(existing.taxPercent) : "",
  }));

  const [lines, setLines] = React.useState<DraftLine[]>(() =>
    existing?.lines.length
      ? existing.lines.map((l, i) => ({ ...l, key: `l${i}` }))
      : [emptyLine()]
  );

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));
  const patchLine = (key: string, p: Partial<DraftLine>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...p } : l)));

  const total = lines.reduce((sum, l) => sum + Math.round(l.quantity * l.unitPriceCents), 0);
  const every = CADENCE.find((c) => c.value === form.frequency)?.every ?? "months";

  const save = useMutation({
    mutationFn: async () => {
      const input: api.RecurringInput = {
        clientId: form.clientId,
        subject: form.subject.trim() || null,
        notes: form.notes.trim() || null,
        frequency: form.frequency,
        interval: Number(form.interval) || 1,
        startsOn: form.startsOn,
        endsOn: form.endsOn || null,
        occurrencesRemaining: form.occurrences ? Number(form.occurrences) : null,
        paymentTermDays: Number(form.paymentTermDays) || 0,
        taxPercent: form.taxPercent ? Number(form.taxPercent) : null,
        lines: lines
          .filter((l) => l.description.trim())
          .map(({ key: _key, ...l }) => ({ ...l, description: l.description.trim() })),
      };
      return existing
        ? api.updateRecurringInvoice(existing.id, input)
        : api.createRecurringInvoice(input);
    },
    onSuccess: () => {
      toast.push({ tone: "success", title: existing ? "Schedule updated." : "Schedule created." });
      qc.invalidateQueries({ queryKey: ["recurring"] });
      router.push("/invoices?view=recurring");
    },
    onError: (error: unknown) => {
      toast.push({
        tone: "danger",
        title: error instanceof Error ? `Could not save. ${error.message}` : "Could not save.",
      });
    },
  });

  const canSave =
    form.clientId !== "" &&
    form.startsOn !== "" &&
    lines.some((l) => l.description.trim());

  return (
    <>
      <PageHeader
        breadcrumb={[
          { label: "Invoices", href: "/invoices" },
          { label: "Recurring", href: "/invoices?view=recurring" },
        ]}
        title={existing ? "Edit schedule" : "New recurring invoice"}
        actions={
          <>
            <Button variant="ghost" onClick={() => router.back()}>Cancel</Button>
            <Button variant="primary" disabled={!canSave} loading={save.isPending} onClick={() => save.mutate()}>
              {existing ? "Save schedule" : "Create schedule"}
            </Button>
          </>
        }
      />

      <PageBody className="max-w-[1000px] pt-5">
        <div className="flex flex-col gap-4">
          <Card>
            <SectionTitle>Who and what</SectionTitle>
            <div className="grid gap-4 lg:grid-cols-2">
              <Field label="Client" required>
                <Select value={form.clientId} onChange={(e) => set("clientId", e.target.value)}>
                  <option value="">Choose a client</option>
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Invoice subject" help="What the client sees at the top of every one of these.">
                <Input
                  value={form.subject}
                  onChange={(e) => set("subject", e.target.value)}
                  placeholder="Support Plan - Maintenance"
                />
              </Field>
              <Field label="Notes" className="lg:col-span-2" help="Printed below the line items on every invoice raised.">
                <Textarea rows={3} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
              </Field>
            </div>
          </Card>

          <Card>
            <SectionTitle>How often</SectionTitle>
            <div className="grid gap-4 lg:grid-cols-3">
              <Field label="Repeats">
                <Select
                  value={form.frequency}
                  onChange={(e) => set("frequency", e.target.value as RecurringInvoice["frequency"])}
                >
                  {CADENCE.map((c) => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </Select>
              </Field>
              <Field label={`Every N ${every}`} help="1 is every one. Use 3 for every third.">
                <Input
                  inputMode="numeric"
                  value={form.interval}
                  onChange={(e) => set("interval", e.target.value)}
                />
              </Field>
              <Field label="Payment terms" help="Days after issue the invoice is due.">
                <Input
                  inputMode="numeric"
                  value={form.paymentTermDays}
                  onChange={(e) => set("paymentTermDays", e.target.value)}
                />
              </Field>
              <Field
                label="First issue"
                required
                help="A date in the past starts from the next one due, not from arrears."
              >
                <Input type="date" value={form.startsOn} onChange={(e) => set("startsOn", e.target.value)} />
              </Field>
              <Field label="Stop after date" help="Leave empty to run until you stop it.">
                <Input type="date" value={form.endsOn} onChange={(e) => set("endsOn", e.target.value)} />
              </Field>
              <Field label="Stop after count" help="Leave empty for no limit. Whichever limit comes first wins.">
                <Input
                  inputMode="numeric"
                  value={form.occurrences}
                  onChange={(e) => set("occurrences", e.target.value)}
                  placeholder="No limit"
                />
              </Field>
            </div>

            {existing?.nextIssueOn && (
              <p className="mt-3 text-base text-ink-secondary">
                Next invoice: <span className="font-medium text-ink">{existing.nextIssueOn}</span>
                {existing.lastIssuedOn && <> · last raised {existing.lastIssuedOn}</>}
              </p>
            )}
          </Card>

          <Card>
            <SectionTitle>What to bill</SectionTitle>
            <div className="flex flex-col gap-2">
              {lines.map((l) => (
                <div key={l.key} className="grid grid-cols-[1fr_90px_130px_120px_36px] items-end gap-2">
                  <Field label="Description">
                    <Input
                      value={l.description}
                      onChange={(e) => patchLine(l.key, { description: e.target.value })}
                      placeholder="Monthly support"
                    />
                  </Field>
                  <Field label="Qty">
                    <Input
                      inputMode="decimal"
                      value={String(l.quantity)}
                      onChange={(e) => patchLine(l.key, { quantity: Number(e.target.value) || 0 })}
                    />
                  </Field>
                  <Field label="Unit price">
                    <Input
                      inputMode="decimal"
                      value={fromCents(l.unitPriceCents)}
                      onChange={(e) => patchLine(l.key, { unitPriceCents: toCents(e.target.value) })}
                    />
                  </Field>
                  <Field label="Amount">
                    <div className="flex h-9 items-center justify-end pr-1 tabular-nums text-ink-secondary">
                      {formatMoney(Math.round(l.quantity * l.unitPriceCents))}
                    </div>
                  </Field>
                  <Button
                    variant="ghost"
                    aria-label="Remove line"
                    className="mb-0.5"
                    disabled={lines.length === 1}
                    onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              ))}
            </div>

            <div className="mt-3 flex items-center justify-between">
              <Button variant="secondary" size="sm" onClick={() => setLines((ls) => [...ls, emptyLine()])}>
                <Plus className="size-4" />Add line
              </Button>
              <div className="text-base">
                <span className="text-ink-secondary">Each invoice</span>{" "}
                <span className="font-semibold tabular-nums text-ink">{formatMoney(total)}</span>
              </div>
            </div>

            <div className="mt-4 max-w-[220px]">
              <Field label="Tax percent" help="Leave empty to use no tax.">
                <Input
                  inputMode="decimal"
                  value={form.taxPercent}
                  onChange={(e) => set("taxPercent", e.target.value)}
                  placeholder="None"
                />
              </Field>
            </div>
          </Card>
        </div>
      </PageBody>
    </>
  );
}
