"use client";

/**
 * Invoice configuration.
 *
 * Two panes: a left nav of sections, a form on the right. Seven sections, which
 * is Harvest's list without E-invoicing, ruled out by PRD-OVERVIEW section 4.2.
 *
 * **Every section here changes an invoice.** That is not a given: the four jsonb
 * columns behind these forms were stored, editable and consulted by nothing
 * before TALLY-33, which is a settings page that saves happily and keeps no
 * promise. The one section that cannot yet keep its promise, Messages, says so
 * on the screen rather than implying the mail goes out.
 *
 * Saving is per section, which is why the service takes a section rather than a
 * whole object: two people editing different sections cannot overwrite each
 * other, and the audit row says which part changed.
 */

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import * as api from "@/lib/api";
import { cn } from "@/lib/cn";
import {
  CONFIG_SECTIONS, FIELD_LABELS, MESSAGE_TOKENS, ROUNDING_MINUTES,
  isConfigSection, renderLabel, type ConfigSection,
} from "@/domain/invoice-config";
import {
  Badge, Button, Card, Checkbox, Field, Input, Select, Spinner, Textarea,
} from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { PageBody, PageHeader } from "@/components/app/page-chrome";
import { SectionTitle } from "@/components/app/kpi";
import { useCan } from "@/components/app/providers";

export function ConfigureClient() {
  const router = useRouter();
  const search = useSearchParams();
  const raw = search.get("section") ?? "company";
  const section: ConfigSection = isConfigSection(raw) ? raw : "company";

  const can = useCan();
  const readOnly = !can("settings:manage");

  const { data: config, isLoading } = useQuery({
    queryKey: ["invoice-config"],
    queryFn: api.getInvoiceConfig,
  });

  return (
    <>
      <PageHeader
        breadcrumb={[{ label: "Invoices", href: "/invoices" }]}
        title="Invoice configuration"
      />

      <PageBody className="max-w-[1100px] pt-4">
        <div className="grid gap-5 lg:grid-cols-[280px_1fr]">
          <nav aria-label="Configuration sections" className="flex flex-col gap-0.5">
            {CONFIG_SECTIONS.map((s) => (
              <button
                key={s.key}
                type="button"
                onClick={() => router.replace(`/invoices/configure?section=${s.key}`)}
                aria-current={s.key === section ? "page" : undefined}
                className={cn(
                  "rounded-md px-3 py-2 text-left text-base transition-colors",
                  s.key === section
                    ? "bg-bg-muted font-medium text-ink"
                    : "text-ink-secondary hover:bg-bg-muted hover:text-ink"
                )}
              >
                {s.name}
              </button>
            ))}
          </nav>

          <div>
            {isLoading || !config ? (
              <Card>
                <div className="flex items-center gap-2 py-4 text-base text-ink-secondary">
                  <Spinner className="size-4" />
                  Loading the configuration…
                </div>
              </Card>
            ) : (
              <SectionForm section={section} config={config} readOnly={readOnly} />
            )}
          </div>
        </div>
      </PageBody>
    </>
  );
}

function SectionForm({
  section,
  config,
  readOnly,
}: {
  section: ConfigSection;
  config: api.InvoiceConfig;
  readOnly: boolean;
}) {
  switch (section) {
    case "company":
      return <CompanySection config={config} readOnly={readOnly} />;
    case "defaults":
      return <DefaultsSection config={config} readOnly={readOnly} />;
    case "numbering":
      return <NumberingSection config={config} readOnly={readOnly} />;
    case "appearance":
      return <AppearanceSection config={config} readOnly={readOnly} />;
    case "messages":
      return <MessagesSection config={config} readOnly={readOnly} />;
    case "labels":
      return <LabelsSection config={config} readOnly={readOnly} />;
    case "item-types":
      return <ItemTypesSection readOnly={readOnly} />;
  }
}

/**
 * One save button per section, and it stays disabled until something changes.
 *
 * The mutation invalidates the bootstrap as well as the config, because the
 * invoice document reads labels and appearance from the bootstrap: without that
 * the settings screen would show the new value and the invoice would not.
 */
function useSaveSection(section: ConfigSection) {
  const qc = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: (value: Record<string, unknown>) =>
      api.updateInvoiceConfig({ section, value } as api.InvoiceConfigPatch),
    onSuccess: () => {
      toast.push({ tone: "success", title: "Saved." });
      qc.invalidateQueries({ queryKey: ["invoice-config"] });
      qc.invalidateQueries({ queryKey: ["bootstrap"] });
      qc.invalidateQueries({ queryKey: ["invoice"] });
    },
    onError: (e: unknown) =>
      toast.push({
        tone: "danger",
        title: e instanceof Error ? `Could not save. ${e.message}` : "Could not save.",
      }),
  });
}

