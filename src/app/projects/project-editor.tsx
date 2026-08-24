"use client";

/**
 * Project editor.
 *
 * This form encodes most of the product's business rules, so its layout matters:
 * project type is a set of choice cards because picking wrong has real billing
 * consequences, and the panel beneath changes with the selection so the fields
 * you see are only the ones that apply.
 */

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import * as api from "@/lib/api";
import { cn } from "@/lib/cn";
import type { BillBy, BillingType, BudgetBy, Project } from "@/lib/types";
import {
  Affix, Avatar, Button, Card, Checkbox, ChoiceCard, EmptyState, Field, Input, Select,
  Spinner, Textarea, TokenInput,
} from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { PageBody, PageHeader } from "@/components/app/page-chrome";
import { useApp } from "@/components/app/providers";
import { formatHours, formatMoney, parseMoney } from "@/lib/format";
import { withParam } from "@/lib/return-to";

/**
 * The project has to be loaded before the form mounts. Field state is
 * initialised once from `existing`, so mounting mid-fetch would show a blank
 * form and then save those blanks over a real project.
 */
export function ProjectEditor({ projectId }: { projectId?: string }) {
  const router = useRouter();
  const { projectById, ready } = useApp();
  const existing = projectId ? projectById.get(projectId) : undefined;

  if (projectId && !existing) {
    return (
      <PageBody className="pt-10">
        {ready ? (
          <EmptyState title="Project not found." action={<Button onClick={() => router.push("/projects")}>Back to projects</Button>}>
            It may have been deleted, or the link may be wrong.
          </EmptyState>
        ) : (
          <div className="flex items-center gap-2 text-base text-ink-secondary"><Spinner className="size-4" />Loading the project…</div>
        )}
      </PageBody>
    );
  }

  return <ProjectForm existing={existing} />;
}

const DRAFT_KEY = "tally-project-draft";

/**
 * A form left behind on the way to "Add new client", if there is one.
 *
 * Read once and removed in the same breath, so a draft cannot outlive the trip
 * it was saved for and surprise somebody a week later. Returns an empty object
 * on anything unexpected, which merges into the defaults as nothing.
 */
