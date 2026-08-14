"use client";

/**
 * Client detail.
 *
 * Answers the four questions someone opens a client for: what have we done for
 * them, what have we not billed yet, what have they not paid yet, and who do we
 * email about it.
 */

import * as React from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Mail, Pencil, Phone, Plus } from "lucide-react";
import * as api from "@/lib/api";
import { cn } from "@/lib/cn";
import { projectBudget, sumValue, ValueAccumulator } from "@/lib/derive";
import { formatDateUS, formatDuration, formatMoney, formatMoneyShort, formatPercent } from "@/lib/format";
import type { Invoice, TimeEntry } from "@/lib/types";
import {
  Avatar, Badge, Button, Card, EmptyState, Spinner, Menu, MenuItem, Meter, Tabs,
} from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { PageBody, PageHeader } from "@/components/app/page-chrome";
import { InvoiceBadge, Kpi, KpiRow, SectionTitle } from "@/components/app/kpi";
import { BarChart } from "@/components/app/charts";
import { useApp, useCan } from "@/components/app/providers";

export default function ClientDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const qc = useQueryClient();
  const { clientById, projects, ready } = useApp();
  const can = useCan();
  const client = clientById.get(id);

  const [tab, setTab] = React.useState("projects");

  const { data: entries = [] } = useQuery({
    queryKey: ["time", "client", id],
    queryFn: () => api.listTimeEntries({ clientId: id }),
    enabled: !!id,
  });
  const { data: invoices = [] } = useQuery({ queryKey: ["invoices"], queryFn: api.listInvoices });

  const clientProjects = React.useMemo(
    () => projects.filter((p) => p.clientId === id),
    [projects, id]
  );

  const archive = useMutation({
    mutationFn: () => api.archiveClient(id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["bootstrap"] });
      toast.push({
        tone: "danger",
        title: "Client archived. Their history stays in reports and on invoices.",
      });
      router.push("/clients");
    },
    onError: (e) =>
      toast.push({ tone: "danger", title: e instanceof Error ? e.message : "Could not archive that client." }),
  });
  const clientInvoices = React.useMemo(
    () => (invoices as Invoice[]).filter((i) => i.clientId === id).sort((a, b) => b.issueDate.localeCompare(a.issueDate)),
    [invoices, id]
  );

  const stats = React.useMemo(() => {
    const list = entries as TimeEntry[];
    let seconds = 0, billableSeconds = 0;
    const uninvoicedAcc = new ValueAccumulator();
    const costAcc = new ValueAccumulator();
    for (const e of list) {
      seconds += e.durationSeconds;
      costAcc.add(e.durationSeconds, e.costRateCents ?? 0);
      if (e.isBillable) {
        billableSeconds += e.durationSeconds;
        if (!e.invoiceId && !e.billedExternally) uninvoicedAcc.add(e.durationSeconds, e.billableRateCents ?? 0);
      }
    }
    const uninvoiced = uninvoicedAcc.cents;
    const cost = costAcc.cents;
    const outstanding = clientInvoices
      .filter((i) => i.state === "sent" || i.state === "partial" || i.state === "late")
      .reduce((a, i) => a + (i.totalCents - i.paidCents), 0);
    const paid = clientInvoices.reduce((a, i) => a + i.paidCents, 0);
    const overdue = clientInvoices.filter((i) => i.state === "late").length;
    return { seconds, billableSeconds, uninvoiced, cost, outstanding, paid, overdue };
  }, [entries, clientInvoices]);

  /** Hours per month across the whole relationship, most recent 12 months. */
  const monthly = React.useMemo(() => {
    const buckets = new Map<string, number>();
    for (const e of entries as TimeEntry[]) {
      const key = e.spentOn.slice(0, 7);
      buckets.set(key, (buckets.get(key) ?? 0) + e.durationSeconds);
    }
    return [...buckets.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-12)
      .map(([key, secs]) => ({
        label: new Date(`${key}-01T00:00:00`).toLocaleDateString(undefined, { month: "short" }),
        value: secs / 3600,
        key,
      }));
  }, [entries]);

  const byProject = React.useMemo(() => {
    const m = new Map<string, TimeEntry[]>();
    for (const e of entries as TimeEntry[]) {
      const l = m.get(e.projectId); if (l) l.push(e); else m.set(e.projectId, [e]);
    }
    return m;
  }, [entries]);

  // The bootstrap fetch has to finish before "not found" is the truth.
  if (!client && !ready) {
    return (
      <PageBody className="pt-10">
        <div className="flex items-center gap-2 text-base text-ink-secondary"><Spinner className="size-4" />Loading the client…</div>
      </PageBody>
    );
  }

  if (!client) {
    return (
      <PageBody className="pt-10">
        <EmptyState title="Client not found." action={<Button onClick={() => router.push("/clients")}>Back to clients</Button>}>
          It may have been deleted, or the link may be wrong.
        </EmptyState>
      </PageBody>
    );
  }

  const primary = client.contacts.find((c) => c.isPrimary) ?? client.contacts[0];

  return (
    <>
      <PageHeader
        breadcrumb={[{ label: "Clients", href: "/clients" }]}
        title={client.name}
        badge={client.archivedAt ? <Badge variant="neutral">Archived</Badge> : undefined}
        actions={
          <>
            {can("client:manage") && (
              <Button variant="secondary" onClick={() => router.push(`/clients/${client.id}/edit`)}>
                <Pencil className="size-3.5" />Edit client
              </Button>
            )}
            <Menu trigger={<Button variant="secondary">Actions</Button>}>
              <MenuItem onSelect={() => router.push("/projects/new")}>New project</MenuItem>
              <MenuItem onSelect={() => router.push(`/invoices/new?client=${client.id}`)}>New invoice</MenuItem>
              <MenuItem disabled>Email statement (needs email delivery)</MenuItem>
              <MenuItem
                danger
                disabled={!can("client:manage") || archive.isPending || !!client.archivedAt}
                onSelect={() => archive.mutate()}
              >
                Archive client
              </MenuItem>
            </Menu>
          </>
        }
      />

      <PageBody className="pt-4">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <Kpi label="Total hours" value={formatDuration(stats.seconds)}>
            <div className="mt-2 flex flex-col gap-1">
              <KpiRow label="Billable" value={formatDuration(stats.billableSeconds)} />
              <KpiRow label="Non-billable" value={formatDuration(stats.seconds - stats.billableSeconds)} />
              <Meter
                className="mt-1"
                segments={[
                  { value: stats.seconds ? stats.billableSeconds / stats.seconds : 0, tone: "billable" },
                  { value: stats.seconds ? 1 - stats.billableSeconds / stats.seconds : 0, tone: "nonBillable" },
                ]}
              />
            </div>
          </Kpi>

          <Kpi label="Uninvoiced" value={formatMoney(stats.uninvoiced)}>
            <div className="mt-2">
              {can("invoice:manage") ? (
                <Link href={`/invoices/new?client=${client.id}`} className="text-base text-accent hover:underline">New invoice</Link>
              ) : (
                <span className="text-base text-ink-tertiary">Billable time not yet on an invoice</span>
              )}
            </div>
          </Kpi>

          <Kpi label="Outstanding" value={formatMoney(stats.outstanding)} danger={stats.overdue > 0}>
            <div className="mt-2 text-base text-ink-secondary">
              {stats.overdue > 0
                ? `${stats.overdue} ${stats.overdue === 1 ? "invoice is" : "invoices are"} past due`
                : "Nothing past due"}
            </div>
          </Kpi>

          <Kpi label="Paid to date" value={formatMoney(stats.paid)}>
            <div className="mt-2 flex flex-col gap-1">
              <KpiRow label="Invoices" value={String(clientInvoices.length)} />
              <KpiRow label="Payment terms" value={client.paymentTerm.replace("_", " ").replace("net ", "Net ")} />
            </div>
          </Kpi>
        </div>

        {monthly.length > 1 && (
          <Card className="mt-4">
            <SectionTitle>Hours per month</SectionTitle>
            <BarChart
              data={monthly}
              height={190}
              ariaLabel={`Hours tracked per month for ${client.name}`}
              format={(v) => (v >= 1 ? `${Math.round(v)}h` : "0")}
              tipRows={(p) => ({
                title: p.label,
                rows: [{ color: "var(--viz-1)", label: "Hours", value: p.value.toFixed(2) }],
              })}
            />
          </Card>
        )}

        <div className="mt-5">
          <Tabs
            value={tab}
            onValueChange={setTab}
            tabs={[
              { value: "projects", label: `Projects (${clientProjects.length})` },
              { value: "invoices", label: `Invoices (${clientInvoices.length})` },
              { value: "contacts", label: `Contacts (${client.contacts.length})` },
            ]}
          />
        </div>

        {tab === "projects" && (
          <Card className="mt-3" padded={false}>
            {clientProjects.length === 0 ? (
              <div className="p-4">
                <EmptyState title="No projects yet." action={<Button variant="primary" onClick={() => router.push("/projects/new")}>New project</Button>}>
                  Create a project before anyone can track time to this client.
                </EmptyState>
              </div>
            ) : (
              <>
                <div className="flex items-center border-b border-border bg-bg-muted px-4 py-2 text-xs font-semibold uppercase tracking-[0.04em] text-ink-tertiary">
                  <span className="flex-1">Project</span>
                  <span className="w-24 text-right">Hours</span>
                  <span className="w-44 text-right">Budget</span>
                  <span className="w-32 text-right">Uninvoiced</span>
                </div>
                {clientProjects.map((p) => {
                  const mine = byProject.get(p.id) ?? [];
                  const b = projectBudget(p, mine);
                  const seconds = mine.reduce((a, e) => a + e.durationSeconds, 0);
                  const uninvoiced = mine.reduce(
                    (a, e) => a + (e.isBillable && !e.invoiceId && !e.billedExternally ? e.durationSeconds * (e.billableRateCents ?? 0) : 0), 0
                  ) / 3600  /* summed as products, divided once */;
                  return (
                    <Link
                      key={p.id}
                      href={`/projects/${p.id}`}
                      className="flex items-center border-b border-border px-4 py-2.5 text-base last:border-b-0 hover:bg-surface-hover"
                    >
                      <span className="flex min-w-0 flex-1 items-center gap-2">
                        <span className="truncate font-medium text-ink">{p.name}</span>
                        {p.archivedAt && <Badge variant="neutral">Archived</Badge>}
                      </span>
                      <span className="w-24 text-right tabular-nums">{formatDuration(seconds)}</span>
                      <span className="flex w-44 items-center justify-end gap-2">
                        {b.percentUsed == null ? (
                          <span className="text-ink-tertiary">No budget</span>
                        ) : (
                          <>
                            <span className="tly-meter w-20">
                              <Meter segments={[{ value: Math.min(b.percentUsed, 1), tone: b.percentUsed > 0.8 ? "near" : "ok" }]} />
                            </span>
                            <span className={cn("w-10 text-right tabular-nums", b.percentUsed > 1 && "text-danger")}>
                              {formatPercent(b.percentUsed)}
                            </span>
                          </>
                        )}
                      </span>
                      <span className="w-32 text-right tabular-nums">{formatMoneyShort(uninvoiced)}</span>
                    </Link>
                  );
                })}
              </>
            )}
          </Card>
        )}

        {tab === "invoices" && (
          <Card className="mt-3" padded={false}>
            {clientInvoices.length === 0 ? (
              <div className="p-4">
                <EmptyState title="No invoices yet.">Billable time will show up here once you invoice it.</EmptyState>
              </div>
            ) : (
              <>
                <div className="flex items-center border-b border-border bg-bg-muted px-4 py-2 text-xs font-semibold uppercase tracking-[0.04em] text-ink-tertiary">
                  <span className="w-28">Number</span>
                  <span className="flex-1">Subject</span>
                  <span className="w-28">Issued</span>
                  <span className="w-28">Due</span>
                  <span className="w-32 text-right">Amount</span>
                  <span className="w-28 text-right">Balance</span>
                  <span className="w-28 pl-3">Status</span>
                </div>
                {clientInvoices.map((i) => (
                  <Link
                    key={i.id}
                    href={`/invoices/${i.id}`}
                    className="flex items-center border-b border-border px-4 py-2.5 text-base last:border-b-0 hover:bg-surface-hover"
                  >
                    <span className="w-28 font-medium text-ink tabular-nums">{i.number}</span>
                    <span className="min-w-0 flex-1 truncate text-ink-secondary">{i.subject ?? "Services rendered"}</span>
                    <span className="w-28 tabular-nums text-ink-secondary">{formatDateUS(i.issueDate)}</span>
                    <span className="w-28 tabular-nums text-ink-secondary">{formatDateUS(i.dueDate)}</span>
                    <span className="w-32 text-right tabular-nums">{formatMoney(i.totalCents)}</span>
                    <span className={cn("w-28 text-right tabular-nums", i.state === "late" && "font-medium text-danger")}>
                      {formatMoney(i.totalCents - i.paidCents)}
                    </span>
                    <span className="w-28 pl-3"><InvoiceBadge state={i.state} /></span>
                  </Link>
                ))}
              </>
            )}
          </Card>
        )}

        {tab === "contacts" && (
          <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {client.contacts.length === 0 && (
              <Card className="md:col-span-2 xl:col-span-3">
                <EmptyState
                  title="No contacts yet."
                  action={can("client:manage") && (
                    <Button variant="primary" onClick={() => router.push(`/clients/${client.id}/edit`)}>
                      <Plus className="size-4" />Add contact
                    </Button>
                  )}
                >
                  Invoices need at least one recipient.
                </EmptyState>
              </Card>
            )}
            {client.contacts.map((c) => (
              <Card key={c.id} className="flex gap-3">
                <Avatar user={{ id: c.id, firstName: c.firstName, lastName: c.lastName }} size="lg" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium text-ink">{c.firstName} {c.lastName}</span>
                    {(c.isPrimary || c === primary) && <Badge variant="info">Primary</Badge>}
                  </div>
                  {c.title && <div className="truncate text-base text-ink-secondary">{c.title}</div>}
                  <div className="mt-2 flex flex-col gap-1 text-base">
                    {c.email && (
                      <a href={`mailto:${c.email}`} className="flex items-center gap-1.5 text-accent hover:underline">
                        <Mail className="size-3.5 shrink-0" aria-hidden /><span className="truncate">{c.email}</span>
                      </a>
                    )}
                    {c.phone && (
                      <span className="flex items-center gap-1.5 text-ink-secondary">
                        <Phone className="size-3.5 shrink-0" aria-hidden />{c.phone}
                      </span>
                    )}
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </PageBody>
    </>
  );
}