function SaveBar({
  save,
  dirty,
  readOnly,
}: {
  save: ReturnType<typeof useSaveSection>;
  dirty: boolean;
  onSave?: never;
  readOnly: boolean;
}) {
  if (readOnly) {
    return (
      <p className="mt-4 text-base text-ink-tertiary">
        You can see this configuration but not change it.
      </p>
    );
  }
  return (
    <div className="mt-4 flex justify-end">
      <Button variant="primary" disabled={!dirty} loading={save.isPending} type="submit">
        Save changes
      </Button>
    </div>
  );
}

/* --------------------------------------------------------------- company */

function CompanySection({ config, readOnly }: { config: api.InvoiceConfig; readOnly: boolean }) {
  const save = useSaveSection("company");
  const [form, setForm] = React.useState({
    name: config.company.name,
    address: config.company.address ?? "",
    taxId: config.company.taxId ?? "",
  });

  const dirty =
    form.name !== config.company.name ||
    form.address !== (config.company.address ?? "") ||
    form.taxId !== (config.company.taxId ?? "");

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(form);
      }}
    >
      <Card>
        <SectionTitle>Company information</SectionTitle>
        <p className="mb-4 text-base text-ink-secondary">
          This appears at the top of every invoice, including ones that already exist.
        </p>

        <div className="flex flex-col gap-4">
          <Field label="Company name" required>
            <Input
              disabled={readOnly}
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </Field>
          <Field label="Address">
            <Textarea
              rows={4}
              disabled={readOnly}
              value={form.address}
              onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
            />
          </Field>
          <Field label="Tax ID" help="Printed under the address when it is set.">
            <Input
              disabled={readOnly}
              value={form.taxId}
              onChange={(e) => setForm((f) => ({ ...f, taxId: e.target.value }))}
            />
          </Field>
        </div>

        <SaveBar save={save} dirty={dirty} readOnly={readOnly} />
      </Card>
    </form>
  );
}

/* -------------------------------------------------------------- defaults */

function DefaultsSection({ config, readOnly }: { config: api.InvoiceConfig; readOnly: boolean }) {
  const save = useSaveSection("defaults");
  const [form, setForm] = React.useState({
    roundingMinutes: config.rounding.minutes,
    roundingMode: config.rounding.mode,
    showTotalHours: config.defaults.showTotalHours,
    paymentTermDays: String(config.defaults.paymentTermDays),
    subject: config.defaults.subject,
    notes: config.defaults.notes,
  });

  const dirty =
    form.roundingMinutes !== config.rounding.minutes ||
    form.roundingMode !== config.rounding.mode ||
    form.showTotalHours !== config.defaults.showTotalHours ||
    Number(form.paymentTermDays) !== config.defaults.paymentTermDays ||
    form.subject !== config.defaults.subject ||
    form.notes !== config.defaults.notes;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate({ ...form, paymentTermDays: Number(form.paymentTermDays) || 0 });
      }}
    >
      <Card>
        <SectionTitle>Default values</SectionTitle>
        <p className="mb-4 text-base text-ink-secondary">
          What a new invoice starts with. Changing these never rewrites an invoice that
          already exists.
        </p>

        <div className="grid gap-4 lg:grid-cols-2">
          <Field
            label="Time rounding"
            help="Controls rounding in summary time reports and invoices. Time is never rounded in detailed time reports or timesheets."
          >
            <Select
              disabled={readOnly}
              value={String(form.roundingMinutes)}
              onChange={(e) =>
                setForm((f) => ({ ...f, roundingMinutes: Number(e.target.value) }))
              }
            >
              {ROUNDING_MINUTES.map((m) => (
                <option key={m} value={m}>
                  {m === 0 ? "No rounding" : `Nearest ${m} minute${m === 1 ? "" : "s"}`}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Rounding direction" help="Applied to the total of each invoice line, never to a single entry.">
            <Select
              disabled={readOnly || form.roundingMinutes === 0}
              value={form.roundingMode}
              onChange={(e) => setForm((f) => ({ ...f, roundingMode: e.target.value }))}
            >
              <option value="nearest">Nearest</option>
              <option value="up">Up</option>
              <option value="down">Down</option>
            </Select>
          </Field>

          <Field
            label="Payment terms"
            help="Days after issue an invoice is due. A client with its own terms keeps them; this is only the fallback."
          >
            <Input
              inputMode="numeric"
              disabled={readOnly}
              value={form.paymentTermDays}
              onChange={(e) => setForm((f) => ({ ...f, paymentTermDays: e.target.value }))}
            />
          </Field>

          <Field label="Total hours">
            <label className="flex items-center gap-2 text-base text-ink">
              <Checkbox
                disabled={readOnly}
                checked={form.showTotalHours}
                onCheckedChange={(v) => setForm((f) => ({ ...f, showTotalHours: v }))}
              />
              Show total hours on invoices
            </label>
            <p className="mt-1 text-sm text-ink-tertiary">
              You can adjust this for a specific invoice at any time.
            </p>
          </Field>

          <Field label="Invoice subject" className="lg:col-span-2">
            <Input
              disabled={readOnly}
              value={form.subject}
              onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))}
            />
          </Field>

          <Field
            label="Invoice notes"
            className="lg:col-span-2"
            help="Additional information included below invoice line items, such as payment method, payment terms, or additional tax information."
          >
            <Textarea
              rows={4}
              disabled={readOnly}
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
            />
          </Field>
        </div>

        <SaveBar save={save} dirty={dirty} readOnly={readOnly} />
      </Card>
    </form>
  );
}

