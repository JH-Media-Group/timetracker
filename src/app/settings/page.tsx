"use client";

/**
 * Settings.
 *
 * A left rail of sections and one panel. Everything here changes behaviour for
 * the whole account, so each control says what it affects rather than just what
 * it is, and the ones with consequences say what happens to existing data.
 */

import * as React from "react";
import Link from "next/link";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Building2, Boxes, Download, KeyRound, Plug, Receipt, SlidersHorizontal, Users,
} from "lucide-react";
import * as api from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatMoney } from "@/lib/format";
import type { Settings } from "@/lib/types";
import {
  Badge, Banner, Button, Card, Checkbox, Dropzone, Field, Input, Segmented, Select,
  Switch, Textarea,
} from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { PageBody, PageHeader, useUrlState } from "@/components/app/page-chrome";
import { SectionTitle } from "@/components/app/kpi";
import { buttonVariants } from "@/components/ui/recipes";
import { useApp, useCan, useTheme } from "@/components/app/providers";

const SECTIONS = [
  { key: "company", label: "Company", icon: Building2 },
  { key: "preferences", label: "Tracking preferences", icon: SlidersHorizontal },
  { key: "modules", label: "Modules", icon: Boxes },
  { key: "people", label: "People", icon: Users },
  { key: "expenses", label: "Expense categories", icon: Receipt },
  { key: "security", label: "Security", icon: KeyRound },
  { key: "data", label: "Import and export", icon: Download },
  { key: "integrations", label: "Integrations", icon: Plug },
] as const;

type SectionKey = (typeof SECTIONS)[number]["key"];

export default function SettingsPage() {
  const { params, set } = useUrlState();
  const can = useCan();
  const section = (params.get("s") as SectionKey) || "company";
  const readOnly = !can("settings:manage");

  return (
    <>
      <PageHeader
        title="Settings"
        badge={readOnly ? <Badge variant="neutral">Read only</Badge> : undefined}
      />
      <PageBody className="pt-4">
        {readOnly && (
          <Banner variant="info" title="You can look, but not change.">
            Changing account settings needs the administrator profile.
          </Banner>
        )}

        <div className="mt-4 grid gap-5 lg:grid-cols-[220px_1fr]">
          <nav aria-label="Settings sections" className="flex flex-row gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
            {SECTIONS.map((s) => {
              const Icon = s.icon;
              const active = s.key === section;
              return (
                <button
                  key={s.key}
                  onClick={() => set({ s: s.key === "company" ? null : s.key })}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex shrink-0 items-center gap-2 rounded-md px-2.5 py-2 text-left text-base transition-colors duration-(--dur-fast)",
                    active ? "bg-surface-selected font-medium text-ink" : "text-ink-secondary hover:bg-surface-hover hover:text-ink"
                  )}
                >
                  <Icon className="size-4 shrink-0" aria-hidden />
                  <span className="truncate">{s.label}</span>
                </button>
              );
            })}
          </nav>

          <div className="min-w-0">
            {section === "company" && <CompanySection readOnly={readOnly} />}
            {section === "preferences" && <PreferencesSection readOnly={readOnly} />}
            {section === "modules" && <ModulesSection readOnly={readOnly} />}
            {section === "people" && <PeopleSection />}
            {section === "expenses" && <ExpenseCategoriesSection readOnly={readOnly} />}
            {section === "security" && <SecuritySection />}
            {section === "data" && <DataSection />}
            {section === "integrations" && <IntegrationsSection />}
          </div>
        </div>
      </PageBody>
    </>
  );
}

/** Shared save plumbing: every section writes the same settings record. */
function useSaveSettings() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (patch: Partial<Settings>) => api.updateSettings(patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bootstrap"] });
      toast.push({ tone: "success", title: "Settings saved." });
    },
  });
}

/* ----------------------------------------------------------------- company */

