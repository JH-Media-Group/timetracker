"use client";

/**
 * Person detail.
 *
 * Built to answer a manager's three questions in order: are they tracking, is
 * the mix billable enough, and where did the hours go. Rates sit behind the
 * rates capabilities, so the same page is safe to open in front of the person.
 */

import * as React from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CalendarClock, CircleDollarSign, Clock, FolderOpen, Gauge, Mail, Pencil, PieChart } from "lucide-react";
import * as api from "@/lib/api";
import { cn } from "@/lib/cn";
import { ValueAccumulator } from "@/lib/derive";
import {
  addDays, formatClockTime, formatDateUS, formatDuration, formatMoney, formatPercent, isoDate,
  minutesOfDay, startOfWeek,
} from "@/lib/format";
import type { TimeEntry } from "@/lib/types";
import {Avatar, Badge, Button, Card, EmptyState, Spinner, Meter, Tabs, Select,
} from "@/components/ui/primitives";
import { PageBody, PageHeader, PeriodPicker, usePeriod } from "@/components/app/page-chrome";
import { Kpi, KpiHelpLabel, KpiRow, SectionTitle } from "@/components/app/kpi";
import { BarChart, Donut, Legend } from "@/components/app/charts";
import { useApp, useCan } from "@/components/app/providers";
import { RatesPanel } from "@/components/app/rates-panel";
import { PROFILE_LABEL } from "@/lib/labels";
import { useToast } from "@/components/ui/toast";