/* ------------------------------------------------------------- numbering */

function NumberingSection({ config, readOnly }: { config: api.InvoiceConfig; readOnly: boolean }) {
  const save = useSaveSection("numbering");
  const [pattern, setPattern] = React.useState(config.numbering.pattern);
  const [nextSeq, setNextSeq] = React.useState(String(config.numbering.nextSeq));

  const dirty =
    pattern !== config.numbering.pattern || Number(nextSeq) !== config.numbering.nextSeq;

  const TOKENS = [
    { token: "{seq}", means: "The running number" },
    { token: "{seq:4}", means: "Padded to four digits" },
    { token: "{year}", means: "2026" },
    { token: "{yy}", means: "26" },
    { token: "{month}", means: "08" },
    { token: "{client_code}", means: "A short code from the client name" },
    { token: "{project_code}", means: "A short code from the project" },
  ];

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate({ pattern, nextSeq: Number(nextSeq) || 1 });
      }}
    >
      <Card>
        <SectionTitle>Invoice numbering</SectionTitle>
        <p className="mb-4 text-base text-ink-secondary">
          What the next invoice is numbered. Existing invoices keep the number they were
          issued with, which is the point of a number.
        </p>

        <div className="grid gap-4 lg:grid-cols-2">
          <Field label="Pattern" required>
            <Input
              disabled={readOnly}
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
            />
          </Field>
          <Field
            label="Next number"
            help="Set this to continue an existing sequence. It cannot move back into a range already issued."
          >
            <Input
              inputMode="numeric"
              disabled={readOnly}
              value={nextSeq}
              onChange={(e) => setNextSeq(e.target.value)}
            />
          </Field>
        </div>

        <div className="mt-4 rounded-md bg-bg-muted px-4 py-3">
          <div className="text-xs font-semibold uppercase tracking-[0.04em] text-ink-tertiary">
            Saved example
          </div>
          <div className="mt-1 font-mono text-base text-ink">{config.numbering.example}</div>
        </div>

        <div className="mt-4">
          <div className="mb-2 text-sm font-medium text-ink-secondary">Tokens</div>
          <div className="flex flex-col gap-1">
            {TOKENS.map((t) => (
              <div key={t.token} className="flex items-baseline gap-3 text-base">
                <code className="w-36 font-mono text-ink">{t.token}</code>
                <span className="text-ink-tertiary">{t.means}</span>
              </div>
            ))}
          </div>
        </div>

        <p className="mt-4 text-sm text-ink-tertiary">
          Invoices brought over from Harvest keep their original ID. Their suffixes were
          hand-written and no pattern reproduces them, so the two styles coexist.
        </p>

        <SaveBar save={save} dirty={dirty} readOnly={readOnly} />
      </Card>
    </form>
  );
}

/* ------------------------------------------------------------ appearance */