function restoreDraft(): Record<string, unknown> {
  if (typeof window === "undefined") return {};
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    sessionStorage.removeItem(DRAFT_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function ProjectForm({ existing }: { existing?: Project }) {
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const qc = useQueryClient();
  const toast = useToast();
  const { clients, tasks, users, clientById, taskById, userById } = useApp();

  /*
    The form survives the trip to "Add new client".

    Without this it did not, and the comment on the button claimed otherwise:
    leaving the page unmounts the component, and only `?client=` came back, so
    the name, code, dates, budget, billing type, rates, tags and notes were all
    gone. A reviewer called that out against the very sentence that said the old
    way "used to mean coming back to an empty form".

    Session storage rather than a query string: it is a whole form, it is
    per-tab, it dies with the tab, and none of it should end up in a URL that
    gets pasted somewhere. Read once on mount and cleared immediately, so a
    stale draft cannot resurrect itself on a later visit.
  */
  const [form, setForm] = React.useState(() => ({
    name: existing?.name ?? "",
    /**
     * The client this was started from, when it was started from one.
     *
     * Coming from a client's page and being asked which client this is for is
     * a question the app already knows the answer to (TALLY-43). Falling back
     * to the first client alphabetically is a guess, and a wrong one often
     * enough to be worth not making silently.
     *
     * The parameter beats the existing value on purpose: it is how "Add new
     * client" gets back here with the client it just made selected, and on an
     * edit form the existing value would otherwise win and the round trip
     * would appear to have done nothing. Nothing is saved until Update is
     * pressed, so this changes a default and not a record.
     */
    clientId: search.get("client") ?? existing?.clientId ?? clients[0]?.id ?? "",
    code: existing?.code ?? "",
    startsOn: existing?.startsOn ?? "",
    endsOn: existing?.endsOn ?? "",
    tags: existing?.tags ?? [],
    notes: existing?.notes ?? "",
    billingType: (existing?.billingType ?? "time_and_materials") as BillingType,
    billBy: (existing?.billBy ?? "people") as BillBy,
    hourlyRate: existing?.hourlyRateCents ? String(existing.hourlyRateCents / 100) : "",
    fee: existing?.feeCents ? String(existing.feeCents / 100) : "",
    feeCadence: existing?.feeCadence ?? "single",
    budgetBy: (existing?.budgetBy ?? "none") as BudgetBy,
    budgetValue: existing?.budgetSeconds ? formatHours(existing.budgetSeconds)
      : existing?.budgetFeeCents ? String(existing.budgetFeeCents / 100) : "",
    budgetResetsMonthly: existing?.budgetResetsMonthly ?? false,
    alertOn: existing?.budgetAlertPercent != null,
    alertPercent: String(existing?.budgetAlertPercent ?? 80),
    taskIds: existing?.taskIds ?? tasks.filter((t) => t.isCommon).map((t) => t.id),
    memberIds: existing?.memberIds ?? [],
    managerIds: existing?.managerIds ?? [],
    reportVisibility: "managers",
    ...restoreDraft(),
    /*
      The client that was just created beats whatever the draft remembered.

      The draft is a snapshot from before the trip, so its `clientId` is the old
      one. Spread after it, or coming back from "Add new client" restores the
      form perfectly and silently ignores the client the whole trip was for.
    */
    ...(search.get("client") ? { clientId: search.get("client")! } : {}),
  }));

  const patch = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  /** Keep the half-filled form, then go and make the client it needs. */
  const addClient = () => {
    try {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify(form));
    } catch {
      // A private window, or storage disabled. The trip still works; it just
      // costs the form, which is what it cost before this existed.
    }
    router.push(withParam("/clients/new", "next", pathname));
  };

  const save = useMutation({
    mutationFn: async () => {
      const budgetIsHours = form.budgetBy === "project_hours";
      const value = parseFloat(form.budgetValue);
      const body: Partial<Project> & { name: string; clientId: string } = {
        name: form.name.trim(),
        clientId: form.clientId,
        code: form.code.trim() || undefined,
        startsOn: form.startsOn || undefined,
        endsOn: form.endsOn || undefined,
        tags: form.tags,
        notes: form.notes.trim() || undefined,
        billingType: form.billingType,
        billBy: form.billingType === "non_billable" ? "none" : form.billBy,
        hourlyRateCents: form.billBy === "project" ? (parseMoney(form.hourlyRate) ?? undefined) : undefined,
        feeCents: form.billingType === "fixed_fee" ? (parseMoney(form.fee) ?? undefined) : undefined,
        feeCadence: form.billingType === "fixed_fee" ? (form.feeCadence as "single" | "monthly") : undefined,
        budgetBy: form.budgetBy,
        budgetSeconds: budgetIsHours && !Number.isNaN(value) ? Math.round(value * 3600) : undefined,
        budgetFeeCents: !budgetIsHours && form.budgetBy !== "none" && !Number.isNaN(value) ? Math.round(value * 100) : undefined,
        budgetResetsMonthly: form.budgetResetsMonthly,
        budgetAlertPercent: form.alertOn ? Number(form.alertPercent) : undefined,
        taskIds: form.taskIds,
        memberIds: form.memberIds,
        managerIds: form.managerIds,
      };
      return existing ? api.updateProject(existing.id, body) : api.createProject(body);
    },
    // Awaited, so the detail page we land on already has the record.
    onSuccess: (p) => {
      // Same reason as the client editor: seed the cache, then navigate, then
      // reconcile. See the comment there.
      qc.setQueryData(["bootstrap"], (old: { projects?: Project[] } | undefined) => {
        if (!old?.projects) return old;
        const projects = existing
          ? old.projects.map((x) => (x.id === p.id ? p : x))
          : [p, ...old.projects];
        return { ...old, projects };
      });
      toast.push({ tone: "success", title: existing ? "Project updated." : "Project created." });
      router.push(`/projects/${p.id}`);
      qc.invalidateQueries({ queryKey: ["bootstrap"] });
    },
  });

  const budgetUnit = form.budgetBy === "project_hours" ? "hours" : "$";
  const canSave = form.name.trim().length > 0 && !!form.clientId;

  return (
    <>
      <PageHeader
        breadcrumb={[{ label: "Projects", href: "/projects" }]}
        title={existing ? "Edit project" : "New project"}
        actions={
          <>
            <Button variant="ghost" onClick={() => router.back()}>Cancel</Button>
            <Button variant="primary" disabled={!canSave} loading={save.isPending} onClick={() => save.mutate()}>
              {existing ? "Update project" : "Create project"}
            </Button>
          </>
        }
      />

      <PageBody className="max-w-[1100px] pt-5">
        <div className="flex flex-col gap-4">
          {/* Identity */}
          <Card>
            <h2 className="mb-4 text-md font-semibold text-ink">Identity</h2>
            <div className="grid gap-4 lg:grid-cols-2">
              <Field
                label="Client"
                required
                /*
                  The client you need may not exist yet, and finding that out
                  here used to mean abandoning the form, navigating to Clients,
                  making one, and coming back to an empty form.

                  `next` brings you back to this page with the new client
                  chosen, and the draft above brings the rest of the form with
                  you. The first version of this comment claimed the second half
                  while doing only the first, which a reviewer noticed.
                */
                /*
                  A plain button rather than `Button size="sm"`. That is `h-7`,
                  and `h-11` on a touch screen, either of which makes this
                  field's label row taller than its grid neighbour's and leaves
                  the two inputs out of line by ten pixels. A reviewer measured
                  it. This sits at label height and grows nothing.
                */
                action={
                  <button
                    type="button"
                    onClick={addClient}
                    className="flex items-center gap-1 text-sm font-medium text-accent hover:underline"
                  >
                    <Plus className="size-3" aria-hidden />Add new client
                  </button>
                }
              >
                <Select value={form.clientId} onChange={(e) => patch("clientId", e.target.value)}>
                  {[...clients].sort((a, b) => a.name.localeCompare(b.name)).map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Project name" required>
                <Input value={form.name} onChange={(e) => patch("name", e.target.value)} placeholder="e.g. Website rebuild" />
              </Field>
              <Field label="Project code" help="Optional. Numbers or letters; helps identify the project.">
                <Input value={form.code} onChange={(e) => patch("code", e.target.value)} placeholder="Optional" />
              </Field>
              <Field label="Dates" help="Optional. Time can still be tracked outside this range.">
                <div className="flex items-center gap-2">
                  <Input type="date" value={form.startsOn} onChange={(e) => patch("startsOn", e.target.value)} />
                  <span className="text-ink-tertiary">to</span>
                  <Input type="date" value={form.endsOn} onChange={(e) => patch("endsOn", e.target.value)} />
                </div>
              </Field>
              <Field label="Tags" className="lg:col-span-2">
                <TokenInput values={form.tags} onChange={(v) => patch("tags", v)} placeholder="Add a tag…" />
              </Field>
              <Field label="Notes" className="lg:col-span-2" help="Visible to administrators and people who manage this project.">
                <Textarea value={form.notes} onChange={(e) => patch("notes", e.target.value)} rows={3} />
              </Field>
            </div>
          </Card>

          {/* Project type */}
          <Card>
            <h2 className="mb-1 text-md font-semibold text-ink">Project type</h2>
            <p className="mb-4 text-base text-ink-secondary">How this project is billed. Picking wrong changes what the reports say about it.</p>
            <div className="grid gap-3 md:grid-cols-3">
              <ChoiceCard title="Time & Materials" description="Bill by the hour, with billable rates"
                selected={form.billingType === "time_and_materials"} onClick={() => patch("billingType", "time_and_materials")} />
              <ChoiceCard title="Fixed Fee" description="Bill a set price regardless of time tracked"
                selected={form.billingType === "fixed_fee"} onClick={() => patch("billingType", "fixed_fee")} />
              <ChoiceCard title="Non-Billable" description="Not billed to a client"
                selected={form.billingType === "non_billable"} onClick={() => patch("billingType", "non_billable")} />
            </div>

            <div className="mt-4 rounded-lg border border-live-border bg-live-bg p-4">
              {form.billingType === "time_and_materials" && (
                <div className="grid gap-4 lg:grid-cols-2">
                  <Field label="Billable rates" help="Where the hourly rate comes from.">
                    <Select value={form.billBy} onChange={(e) => patch("billBy", e.target.value as BillBy)}>
                      <option value="people">Person hourly rate</option>
                      <option value="tasks">Task hourly rate</option>
                      <option value="project">Project hourly rate</option>
                      <option value="none">No billable rate</option>
                    </Select>
                  </Field>
                  {form.billBy === "project" && (
                    <Field label="Project hourly rate">
                      <Affix prefix="$" suffix="per hour">
                        <Input align="right" value={form.hourlyRate} onChange={(e) => patch("hourlyRate", e.target.value)} />
                      </Affix>
                    </Field>
                  )}
                </div>
              )}

              {form.billingType === "fixed_fee" && (
                <div className="grid gap-4 lg:grid-cols-2">
                  <Field label="Project fees">
                    <div className="flex items-center gap-2">
                      <Select value={form.feeCadence} onChange={(e) => patch("feeCadence", e.target.value as "single" | "monthly")} className="w-[130px]">
                        <option value="single">Single fee</option>
                        <option value="monthly">Monthly</option>
                      </Select>
                      <Affix prefix="$"><Input align="right" value={form.fee} onChange={(e) => patch("fee", e.target.value)} /></Affix>
                    </div>
                  </Field>
                </div>
              )}

              <div className="mt-4 grid gap-4 lg:grid-cols-2">
                <Field label="Budget" help="Set a budget to track project progress.">
                  <Select value={form.budgetBy} onChange={(e) => patch("budgetBy", e.target.value as BudgetBy)}>
                    <option value="none">No budget</option>
                    <option value="project_hours">Total project hours</option>
                    <option value="project_fees">Total project fees</option>
                  </Select>
                </Field>
                {form.budgetBy !== "none" && (
                  <Field label={`Budget (${budgetUnit})`}>
                    <Affix prefix={form.budgetBy === "project_fees" ? "$" : undefined} suffix={form.budgetBy === "project_hours" ? "hours" : undefined}>
                      <Input align="right" value={form.budgetValue} onChange={(e) => patch("budgetValue", e.target.value)} />
                    </Affix>
                  </Field>
                )}
              </div>

              {form.budgetBy !== "none" && (
                <div className="mt-3 flex flex-col gap-2">
                  <label className="flex items-center gap-2 text-base">
                    <Checkbox checked={form.budgetResetsMonthly} onCheckedChange={(v) => patch("budgetResetsMonthly", v)} />
                    Budget resets every month
                  </label>
                  {/*
                    This said "Send email alerts", which nothing did (TALLY-37).
                    The threshold is real and now colours the budget meter; the
                    email is not, and will not be until TALLY-19. Copy that
                    promises a message nobody receives is worse than copy that
                    describes a colour.
                  */}
                  <label className="flex flex-wrap items-center gap-2 text-base">
                    <Checkbox checked={form.alertOn} onCheckedChange={(v) => patch("alertOn", v)} />
                    Flag this project once it passes
                    <Input className="w-[74px]" align="right" value={form.alertPercent} disabled={!form.alertOn}
                      onChange={(e) => patch("alertPercent", e.target.value)} />
                    % of budget
                  </label>
                  <p className="text-sm text-ink-tertiary">
                    The budget meter turns amber at this point. Nothing is emailed.
                  </p>
                </div>
              )}
            </div>
          </Card>

          {/* Tasks */}
          <Card padded={false}>
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <h2 className="text-md font-semibold text-ink">Tasks</h2>
              <div className="flex items-center gap-2 text-sm text-ink-secondary">
                Select
                <button className="text-link underline" onClick={() => patch("taskIds", tasks.map((t) => t.id))}>All</button>/
                <button className="text-link underline" onClick={() => patch("taskIds", [])}>None</button>
              </div>
            </div>
            <div className="max-h-[280px] overflow-y-auto">
              {[...tasks].sort((a, b) => a.name.localeCompare(b.name)).map((t) => {
                const on = form.taskIds.includes(t.id);
                return (
                  <label key={t.id} className="flex cursor-pointer items-center gap-3 border-b border-border px-4 py-2 last:border-b-0 hover:bg-surface-hover">
                    <Checkbox checked={on} onCheckedChange={(v) => patch("taskIds", v ? [...form.taskIds, t.id] : form.taskIds.filter((x) => x !== t.id))} />
                    <span className="flex-1">{t.name}</span>
                    {!t.defaultBillable && <span className="text-sm text-ink-tertiary">Non-billable</span>}
                  </label>
                );
              })}
            </div>
          </Card>

          {/* Team */}
          <Card padded={false}>
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <h2 className="text-md font-semibold text-ink">Team</h2>
              <span className="text-sm text-ink-secondary">Tick to assign, star to make a manager</span>
            </div>
            <div className="max-h-[320px] overflow-y-auto">
              {users.filter((u) => !u.archivedAt).map((u) => {
                const assigned = form.memberIds.includes(u.id);
                const manages = form.managerIds.includes(u.id);
                return (
                  <div key={u.id} className="flex items-center gap-3 border-b border-border px-4 py-2 last:border-b-0 hover:bg-surface-hover">
                    <Checkbox checked={assigned} aria-label={`Assign ${u.firstName}`}
                      onCheckedChange={(v) => patch("memberIds", v ? [...form.memberIds, u.id] : form.memberIds.filter((x) => x !== u.id))} />
                    <Avatar user={u} size="sm" />
                    <span className="min-w-0 flex-1 truncate">{u.firstName} {u.lastName}</span>
                    <span className="w-24 text-right text-sm tabular-nums text-ink-secondary">
                      {u.costRateCents ? formatMoney(u.costRateCents) : <span className="text-warning">Missing rate</span>}
                    </span>
                    <label className="flex w-28 items-center justify-end gap-1.5 text-sm text-ink-secondary">
                      <Checkbox checked={manages} aria-label={`${u.firstName} manages this project`}
                        onCheckedChange={(v) => patch("managerIds", v ? [...form.managerIds, u.id] : form.managerIds.filter((x) => x !== u.id))} />
                      Manages
                    </label>
                  </div>
                );
              })}
            </div>
          </Card>
        </div>
      </PageBody>
    </>
  );
}