function CompanySection({ readOnly }: { readOnly: boolean }) {
  const { settings } = useApp();
  const save = useSaveSettings();
  const { theme, setTheme } = useTheme();

  const [form, setForm] = React.useState({
    companyName: settings.companyName ?? "",
    companyAddress: settings.companyAddress ?? "",
    baseCurrency: settings.baseCurrency ?? "USD",
    timezone: settings.timezone ?? "America/New_York",
    weekStartsOn: String(settings.weekStartsOn ?? 1),
  });
  const patch = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <SectionTitle>Company</SectionTitle>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Company name" help="Printed at the top of every invoice.">
            <Input disabled={readOnly} value={form.companyName} onChange={(e) => patch("companyName", e.target.value)} />
          </Field>
          <Field label="Base currency" help="Reports roll up in this currency.">
            <Select disabled={readOnly} value={form.baseCurrency} onChange={(e) => patch("baseCurrency", e.target.value)}>
              {["USD", "EUR", "GBP", "CAD", "AUD"].map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          </Field>
          <Field label="Address" className="md:col-span-2">
            <Textarea disabled={readOnly} rows={4} value={form.companyAddress} onChange={(e) => patch("companyAddress", e.target.value)} />
          </Field>
          <Field label="Time zone" help="The calendar day that a timer belongs to is decided here.">
            <Select disabled={readOnly} value={form.timezone} onChange={(e) => patch("timezone", e.target.value)}>
              {["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Europe/London", "Europe/Bucharest", "Asia/Karachi", "UTC"]
                .map((t) => <option key={t} value={t}>{t}</option>)}
            </Select>
          </Field>
          <Field label="Week starts on" help="Changes every week view and every submission period.">
            <Segmented
              value={form.weekStartsOn}
              onChange={(v) => patch("weekStartsOn", v)}
              options={[{ value: "1", label: "Monday" }, { value: "0", label: "Sunday" }]}
              aria-label="Week starts on"
            />
          </Field>
        </div>

        {!readOnly && (
          <div className="mt-4 flex justify-end">
            <Button
              variant="primary"
              loading={save.isPending}
              onClick={() => save.mutate({
                companyName: form.companyName.trim(),
                companyAddress: form.companyAddress,
                baseCurrency: form.baseCurrency,
                timezone: form.timezone,
                weekStartsOn: Number(form.weekStartsOn) as 0 | 1,
              })}
            >
              Save company
            </Button>
          </div>
        )}
      </Card>

      <Card>
        <SectionTitle>Appearance</SectionTitle>
        <p className="mb-3 text-base text-ink-secondary">
          This one is yours alone. Following the system means Tally switches when your computer does.
        </p>
        <Segmented
          value={theme}
          onChange={setTheme}
          options={[
            { value: "system", label: "Follow system" },
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ]}
          aria-label="Theme"
        />
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------- preferences */

function PreferencesSection({ readOnly }: { readOnly: boolean }) {
  const { settings } = useApp();
  const save = useSaveSettings();

  const [form, setForm] = React.useState({
    timerMode: settings.timerMode ?? "duration",
    timeDisplay: settings.timeDisplay ?? "decimal",
    roundingMinutes: String(settings.roundingMinutes ?? 0),
    requireNotes: settings.requireNotes ?? "never",
    allowFutureDates: settings.allowFutureDates ?? false,
    flagMissing: settings.flagMissingBelowSeconds ? String(settings.flagMissingBelowSeconds / 3600) : "8",
  });
  const patch = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <Card>
      <SectionTitle>Tracking preferences</SectionTitle>
      <div className="flex flex-col gap-5">
        <Field label="How people enter time" help="Start and end times give you a day view with real clock positions. Duration is faster to type.">
          <Segmented
            value={form.timerMode}
            onChange={(v) => patch("timerMode", v as Settings["timerMode"])}
            options={[{ value: "duration", label: "Duration only" }, { value: "start_end", label: "Start and end times" }]}
            aria-label="Timer mode"
          />
        </Field>

        <Field label="How hours are shown" help="Decimal reads 1.50, hours and minutes reads 1:30.">
          <Segmented
            value={form.timeDisplay}
            onChange={(v) => patch("timeDisplay", v as Settings["timeDisplay"])}
            options={[{ value: "decimal", label: "Decimal" }, { value: "hours_minutes", label: "Hours and minutes" }]}
            aria-label="Time display"
          />
        </Field>

        <Field label="Rounding" help="Applied when time is invoiced, never to what people actually tracked.">
          <div className="max-w-[280px]">
            <Select disabled={readOnly} value={form.roundingMinutes} onChange={(e) => patch("roundingMinutes", e.target.value)}>
              <option value="0">No rounding</option>
              <option value="6">Nearest 6 minutes (0.1 h)</option>
              <option value="15">Nearest 15 minutes</option>
              <option value="30">Nearest 30 minutes</option>
              <option value="60">Nearest hour</option>
            </Select>
          </div>
        </Field>

        <Field label="Require notes" help="A note is what makes an entry defensible six months later.">
          <div className="max-w-[280px]">
            <Select disabled={readOnly} value={form.requireNotes} onChange={(e) => patch("requireNotes", e.target.value as Settings["requireNotes"])}>
              <option value="never">Never require notes</option>
              <option value="non_billable">Require on non-billable time</option>
              <option value="always">Require on every entry</option>
            </Select>
          </div>
        </Field>

        <Field label="Flag a day as missing time below" help="Drives the dots on the week strip and the flags on submissions.">
          <div className="flex max-w-[280px] items-center gap-2">
            <Input
              disabled={readOnly} inputMode="decimal" align="right"
              value={form.flagMissing} onChange={(e) => patch("flagMissing", e.target.value)}
            />
            <span className="whitespace-nowrap text-base text-ink-secondary">hours</span>
          </div>
        </Field>

        <label className="flex cursor-pointer items-start gap-3">
          <Switch checked={form.allowFutureDates} onCheckedChange={(v) => patch("allowFutureDates", v)} aria-label="Allow future dates" />
          <span>
            <span className="block text-base text-ink">Allow time on future dates</span>
            <span className="block text-sm text-ink-tertiary">Useful for planned work. Off by default, because it is usually a typo.</span>
          </span>
        </label>
      </div>

      {!readOnly && (
        <div className="mt-5 flex justify-end">
          <Button
            variant="primary"
            loading={save.isPending}
            onClick={() => save.mutate({
              timerMode: form.timerMode,
              timeDisplay: form.timeDisplay,
              roundingMinutes: Number(form.roundingMinutes),
              requireNotes: form.requireNotes,
              allowFutureDates: form.allowFutureDates,
              flagMissingBelowSeconds: Math.round((Number(form.flagMissing) || 0) * 3600),
            })}
          >
            Save preferences
          </Button>
        </div>
      )}
    </Card>
  );
}

/* ----------------------------------------------------------------- modules */

const MODULE_COPY: Record<string, { label: string; help: string }> = {
  time: { label: "Time tracking", help: "The timer, the timesheet, and everything downstream of them." },
  expenses: { label: "Expenses", help: "Receipts, mileage, and reimbursements." },
  approvals: { label: "Approvals", help: "Weekly submission and review. Turning this off unlocks every locked week." },
  team: { label: "Team", help: "Capacity, utilization, and the team report." },
  invoices: { label: "Invoicing", help: "Invoices, payments, recurring schedules, and retainers." },
  reports: { label: "Reports", help: "Time, profitability, team, and invoicing reports." },
};

function ModulesSection({ readOnly }: { readOnly: boolean }) {
  const { settings } = useApp();
  const save = useSaveSettings();
  const modules = settings.modules ?? {};

  return (
    <Card>
      <SectionTitle>Modules</SectionTitle>
      <p className="mb-4 text-base text-ink-secondary">
        Turning a module off hides its pages and its navigation for everyone. Nothing is deleted,
        so turning it back on restores the data exactly as it was.
      </p>
      <div className="flex flex-col gap-4">
        {Object.entries(MODULE_COPY).map(([key, copy]) => (
          <label key={key} className="flex cursor-pointer items-start gap-3">
            <Switch
              checked={modules[key] !== false}
              onCheckedChange={(v) => !readOnly && save.mutate({ modules: { ...modules, [key]: v } })}
              aria-label={copy.label}
            />
            <span>
              <span className="block text-base text-ink">{copy.label}</span>
              <span className="block text-sm text-ink-tertiary">{copy.help}</span>
            </span>
          </label>
        ))}
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ people */

function PeopleSection() {
  const { users } = useApp();
  const active = users.filter((u) => !u.archivedAt);
  const contractors = active.filter((u) => u.employmentType === "contractor").length;

  return (
    <Card>
      <SectionTitle
        action={
          <Link href="/team" className={buttonVariants({ variant: "secondary", size: "sm" })}>
            Open the team page
          </Link>
        }
      >
        People
      </SectionTitle>
      <p className="mb-4 text-base text-ink-secondary">
        {active.length} active {active.length === 1 ? "person" : "people"}, {contractors} of them {contractors === 1 ? "a contractor" : "contractors"}.
        Rates, capacity, and permissions live on each person.
      </p>
      <div className="flex flex-col divide-y divide-border">
        {active.slice(0, 8).map((u) => (
          <Link key={u.id} href={`/team/${u.id}`} className="flex items-center justify-between py-2.5 text-base hover:underline">
            <span className="truncate text-ink">{u.firstName} {u.lastName}</span>
            <span className="shrink-0 text-ink-tertiary">{u.email}</span>
          </Link>
        ))}
      </div>
    </Card>
  );
}

/* -------------------------------------------------------- expense categories */

function ExpenseCategoriesSection({ readOnly }: { readOnly: boolean }) {
  const { expenseCategories } = useApp();
  const toast = useToast();

  return (
    <Card padded={false}>
      <div className="flex items-center justify-between px-4 py-3">
        <div>
          <h2 className="text-md font-semibold text-ink">Expense categories</h2>
          <p className="text-base text-ink-secondary">A unit price turns a category into a quantity, like mileage.</p>
        </div>
        {!readOnly && (
          <Button variant="secondary" size="sm" onClick={() => toast.push({ title: "Category editing arrives with the real backend." })}>
            New category
          </Button>
        )}
      </div>
      <div className="flex items-center border-y border-border bg-bg-muted px-4 py-2 text-xs font-semibold uppercase tracking-[0.04em] text-ink-tertiary">
        <span className="flex-1">Category</span>
        <span className="w-32">Unit</span>
        <span className="w-32 text-right">Unit price</span>
      </div>
      {expenseCategories.map((c) => (
        <div key={c.id} className="flex items-center border-b border-border px-4 py-2.5 text-base last:border-b-0">
          <span className="flex-1 truncate text-ink">{c.name}</span>
          <span className="w-32 text-ink-secondary">{c.unitName ?? "Amount"}</span>
          <span className="w-32 text-right tabular-nums text-ink-secondary">
            {c.unitPriceCents ? formatMoney(c.unitPriceCents) : "By amount"}
          </span>
        </div>
      ))}
    </Card>
  );
}

/* ---------------------------------------------------------------- security */

function SecuritySection() {
  const { me } = useApp();
  const toast = useToast();

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <SectionTitle>Sign in</SectionTitle>
        <p className="text-base text-ink-secondary">
          Tally signs in with your JH Media Group Google account. There are no Tally passwords to
          leak, and removing someone from Google Workspace removes their access here.
        </p>
        <div className="mt-3 flex items-center gap-2">
          <Badge variant="success" dot>Google Workspace</Badge>
          <span className="text-base text-ink-secondary">{me.email}</span>
        </div>
      </Card>

      <Card>
        <SectionTitle>Sessions</SectionTitle>
        <p className="mb-3 text-base text-ink-secondary">
          Sessions last 30 days. Signing everyone out is the fastest response to a lost laptop.
        </p>
        <Button variant="danger-ghost" onClick={() => toast.push({ tone: "danger", title: "Everyone will be asked to sign in again." })}>
          Sign all devices out
        </Button>
      </Card>

      <Card>
        <SectionTitle>Audit log</SectionTitle>
        <p className="text-base text-ink-secondary">
          Every rate change, permission change, deletion, and approval is recorded with who did it
          and when. The log is append only and is kept for seven years.
        </p>
      </Card>
    </div>
  );
}

/* -------------------------------------------------------------------- data */

function DataSection() {
  const toast = useToast();
  const [reset, setReset] = React.useState(false);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <SectionTitle>Export</SectionTitle>
        <p className="mb-3 text-base text-ink-secondary">
          A full export is a zip of CSVs: time, expenses, projects, clients, people, and invoices.
          Large exports are emailed when they are ready.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => toast.push({ title: "Export queued. You will get an email when it is ready." })}>
            Export everything
          </Button>
          <Button variant="ghost" onClick={() => toast.push({ title: "Time export queued." })}>Time only</Button>
          <Button variant="ghost" onClick={() => toast.push({ title: "Invoice export queued." })}>Invoices only</Button>
        </div>
      </Card>

      <Card>
        <SectionTitle>Import</SectionTitle>
        <p className="mb-3 text-base text-ink-secondary">
          Bring in clients, projects, people, or time from a CSV. Every import runs as a preview
          first, so you see exactly what would change before anything is written.
        </p>
        <Dropzone
          label="Drop a CSV, or click to choose"
          hint="Up to 50 MB. Harvest exports are recognised automatically."
          onFiles={(files) => toast.push({ title: `Previewing ${files[0]?.name}. Nothing has been imported yet.` })}
        />
      </Card>

      <Card>
        <SectionTitle>Start over</SectionTitle>
        <p className="mb-3 text-base text-ink-secondary">
          This build runs on sample data held in your browser. Resetting restores the original
          sample set and discards anything you changed while testing.
        </p>
        <label className="mb-3 flex cursor-pointer items-center gap-2.5">
          <Checkbox checked={reset} onCheckedChange={setReset} />
          <span className="text-base text-ink">I understand this discards my test edits.</span>
        </label>
        <Button
          variant="danger"
          disabled={!reset}
          onClick={() => { api.resetDatabase(); window.location.href = "/timesheet"; }}
        >
          Reset the sample data
        </Button>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------ integrations */

const INTEGRATIONS = [
  { name: "Google Calendar", state: "Connected", help: "Pull meetings into the calendar view so they can be turned into entries." },
  { name: "Slack", state: "Connected", help: "Start and stop timers from Slack, and get the Friday reminder there." },
  { name: "QuickBooks", state: "Not connected", help: "Push invoices and payments so nobody re-keys them." },
  { name: "Asana", state: "Not connected", help: "Track time against tasks without leaving Asana." },
];

function IntegrationsSection() {
  const toast = useToast();
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {INTEGRATIONS.map((i) => (
        <Card key={i.name} className="flex flex-col gap-2">
          <div className="flex items-start justify-between gap-2">
            <span className="font-medium text-ink">{i.name}</span>
            <Badge variant={i.state === "Connected" ? "success" : "neutral"} dot={i.state === "Connected"}>{i.state}</Badge>
          </div>
          <p className="flex-1 text-base text-ink-secondary">{i.help}</p>
          <Button
            variant={i.state === "Connected" ? "ghost" : "secondary"}
            size="sm"
            className="self-start"
            onClick={() => toast.push({ title: `${i.name} ${i.state === "Connected" ? "disconnected" : "connected"}.` })}
          >
            {i.state === "Connected" ? "Disconnect" : "Connect"}
          </Button>
        </Card>
      ))}
    </div>
  );
}
