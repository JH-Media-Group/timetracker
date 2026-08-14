"use client";

/**
 * Client editor.
 *
 * Two cards: the billing identity, and the contact list. Contacts are edited in
 * place rather than behind a modal, because adding three people to a new client
 * should not cost three round trips through a dialog.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import * as api from "@/lib/api";
import type { Client, ClientContact } from "@/lib/types";
import {
  Affix, Button, Card, EmptyState, Field, Input, Select, Spinner, Textarea,
} from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { PageBody, PageHeader } from "@/components/app/page-chrome";
import { SectionTitle } from "@/components/app/kpi";
import { useApp } from "@/components/app/providers";

type DraftContact = Omit<ClientContact, "clientId"> & { clientId?: string };

const emptyContact = (): DraftContact => ({
  id: `new-${Math.random().toString(36).slice(2, 8)}`,
  firstName: "", lastName: "", title: "", email: "", phone: "",
});

/**
 * The record has to be in hand before the form mounts: the field state is
 * initialised once from `existing`, so mounting during the bootstrap fetch
 * would leave every input blank and then quietly save those blanks over the
 * real client.
 */
export function ClientEditor({ clientId }: { clientId?: string }) {
  const router = useRouter();
  const { clientById, ready } = useApp();
  const existing = clientId ? clientById.get(clientId) : undefined;

  if (clientId && !existing) {
    return (
      <PageBody className="pt-10">
        {ready ? (
          <EmptyState title="Client not found." action={<Button onClick={() => router.push("/clients")}>Back to clients</Button>}>
            It may have been deleted, or the link may be wrong.
          </EmptyState>
        ) : (
          <div className="flex items-center gap-2 text-base text-ink-secondary"><Spinner className="size-4" />Loading the client…</div>
        )}
      </PageBody>
    );
  }

  return <ClientForm existing={existing} />;
}