function AppearanceSection({ config, readOnly }: { config: api.InvoiceConfig; readOnly: boolean }) {
  const save = useSaveSection("appearance");
  const [form, setForm] = React.useState(config.appearance);

  const dirty = (Object.keys(form) as (keyof typeof form)[]).some(
    (k) => form[k] !== config.appearance[k]
  );

  const COLUMNS = [
    { key: "showItemType", label: "Item type" },
    { key: "showQuantity", label: "Quantity" },
    { key: "showUnitPrice", label: "Unit price" },
    { key: "showProject", label: "Project name" },
  ] as const;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate({ ...form });
      }}
    >
      <Card>
        <SectionTitle>Appearance</SectionTitle>
        <p className="mb-4 text-base text-ink-secondary">
          Which columns the invoice document shows.
        </p>

        <div className="flex flex-col gap-2">
          {COLUMNS.map((c) => (
            <label key={c.key} className="flex items-center gap-2 text-base text-ink">
              <Checkbox
                disabled={readOnly}
                checked={form[c.key]}
                onCheckedChange={(v) => setForm((f) => ({ ...f, [c.key]: v }))}
              />
              {c.label}
            </label>
          ))}
        </div>

        <p className="mt-4 text-sm text-ink-tertiary">
          A logo and a colour need file storage, which is not configured yet. The invoice
          uses the account palette until then.
        </p>

        <SaveBar save={save} dirty={dirty} readOnly={readOnly} />
      </Card>
    </form>
  );
}

/* -------------------------------------------------------------- messages */

function MessagesSection({ config, readOnly }: { config: api.InvoiceConfig; readOnly: boolean }) {
  const save = useSaveSection("messages");
  const [form, setForm] = React.useState<Record<string, string>>({ ...config.messages });

  const dirty = Object.keys(config.messages).some((k) => form[k] !== config.messages[k]);

  const GROUPS = [
    { subject: "sendSubject", body: "sendBody", name: "Sending an invoice" },
    { subject: "reminderSubject", body: "reminderBody", name: "Reminding about one" },
    { subject: "thanksSubject", body: "thanksBody", name: "Thanking for a payment" },
  ];

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(form);
      }}
    >
      <Card>
        <SectionTitle>Messages</SectionTitle>

        {/*
          Said plainly rather than implied. Editing an email nothing sends is a
          reasonable thing to do; believing it goes out is not.
        */}
        <div className="mb-4 rounded-md border border-warning-border bg-warning-subtle px-4 py-3">
          <div className="text-base font-medium text-ink">
            Nothing sends email yet.
          </div>
          <p className="mt-1 text-base text-ink-secondary">
            These are stored and ready, and an invoice marked as sent records the delivery
            as not configured. Mail starts going out when the SendGrid credentials arrive.
          </p>
        </div>

        <div className="flex flex-col gap-5">
          {GROUPS.map((g) => (
            <div key={g.name}>
              <div className="mb-2 text-sm font-semibold text-ink">{g.name}</div>
              <div className="flex flex-col gap-3">
                <Field label="Subject">
                  <Input
                    disabled={readOnly}
                    value={form[g.subject] ?? ""}
                    onChange={(e) => setForm((f) => ({ ...f, [g.subject]: e.target.value }))}
                  />
                </Field>
                <Field label="Body">
                  <Textarea
                    rows={5}
                    disabled={readOnly}
                    value={form[g.body] ?? ""}
                    onChange={(e) => setForm((f) => ({ ...f, [g.body]: e.target.value }))}
                  />
                </Field>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-4">
          <div className="mb-1 text-sm font-medium text-ink-secondary">Tokens</div>
          <div className="flex flex-wrap gap-1.5">
            {MESSAGE_TOKENS.map((t) => (
              <Badge key={t} variant="neutral">{`{{${t}}}`}</Badge>
            ))}
          </div>
        </div>

        <SaveBar save={save} dirty={dirty} readOnly={readOnly} />
      </Card>
    </form>
  );
}

/* ---------------------------------------------------------------- labels */

function LabelsSection({ config, readOnly }: { config: api.InvoiceConfig; readOnly: boolean }) {
  const save = useSaveSection("labels");
  const [form, setForm] = React.useState<Record<string, string>>({ ...config.labels });

  const dirty = FIELD_LABELS.some((f) => form[f.key] !== config.labels[f.key]);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(form);
      }}
    >
      <Card>
        <SectionTitle>Field labels</SectionTitle>
        <p className="mb-4 text-base text-ink-secondary">
          What each part of the invoice is called. Clearing a field puts its default back
          rather than leaving a blank heading.
        </p>

        <div className="grid gap-3 lg:grid-cols-2">
          {FIELD_LABELS.map((field) => (
            <Field key={field.key} label={field.name} help={"hint" in field ? field.hint : undefined}>
              <Input
                disabled={readOnly}
                value={form[field.key] ?? ""}
                placeholder={field.default}
                onChange={(e) => setForm((f) => ({ ...f, [field.key]: e.target.value }))}
              />
            </Field>
          ))}
        </div>

        <div className="mt-4 rounded-md bg-bg-muted px-4 py-3">
          <div className="text-xs font-semibold uppercase tracking-[0.04em] text-ink-tertiary">
            Preview
          </div>
          <div className="mt-1 text-base text-ink">
            A Net 30 client sees{" "}
            <span className="font-medium">
              {renderLabel(form.netDays || "Net {{days}}", { days: 30 })}
            </span>
            , and the total reads{" "}
            <span className="font-medium">{form.amountDue || "Amount Due"}</span>.
          </div>
        </div>

        <SaveBar save={save} dirty={dirty} readOnly={readOnly} />
      </Card>
    </form>
  );
}

