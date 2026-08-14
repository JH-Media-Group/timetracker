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
import { useParams, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { CalendarClock, Mail } from "lucide-react";
import * as api from "@/lib/api";
import { cn } from "@/lib/cn";
import { ValueAccumulator } from "@/lib/derive";
import {
  addDays, formatDateUS, formatDuration, formatMoney, formatPercent, isoDate, startOfWeek,
} from "@/lib/format";
import type { TimeEntry } from "@/lib/types";
import {
  Avatar, Badge, Button, Card, EmptyState, Spinner, Meter, Tabs,
} from "@/components/ui/primitives";
import { PageBody, PageHeader, PeriodPicker, usePeriod } from "@/components/app/page-chrome";
import { Kpi, KpiRow, SectionTitle } from "@/components/app/kpi";
import { BarChart, Donut, Legend } from "@/components/app/charts";
import { useApp, useCan } from "@/components/app/providers";
import { PROFILE_LABEL } from "@/lib/labels";

export default function PersonDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { userById, projectById, clientById, taskById, ready } = useApp();
  const can = useCan();
  const person = userById.get(id);
  const { granularity, anchor, period, onChange } = usePeriod("month", ["week", "month", "quarter", "year"]);

  const [tab, setTab] = React.useState("projects");

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

  const recent = React.useMemo(
    () => [...list].sort((a, b) => b.spentOn.localeCompare(a.spentOn)).slice(0, 40),
    [list]
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
            <Button variant="secondary" onClick={() => router.push(`/timesheet?user=${person.id}`)}>
              <CalendarClock className="size-3.5" />View timesheet
            </Button>
            {can("people:manage") && (
              <Button variant="secondary" onClick={() => router.push("/settings?s=people")}>
                Edit person
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
          <Kpi label={`Tracked in ${period.label}`} value={formatDuration(stats.seconds)}>
            <div className="mt-2 flex flex-col gap-1">
              <KpiRow label="Billable" value={formatDuration(stats.billableSeconds)} />
              <KpiRow label="Non-billable" value={formatDuration(stats.seconds - stats.billableSeconds)} />
            </div>
          </Kpi>

          <Kpi label="Utilization" value={formatPercent(stats.util)} danger={stats.util > 1.15}>
            <div className="mt-2 flex flex-col gap-1">
              <Meter segments={
                stats.util > 1
                  ? [{ value: 1 / stats.util, tone: "near" }, { value: Math.min((stats.util - 1) / stats.util, 0.5), tone: "over" }]
                  : [{ value: stats.util, tone: stats.util >= 0.75 ? "ok" : "near" }]
              } />
              <KpiRow label="Capacity" value={`${capacityHours} h / week`} />
            </div>
          </Kpi>

          <Kpi label="Billable share" value={formatPercent(stats.billablePct)}>
            <div className="mt-2">
              <Meter segments={[
                { value: stats.billablePct, tone: "billable" },
                { value: 1 - stats.billablePct, tone: "nonBillable" },
              ]} />
            </div>
          </Kpi>

          {can("rates:view_cost") ? (
            <Kpi label="Cost of time" value={formatMoney(stats.cost)}>
              <div className="mt-2 flex flex-col gap-1">
                <KpiRow label="Cost rate" value={`${formatMoney(person.costRateCents)} / h`} />
                {can("rates:view_billable") && <KpiRow label="Billable rate" value={`${formatMoney(person.billableRateCents)} / h`} />}
              </div>
            </Kpi>
          ) : (
            <Kpi label="Projects" value={String(byProject.length)}>
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
            {recent.length === 0 ? (
              <div className="p-4"><EmptyState title="No time in this period.">Try a wider range.</EmptyState></div>
            ) : (
              <>
                <div className="flex items-center border-b border-border bg-bg-muted px-4 py-2 text-xs font-semibold uppercase tracking-[0.04em] text-ink-tertiary">
                  <span className="w-28">Date</span>
                  <span className="flex-1">Project and task</span>
                  <span className="w-24 text-right">Hours</span>
                </div>
                {recent.map((e) => (
                  <div key={e.id} className="flex items-center border-b border-border px-4 py-2.5 text-base last:border-b-0">
                    <span className="w-28 tabular-nums text-ink-secondary">{formatDateUS(e.spentOn)}</span>
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
              {can("rates:view_billable") && <KpiRow label="Billable rate" value={`${formatMoney(person.billableRateCents)} / hour`} />}
              {can("rates:view_cost") && <KpiRow label="Cost rate" value={`${formatMoney(person.costRateCents)} / hour`} />}
            </div>
          </Card>
        )}
      </PageBody>
    </>
  );
}