export default function PersonDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const { userById, projectById, clientById, taskById, settings, ready } = useApp();
  const can = useCan();
  const person = userById.get(id);
  const invite = useMutation({
    mutationFn: () => api.inviteUser(id),
    onSuccess: () => toast.push({
      tone: "success",
      title: `Invitation queued for ${person?.email ?? "that person"}.`,
    }),
    onError: (error) => toast.push({
      tone: "danger",
      title: error instanceof Error ? error.message : "Could not send that invitation.",
    }),
  });
  // Their zone, not the reader's: this is their timesheet. See minutesOfDay.
  const personZone = person?.timezone ?? settings.timezone;
  const { granularity, anchor, period, onChange } = usePeriod("month", ["week", "month", "quarter", "year"]);

  /**
   * Arriving from a project's Tasks tab (TALLY-12).
   *
   * The question being asked at that moment is "what has this person done on
   * this project", so the link carries the project and lands on Recent time
   * already filtered, rather than on their whole history for the reader to
   * narrow again.
   */
  const search = useSearchParams();
  const fromProject = search.get("project") ?? "";
  const [tab, setTab] = React.useState(fromProject ? "entries" : "projects");

  const { data: entries = [] } = useQuery({
    queryKey: ["time", "user", id, period.from, period.to],
    queryFn: () => api.listTimeEntries({ userId: id, from: period.from, to: period.to }),
    enabled: !!id,
  });

  const list = entries as TimeEntry[];

  const stats = React.useMemo(() => {
    let seconds = 0, billableSeconds = 0;
    const costAcc = new ValueAccumulator();
    const revenueAcc = new ValueAccumulator();
    for (const e of list) {
      seconds += e.durationSeconds;
      costAcc.add(e.durationSeconds, e.costRateCents ?? 0);
      if (e.isBillable) {
        billableSeconds += e.durationSeconds;
        revenueAcc.add(e.durationSeconds, e.billableRateCents ?? 0);
      }
    }
    const cost = costAcc.cents;
    const revenue = revenueAcc.cents;
    const days = (new Date(period.to).getTime() - new Date(period.from).getTime()) / 86400000 + 1;
    const capacity = (person?.weeklyCapacitySeconds ?? 0) * (days / 7);
    return {
      seconds, billableSeconds, cost, revenue, capacity,
      util: capacity ? seconds / capacity : 0,
      billablePct: seconds ? billableSeconds / seconds : 0,
    };
  }, [list, period.from, period.to, person]);

  /** Hours per week across the selected period. */
  const weekly = React.useMemo(() => {
    const buckets = new Map<string, number>();
    for (const e of list) {
      const key = isoDate(startOfWeek(new Date(`${e.spentOn}T00:00:00`)));
      buckets.set(key, (buckets.get(key) ?? 0) + e.durationSeconds);
    }
    // Fill the gaps so a quiet week reads as a gap, not as a missing bar.
    const out: { label: string; value: number }[] = [];
    let cursor = startOfWeek(new Date(`${period.from}T00:00:00`));
    const end = new Date(`${period.to}T00:00:00`);
    while (cursor <= end && out.length < 60) {
      const key = isoDate(cursor);
      out.push({
        label: cursor.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
        value: (buckets.get(key) ?? 0) / 3600,
      });
      cursor = addDays(cursor, 7);
    }
    return out;
  }, [list, period.from, period.to]);

  const byProject = React.useMemo(() => {
    const m = new Map<string, { seconds: number; billable: number }>();
    for (const e of list) {
      const cur = m.get(e.projectId) ?? { seconds: 0, billable: 0 };
      cur.seconds += e.durationSeconds;
      if (e.isBillable) cur.billable += e.durationSeconds;
      m.set(e.projectId, cur);
    }
    return [...m.entries()]
      .map(([pid, v]) => ({ project: projectById.get(pid), ...v }))
      .filter((r) => r.project)
      .sort((a, b) => b.seconds - a.seconds);
  }, [list, projectById]);

  /**
   * Recent time, filterable by project (TALLY-16).
   *
   * Forty entries across a dozen projects answers "what have they been doing"
   * and not "what did they do on this one", which is the question somebody
   * actually has when they open a person from a project.
   *
   * The projects offered are the ones this person has actually booked to in the
   * period, so the list never contains a choice that yields nothing.
   */
  const [recentProject, setRecentProject] = React.useState(fromProject);

  const recentProjects = React.useMemo(() => {
    const ids = new Set(list.map((e) => e.projectId));
    return [...ids]
      .map((id) => projectById.get(id))
      .filter((p): p is NonNullable<typeof p> => !!p)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [list, projectById]);

  /**
   * Every segment in the period, newest first (TALLY-16, TALLY-14).
   *
   * The 40-row cap is gone. It was arbitrary, and it made the total below the
   * list a total of "the last 40 things" rather than of the period, which is a
   * figure nobody wants. The period picker above already bounds this.
   *
   * One row per entry is one row per work segment, which is what answers
   * Jason's original question: three hours in one sitting reads differently
   * from ten chunks, and a daily total cannot tell you which happened.
   */
  const recent = React.useMemo(
    () =>
      [...list]
        .filter((e) => !recentProject || e.projectId === recentProject)
        .sort((a, b) => b.spentOn.localeCompare(a.spentOn) || (b.startedAt ?? "").localeCompare(a.startedAt ?? "")),
    [list, recentProject]
  );

  const recentTotal = React.useMemo(
    () => recent.reduce((a, e) => a + e.durationSeconds, 0),
    [recent]
  );

  // The bootstrap fetch has to finish before "not found" is the truth.
  if (!person && !ready) {
    return (
      <PageBody className="pt-10">
        <div className="flex items-center gap-2 text-base text-ink-secondary"><Spinner className="size-4" />Loading…</div>
      </PageBody>
    );
  }

  if (!person) {
    return (
      <PageBody className="pt-10">
        <EmptyState title="Person not found." action={<Button onClick={() => router.push("/team")}>Back to team</Button>}>
          They may have been removed, or the link may be wrong.
        </EmptyState>
      </PageBody>
    );
  }

  const capacityHours = person.weeklyCapacitySeconds / 3600;

  return (
    <>
      <PageHeader
        breadcrumb={[{ label: "Team", href: "/team" }]}
        title={
          <span className="flex items-center gap-3">
            <Avatar user={person} size="lg" />
            {person.firstName} {person.lastName}
          </span>
        }
        badge={
          <span className="flex items-center gap-2">
            {person.isOwner && <Badge variant="info">Owner</Badge>}
            {person.employmentType === "contractor" && <Badge variant="warning">Contractor</Badge>}
            {person.archivedAt && <Badge variant="neutral">Archived</Badge>}
          </span>
        }
        actions={
          <>
            <Button variant="info" onClick={() => router.push(`/timesheet?user=${person.id}`)}>
              <CalendarClock className="size-3.5" />View timesheet
            </Button>
            {can("people:manage") && !person.archivedAt && !person.email.endsWith("@imported.invalid") && (
              <Button variant="success" loading={invite.isPending} onClick={() => invite.mutate()}>
                <Mail className="size-3.5" />Send invite
              </Button>
            )}
            {can("people:manage") && (
              // This used to go to /settings?s=people, from which clicking the
              // person came straight back here, so there was no way to edit
              // anybody at all. TALLY-6.
              <Button variant="secondary" onClick={() => router.push(`/team/${person.id}/edit`)}>
                <Pencil className="size-3.5" />Edit person
              </Button>
            )}
          </>
        }
      />

      <PageBody className="pt-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <PeriodPicker granularity={granularity} anchor={anchor} onChange={onChange} allowed={["week", "month", "quarter", "year"]} />
          <a href={`mailto:${person.email}`} className="flex items-center gap-1.5 text-base text-accent hover:underline">
            <Mail className="size-3.5" aria-hidden />{person.email}
          </a>
        </div>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <Kpi icon={<Clock className="size-4" />} tone="info" label={`Tracked in ${period.label}`} value={formatDuration(stats.seconds)}>
            <div className="mt-2 flex flex-col gap-1">
              <KpiRow label="Billable" value={formatDuration(stats.billableSeconds)} />
              <KpiRow label="Non-billable" value={formatDuration(stats.seconds - stats.billableSeconds)} />
            </div>
          </Kpi>

          <Kpi icon={<Gauge className="size-4" />} tone={stats.util > 1.15 ? "danger" : "success"} label="Utilization" value={formatPercent(stats.util)} danger={stats.util > 1.15}>
            <div className="mt-2 flex flex-col gap-1">
              <Meter segments={
                stats.util > 1
                  ? [{ value: 1 / stats.util, tone: "near" }, { value: Math.min((stats.util - 1) / stats.util, 0.5), tone: "over" }]
                  : [{ value: stats.util, tone: stats.util >= 0.75 ? "ok" : "near" }]
              } />
              <KpiRow label="Capacity" value={`${capacityHours} h / week`} />
            </div>
          </Kpi>

          <Kpi
            icon={<PieChart className="size-4" />}
            tone="billable"
            label={<KpiHelpLabel label="Billable share" help="The percentage of tracked time in this period that is billable to clients." />}
            value={formatPercent(stats.billablePct)}
          >
            <div className="mt-2">
              <Meter segments={[
                { value: stats.billablePct, tone: "billable" },
                { value: 1 - stats.billablePct, tone: "nonBillable" },
              ]} />
            </div>
          </Kpi>

          {can("rates:view_cost") ? (
            <Kpi icon={<CircleDollarSign className="size-4" />} tone="warning" label="Cost of time" value={formatMoney(stats.cost)}>
              <div className="mt-2 flex flex-col gap-1">
                <KpiRow label="Cost rate" value={`${formatMoney(person.costRateCents)} / h`} />
                {can("rates:view_billable") && <KpiRow label="Billable rate" value={`${formatMoney(person.billableRateCents)} / h`} />}
              </div>
            </Kpi>
          ) : (
            <Kpi icon={<FolderOpen className="size-4" />} tone="info" label="Projects" value={String(byProject.length)}>
              <div className="mt-2 flex flex-col gap-1">
                <KpiRow label="Roles" value={person.roles.join(", ") || "None"} />
                <KpiRow label="Permissions" value={PROFILE_LABEL[person.profile]} />
              </div>
            </Kpi>
          )}
        </div>

        <div className="mt-4 grid gap-4 xl:grid-cols-[1fr_320px]">
          <Card>
            <SectionTitle>Hours per week</SectionTitle>
            <BarChart
              data={weekly}
              height={200}
              ariaLabel={`Hours per week for ${person.firstName} ${person.lastName}`}
              format={(v) => (v >= 1 ? `${Math.round(v)}h` : "0")}
              tipRows={(p) => ({
                title: `Week of ${p.label}`,
                rows: [
                  { color: "var(--viz-1)", label: "Tracked", value: `${p.value.toFixed(2)} h` },
                  { label: "Capacity", value: `${capacityHours.toFixed(2)} h` },
                ],
              })}
            />
          </Card>

          <Card className="flex flex-col items-center">
            <SectionTitle>Billable split</SectionTitle>
            <Donut
              segments={[
                { label: "Billable", value: stats.billableSeconds / 3600, color: "var(--billable)" },
                { label: "Non-billable", value: (stats.seconds - stats.billableSeconds) / 3600, color: "var(--non-billable)" },
              ]}
              centerValue={formatPercent(stats.billablePct)}
              centerLabel="billable"
              ariaLabel="Billable versus non-billable hours"
              total={formatDuration(stats.seconds)}
            />
            <Legend
              className="mt-3 justify-center"
              items={[
                { label: "Billable", color: "var(--billable)", value: formatDuration(stats.billableSeconds) },
                { label: "Non-billable", color: "var(--non-billable)", value: formatDuration(stats.seconds - stats.billableSeconds) },
              ]}
            />
          </Card>
        </div>

        <div className="mt-5">
          <Tabs
            value={tab}
            onValueChange={setTab}
            tabs={[
              { value: "projects", label: `Projects (${byProject.length})` },
              { value: "entries", label: "Recent time" },
              { value: "details", label: "Details" },
            ]}
          />
        </div>

        {tab === "projects" && (
          <Card className="mt-3" padded={false}>
            {byProject.length === 0 ? (
              <div className="p-4"><EmptyState title="No time in this period.">Try a wider range.</EmptyState></div>
            ) : (
              <>
                <div className="flex items-center border-b border-border bg-bg-muted px-4 py-2 text-xs font-semibold uppercase tracking-[0.04em] text-ink-tertiary">
                  <span className="flex-1">Project</span>
                  <span className="w-40 text-right">Share</span>
                  <span className="w-24 text-right">Billable</span>
                  <span className="w-24 text-right">Hours</span>
                </div>
                {byProject.map((r) => (
                  <Link
                    key={r.project!.id}
                    href={`/projects/${r.project!.id}`}
                    className="flex items-center border-b border-border px-4 py-2.5 text-base last:border-b-0 hover:bg-surface-hover"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium leading-tight text-ink">{r.project!.name}</span>
                      <span className="block truncate text-sm leading-tight text-ink-tertiary">
                        {clientById.get(r.project!.clientId)?.name}
                      </span>
                    </span>
                    <span className="w-40 pl-4">
                      <Meter segments={[{ value: stats.seconds ? r.seconds / stats.seconds : 0, tone: "ok" }]} />
                    </span>
                    <span className="w-24 text-right tabular-nums text-ink-secondary">{formatDuration(r.billable)}</span>
                    <span className="w-24 text-right font-medium tabular-nums">{formatDuration(r.seconds)}</span>
                  </Link>
                ))}
                <div className="flex items-center border-t border-border-strong px-4 py-2.5 font-semibold">
                  <span className="flex-1">Total</span>
                  <span className="w-40" />
                  <span className="w-24 text-right tabular-nums">{formatDuration(stats.billableSeconds)}</span>
                  <span className="w-24 text-right tabular-nums">{formatDuration(stats.seconds)}</span>
                </div>
              </>
            )}
          </Card>
        )}

        {tab === "entries" && (
          <Card className="mt-3" padded={false}>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
              <Select
                aria-label="Filter recent time by project"
                value={recentProject}
                onChange={(e) => setRecentProject(e.target.value)}
                className="w-[260px]"
              >
                <option value="">All projects</option>
                {recentProjects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </Select>
              <span className="text-sm text-ink-tertiary">
                {recent.length} {recent.length === 1 ? "segment" : "segments"} · {formatDuration(recentTotal, settings.timeDisplay)}
              </span>
            </div>

            {recent.length === 0 ? (
              <div className="p-4">
                <EmptyState title={recentProject ? "No time on that project." : "No time in this period."}>
                  {recentProject ? "Try another project, or a wider range." : "Try a wider range."}
                </EmptyState>
              </div>
            ) : (
              <>
                <div className="flex items-center border-b border-border bg-bg-muted px-4 py-2 text-xs font-semibold uppercase tracking-[0.04em] text-ink-tertiary">
                  <span className="w-28">Date</span>
                  <span className="w-32">Started</span>
                  <span className="w-32">Ended</span>
                  <span className="flex-1">Project and task</span>
                  <span className="w-24 text-right">Hours</span>
                </div>
                {recent.map((e) => (
                  <div key={e.id} className="flex items-center border-b border-border px-4 py-2.5 text-base last:border-b-0">
                    <span className="w-28 tabular-nums text-ink-secondary">{formatDateUS(e.spentOn)}</span>
                    {/*
                      Not every entry has times. An entry typed as "2.5" in
                      duration mode has no start at all, and an imported one may
                      have neither. The no-value glyph the grids use goes here
                      rather than 00:00, which reads as midnight.

                      The times are the subject's, resolved from the stored
                      timestamp the same way the timesheet resolves them, so a
                      late segment does not drift onto the wrong day for a
                      viewer in another timezone.
                    */}
                    <span className="w-32 tabular-nums text-ink-secondary">
                      {e.startedAt ? formatClockTime(minutesOfDay(e.startedAt, personZone)) : <span className="text-ink-tertiary">&mdash;</span>}
                    </span>
                    <span className="w-32 tabular-nums text-ink-secondary">
                      {e.timerStartedAt
                        ? <span className="text-live">running</span>
                        : e.endedAt ? formatClockTime(minutesOfDay(e.endedAt, personZone)) : <span className="text-ink-tertiary">&mdash;</span>}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate leading-tight text-ink">
                        {projectById.get(e.projectId)?.name} <span className="text-ink-tertiary">·</span> {taskById.get(e.taskId)?.name}
                      </span>
                      {e.notes && <span className="block truncate text-sm leading-tight text-ink-tertiary">{e.notes}</span>}
                    </span>
                    <span className={cn("w-24 text-right tabular-nums", !e.isBillable && "text-ink-tertiary")}>
                      {formatDuration(e.durationSeconds)}
                    </span>
                  </div>
                ))}
              </>
            )}
          </Card>
        )}

        {tab === "details" && (
          <>
          <Card className="mt-3">
            <div className="grid gap-x-8 gap-y-3 md:grid-cols-2">
              <KpiRow label="Email" value={person.email} />
              <KpiRow label="Permissions" value={PROFILE_LABEL[person.profile]} />
              <KpiRow label="Employment" value={person.employmentType === "contractor" ? "Contractor" : "Employee"} />
              <KpiRow label="Weekly capacity" value={`${capacityHours} hours`} />
              <KpiRow label="Roles" value={person.roles.join(", ") || "None"} />
              <KpiRow label="Departments" value={person.departments.join(", ") || "None"} />
              <KpiRow label="Time zone" value={person.timezone} />
              <KpiRow label="Started" value={person.startedOn ? formatDateUS(person.startedOn) : "Not recorded"} />
              {/* The rates themselves are in the panel below, which carries
                  their effective dates and what came before. Two displays of
                  one number is how they end up disagreeing: these read the
                  cached bootstrap and the panel reads live. */}
            </div>
          </Card>

            {/* Editable here, not only in the editor.

                A Project Manager holds `rates:manage` and not `people:manage`,
                so the Edit person button never appears for them and the editor,
                where this panel first lived, was unreachable by the one profile
                the split was built for. The panel decides for itself what to
                offer, and the server refuses anything it should not. */}
            <RatesPanel userId={person.id} editable />
          </>
        )}
      </PageBody>
    </>
  );
}