/* ------------------------------------------------------------ item types */

function ItemTypesSection({ readOnly }: { readOnly: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [adding, setAdding] = React.useState("");

  const { data: types = [], isLoading } = useQuery({
    queryKey: ["item-types"],
    queryFn: api.listItemTypes,
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["item-types"] });
  const fail = (e: unknown) =>
    toast.push({
      tone: "danger",
      title: e instanceof Error ? e.message : "That did not work.",
    });

  const create = useMutation({
    mutationFn: (name: string) => api.createItemType({ name }),
    onSuccess: () => {
      setAdding("");
      toast.push({ tone: "success", title: "Item type added." });
      refresh();
    },
    onError: fail,
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.removeItemType(id),
    onSuccess: ({ archived }) => {
      toast.push({
        tone: "success",
        title: archived ? "Archived, because invoices use it." : "Item type removed.",
      });
      refresh();
    },
    onError: fail,
  });

  const setDefault = useMutation({
    mutationFn: ({ id, role }: { id: string; role: "expenses" | "services" }) =>
      api.updateItemType(id, {
        [role === "expenses" ? "isDefaultForExpenses" : "isDefaultForServices"]: true,
      }),
    onSuccess: () => {
      toast.push({ tone: "success", title: "Default moved." });
      refresh();
    },
    onError: fail,
  });

  if (isLoading) {
    return (
      <Card>
        <div className="flex items-center gap-2 py-4 text-base text-ink-secondary">
          <Spinner className="size-4" />
          Loading item types…
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <SectionTitle>Item types</SectionTitle>
      <p className="mb-4 text-base text-ink-secondary">
        What kind of thing a line is. One type is the default for expenses and one for
        billable hours, and those two cannot be removed: a line has to be able to say what
        it is.
      </p>

      <div className="flex flex-col">
        {types.map((t) => (
          <div
            key={t.id}
            className="flex items-center gap-3 border-b border-border py-2.5 text-base last:border-b-0"
          >
            <span className="flex-1 font-medium text-ink">
              {t.name}
              {t.archivedAt && <span className="ml-2 text-sm text-ink-tertiary">Archived</span>}
            </span>

            {t.isDefaultForExpenses && <Badge variant="neutral">Default for expenses</Badge>}
            {t.isDefaultForServices && <Badge variant="neutral">Default for billable hours</Badge>}

            <span className="w-24 text-right text-sm text-ink-tertiary">
              {t.usageCount ? `${t.usageCount} line${t.usageCount === 1 ? "" : "s"}` : "Unused"}
            </span>

            {!readOnly && (
              <span className="flex w-[210px] justify-end gap-1">
                {!t.isDefaultForServices && !t.archivedAt && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setDefault.mutate({ id: t.id, role: "services" })}
                  >
                    Make hours default
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove ${t.name}`}
                  disabled={t.isDefaultForExpenses || t.isDefaultForServices}
                  onClick={() => remove.mutate(t.id)}
                >
                  <Trash2 className="size-4" />
                </Button>
              </span>
            )}
          </div>
        ))}
      </div>

      {!readOnly && (
        <form
          className="mt-4 flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (adding.trim()) create.mutate(adding.trim());
          }}
        >
          <Field label="New item type" className="flex-1">
            <Input value={adding} onChange={(e) => setAdding(e.target.value)} placeholder="Retainer" />
          </Field>
          <Button variant="secondary" type="submit" disabled={!adding.trim()} loading={create.isPending}>
            <Plus className="size-4" />
            Add
          </Button>
        </form>
      )}
    </Card>
  );
}