function ClientForm({ existing }: { existing?: Client }) {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();

  const [form, setForm] = React.useState(() => ({
    name: existing?.name ?? "",
    address: existing?.address ?? "",
    currency: existing?.currency ?? "USD",
    paymentTerm: existing?.paymentTerm ?? ("net_30" as Client["paymentTerm"]),
    taxPercent: existing?.taxPercent != null ? String(existing.taxPercent) : "",
    discountPercent: existing?.discountPercent != null ? String(existing.discountPercent) : "",
  }));
  const [contacts, setContacts] = React.useState<DraftContact[]>(
    () => (existing?.contacts.length ? existing.contacts : [emptyContact()])
  );

  const patch = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  const patchContact = (id: string, p: Partial<DraftContact>) =>
    setContacts((cs) => cs.map((c) => (c.id === id ? { ...c, ...p } : c)));

  const save = useMutation({
    mutationFn: async () => {
      const kept = contacts
        .filter((c) => c.firstName.trim() || c.lastName.trim() || c.email?.trim())
        .map((c, i) => ({
          ...c,
          clientId: existing?.id ?? "",
          firstName: c.firstName.trim(),
          lastName: c.lastName.trim(),
          isPrimary: i === 0,
        })) as ClientContact[];

      // Null, not undefined. An empty box means "there is no tax rate", and the
      // patch is partial, so undefined would mean "leave the old one alone".
      const body: api.ClientPatch & { name: string } = {
        name: form.name.trim(),
        address: form.address.trim() || null,
        currency: form.currency,
        // A term nobody touched is not re-sent, which is what stops a custom
        // one being flattened into whichever option the select fell back to.
        paymentTerm: form.paymentTerm === existing?.paymentTerm ? undefined : form.paymentTerm,
        taxPercent: form.taxPercent.trim() ? Number(form.taxPercent) : null,
        discountPercent: form.discountPercent.trim() ? Number(form.discountPercent) : null,
        contacts: kept,
      };
      return existing ? api.updateClient(existing.id, body) : api.createClient(body);
    },
    onSuccess: (c) => {
      // Put the record into the cached bootstrap before navigating, so the
      // detail page has it on its first render. Awaiting a refetch instead
      // works, but it makes the redirect wait on six queries, and a new client
      // rendering as "not found" for a beat is exactly what this avoids.
      qc.setQueryData(["bootstrap"], (old: { clients?: Client[] } | undefined) => {
        if (!old?.clients) return old;
        const clients = existing
          ? old.clients.map((x) => (x.id === c.id ? c : x))
          : [c, ...old.clients];
        return { ...old, clients };
      });
      toast.push({ tone: "success", title: existing ? "Client updated." : "Client created." });
      router.push(`/clients/${c.id}`);
      qc.invalidateQueries({ queryKey: ["bootstrap"] });
    },
  });

  const canSave = form.name.trim().length > 0;

  return (
    <>
      <PageHeader
        breadcrumb={[{ label: "Clients", href: "/clients" }]}
        title={existing ? "Edit client" : "New client"}
        actions={
          <>
            <Button variant="ghost" onClick={() => router.back()}>Cancel</Button>
            <Button variant="primary" disabled={!canSave} loading={save.isPending} onClick={() => save.mutate()}>
              {existing ? "Update client" : "Create client"}
            </Button>
          </>
        }
      />

      <PageBody className="max-w-[1000px] pt-5">
        <div className="flex flex-col gap-4">
          <Card>
            <SectionTitle>Identity</SectionTitle>
            <div className="grid gap-4 lg:grid-cols-2">
              <Field label="Client name" required className="lg:col-span-2">
                <Input value={form.name} onChange={(e) => patch("name", e.target.value)} placeholder="Acme Corporation" autoFocus />
              </Field>
              <Field label="Billing address" help="Printed at the top of every invoice." className="lg:col-span-2">
                <Textarea rows={3} value={form.address} onChange={(e) => patch("address", e.target.value)} placeholder={"123 Main Street\nChicago, IL 60601"} />
              </Field>
            </div>
          </Card>

          <Card>
            <SectionTitle>Billing defaults</SectionTitle>
            <div className="grid gap-4 lg:grid-cols-2">
              <Field label="Currency" help="Invoices for this client are issued in this currency.">
                <Select value={form.currency} onChange={(e) => patch("currency", e.target.value)}>
                  {["USD", "EUR", "GBP", "CAD", "AUD"].map((c) => <option key={c} value={c}>{c}</option>)}
                </Select>
              </Field>
              <Field label="Payment terms" help="Sets the due date when an invoice is issued.">
                <Select value={form.paymentTerm} onChange={(e) => patch("paymentTerm", e.target.value as Client["paymentTerm"])}>
                  {existing?.paymentTerm === "custom" && (
                    <option value="custom">
                      Custom{existing.paymentTermDays ? ` (${existing.paymentTermDays} days)` : ""}
                    </option>
                  )}
                  <option value="upon_receipt">Due upon receipt</option>
                  <option value="net_15">Net 15</option>
                  <option value="net_30">Net 30</option>
                  <option value="net_45">Net 45</option>
                  <option value="net_60">Net 60</option>
                </Select>
              </Field>
              <Field label="Default tax" help="Applied to taxable line items. Leave blank for none.">
                <Affix suffix="%">
                  <Input inputMode="decimal" align="right" value={form.taxPercent} onChange={(e) => patch("taxPercent", e.target.value)} placeholder="0" />
                </Affix>
              </Field>
              <Field label="Default discount">
                <Affix suffix="%">
                  <Input inputMode="decimal" align="right" value={form.discountPercent} onChange={(e) => patch("discountPercent", e.target.value)} placeholder="0" />
                </Affix>
              </Field>
            </div>
          </Card>

          <Card>
            <SectionTitle
              action={
                <Button variant="secondary" size="sm" onClick={() => setContacts((cs) => [...cs, emptyContact()])}>
                  <Plus className="size-3.5" />Add contact
                </Button>
              }
            >
              Contacts
            </SectionTitle>
            <p className="mb-3 text-base text-ink-secondary">
              The first contact is the primary recipient for invoices and reminders.
            </p>

            <div className="flex flex-col gap-3">
              {contacts.map((c, i) => (
                <div key={c.id} className="rounded-lg border border-border p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-sm font-medium text-ink-secondary">
                      {i === 0 ? "Primary contact" : `Contact ${i + 1}`}
                    </span>
                    {contacts.length > 1 && (
                      <Button
                        variant="ghost" size="icon-sm" aria-label="Remove contact"
                        onClick={() => setContacts((cs) => cs.filter((x) => x.id !== c.id))}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    )}
                  </div>
                  <div className="grid gap-3 lg:grid-cols-2">
                    <Field label="First name">
                      <Input value={c.firstName} onChange={(e) => patchContact(c.id, { firstName: e.target.value })} />
                    </Field>
                    <Field label="Last name">
                      <Input value={c.lastName} onChange={(e) => patchContact(c.id, { lastName: e.target.value })} />
                    </Field>
                    <Field label="Title">
                      <Input value={c.title ?? ""} onChange={(e) => patchContact(c.id, { title: e.target.value })} placeholder="Marketing Director" />
                    </Field>
                    <Field label="Email">
                      <Input type="email" value={c.email ?? ""} onChange={(e) => patchContact(c.id, { email: e.target.value })} placeholder="name@example.com" />
                    </Field>
                    <Field label="Phone">
                      <Input value={c.phone ?? ""} onChange={(e) => patchContact(c.id, { phone: e.target.value })} placeholder="(312) 555-0100" />
                    </Field>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </PageBody>
    </>
  );
}
