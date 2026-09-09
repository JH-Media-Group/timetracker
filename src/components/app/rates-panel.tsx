"use client";

/**
 * A person's pay and charge-out rates.
 *
 * Built once and used twice: read-only on the person's page, editable in the
 * person editor. Two copies would drift, and the rules here are the sort that
 * matter when they drift.
 *
 * WHAT THE SERVER DECIDES, AND THIS ONLY REFLECTS
 *
 *   - **Cost rows never arrive** without `rates:view_cost`, so an empty cost
 *     list means either there are none or you may not see them. This does not
 *     claim to know which.
 *   - **Setting a cost rate needs `rates:view_cost` as well as `rates:manage`**,
 *     which is what lets a Project Manager price the work their projects sell
 *     without learning what a colleague is paid.
 *   - **Reach still applies.** A manager may only set rates for the people they
 *     manage, and the API answers 404 for anybody else rather than confirming
 *     they exist.
 *
 * Every control here is a courtesy: hiding a button somebody cannot use is
 * kinder than offering it and refusing. The request is refused either way.
 */

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "@/lib/api";
import { Button, Card, Field, Input, Spinner } from "@/components/ui/primitives";
import { SectionTitle } from "@/components/app/kpi";
import { useApp, useCan } from "@/components/app/providers";
import { useToast } from "@/components/ui/toast";
import { formatMoney, formatMoneyInput, parseMoney } from "@/lib/format";
import { dayIn } from "@/domain/calendar";

/**
 * Today in the **account's** timezone.
 *
 * This read the browser's zone, which is a third notion of "today" in a system
 * that already has two: `rateFor` resolves in UTC and `listUsers` in the
 * Postgres session zone. A rate set from a laptop in Tokyo would take effect a
 * day later than the person setting it meant. `dayIn` exists for exactly this.
 */
function todayIn(timezone: string): string {
  return dayIn(timezone, new Date());
}

function describeRange(rate: api.Rate): string {
  if (!rate.startsOn && !rate.endsOn) return "all time";
  if (rate.startsOn && !rate.endsOn) return `from ${rate.startsOn}`;
  if (!rate.startsOn && rate.endsOn) return `until ${rate.endsOn}`;
  return `${rate.startsOn} to ${rate.endsOn}`;
}

type RateKind = "billable" | "cost";

/**
 * The form accepts plain or grouped decimal dollars. The shared parser is
 * intentionally permissive for imported values, so the form validates the
 * human-facing shape before asking it for cents.
 */
function editableAmount(value: string): number | null {
  const trimmed = value.trim();
  if (!/^(?:\d{1,7}|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(trimmed)) return null;
  return parseMoney(trimmed);
}

function amountFor(rate: api.Rate | null): string {
  return rate ? formatMoneyInput(String(rate.amountCents / 100)) : "";
}

export function RatesPanel({ userId, editable = false, onPendingChange }: {
  userId: string;
  editable?: boolean;
  /**
   * Reports an uncommitted rate edit, so a parent's Save can include it.
   *
   * This card sits on the person editor, which has its own "Save changes" in
   * the page header. That button called `updateUser`, which carries no rates,
   * so somebody who typed a billable and a cost rate and then pressed the
   * obvious Save saved everything except the two numbers they had come to
   * change, and was told the person was updated (t-VFx9pa). The audit trail
   * showed it plainly: two user.update rows that day and not one rate.set.
   *
   * Passing this makes the page's Save mean what it says. The callback must be
   * stable, so wrap it in `useCallback`.
   */
  onPendingChange?: (commit: (() => Promise<void>) | null) => void;
}) {
  const can = useCan();
  const { settings } = useApp();
  const toast = useToast();
  const queryClient = useQueryClient();

  const maySeeAny = can("rates:view_billable");
  const mayEdit = editable && can("rates:manage");
  const mayEditCost = mayEdit && can("rates:view_cost");

  const { data: rates, isLoading, isError } = useQuery({
    queryKey: ["rates", userId],
    queryFn: () => api.listRates(userId),
    enabled: maySeeAny,
  });

  const [draft, setDraft] = React.useState<Record<RateKind, string>>({ billable: "", cost: "" });
  const [dirty, setDirty] = React.useState<Record<RateKind, boolean>>({ billable: false, cost: false });
  const [from, setFrom] = React.useState(() => todayIn(settings.timezone));

  const now = todayIn(settings.timezone);
  const inForce = (kind: RateKind) =>
    (rates ?? []).find(
      (rate) =>
        rate.kind === kind &&
        (!rate.startsOn || rate.startsOn <= now) &&
        (!rate.endsOn || rate.endsOn >= now)
    ) ?? null;

  const current = {
    billable: inForce("billable"),
    cost: inForce("cost"),
  };
  const values = {
    billable: dirty.billable ? draft.billable : amountFor(current.billable),
    cost: dirty.cost ? draft.cost : amountFor(current.cost),
  };
  // Nothing is editable without `rates:manage`. The previous form offered
  // "billable" whenever cost was unavailable, including to somebody who may not
  // edit rates at all, which read as a bug even though the fields render only
  // under `mayEdit`.
  const editableKinds: RateKind[] = !mayEdit ? [] : mayEditCost ? ["billable", "cost"] : ["billable"];
  const changed = editableKinds.flatMap((kind) => {
    if (!dirty[kind]) return [];
    const amountCents = editableAmount(values[kind]);
    if (amountCents == null || amountCents === current[kind]?.amountCents) return [];
    return [{ kind, amountCents }];
  });
  const hasInvalidEdit = editableKinds.some(
    (kind) => dirty[kind] && editableAmount(values[kind]) == null
  );

  const editAmount = (kind: RateKind, value: string) => {
    setDraft((existing) => ({ ...existing, [kind]: value }));
    setDirty((existing) => ({ ...existing, [kind]: true }));
  };

  const save = useMutation({
    mutationFn: async () => {
      const updated: RateKind[] = [];
      for (const change of changed) {
        await api.setRate(userId, { ...change, effectiveFrom: from });
        updated.push(change.kind);
      }
      return updated;
    },
    onSuccess: async (updated) => {
      await queryClient.invalidateQueries({ queryKey: ["rates", userId] });
      // The person's page shows the rate in force, and it just changed.
      await queryClient.invalidateQueries({ queryKey: ["bootstrap"] });
      setDirty((existing) => ({
        ...existing,
        ...Object.fromEntries(updated.map((kind) => [kind, false])),
      }));
      toast.push({
        tone: "success",
        title: updated.length === 2
          ? "Rates updated."
          : `${updated[0] === "cost" ? "Cost" : "Billable"} rate updated.`,
      });
    },
    onError: (error) => {
      queryClient.invalidateQueries({ queryKey: ["rates", userId] });
      toast.push({
        tone: "danger",
        title: error instanceof Error ? error.message : "Could not change that rate.",
      });
    },
  });

  /*
    Hand the parent a way to commit what is typed here but not yet sent.

    Only when there is something valid to send: a null tells the parent there
    is nothing of ours to save, which is also what it gets when this card
    unmounts.
  */
  const pending = changed.length > 0 && !hasInvalidEdit && !!from;
  const commitRef = React.useRef<() => Promise<void>>(async () => {});
  commitRef.current = async () => { await save.mutateAsync(); };

  React.useEffect(() => {
    if (!onPendingChange) return;
    onPendingChange(pending ? () => commitRef.current() : null);
    return () => onPendingChange(null);
  }, [onPendingChange, pending]);

  if (!maySeeAny) return null;

  /*
    In force today, not merely open-ended.

    Picking the row with no end date reported a raise scheduled for next quarter
    as the person's rate, while `/team` (which asks the database for the range
    covering today) showed the real one, and today's actual rate was folded away
    under "Earlier rates". That is the same two-displays-disagreeing problem
    this panel replaced the KpiRows to avoid.
  */
  const scheduled = (rates ?? []).filter((r) => r.startsOn && r.startsOn > now);
  const history = (rates ?? []).filter((r) => r.endsOn && r.endsOn < now);

  return (
    <Card>
      <SectionTitle>Rates</SectionTitle>
      <p className="mb-4 text-sm text-ink-secondary">
        These are the hourly rates in force today. Billable is what the client is charged, and cost is
        what the person is paid. Setting a rate from a date leaves earlier time entries at the rate they
        were written with.
      </p>

      {isLoading ? (
        <Spinner />
      ) : isError ? (
        /*
          Refused, not empty. The rate endpoint answers 404 for somebody outside
          your reach, and rendering the fallback below would state that they
          have no rate, which is a different claim and not one this screen can
          make. The header of this file says an absence and a redaction are
          different facts; without this branch it said it and did not do it.
        */
        <p className="text-sm text-ink-tertiary">
          You cannot see this person&apos;s rates.
        </p>
      ) : (
        <div className="grid gap-3">
          {(["billable", "cost"] as const).map((k) => {
            const rate = current[k];
            const hidden = k === "cost" && !can("rates:view_cost");
            return (
              <div key={k} className="flex items-baseline justify-between gap-4">
                <span className="text-sm text-ink-secondary">
                  {k === "billable" ? "Billable, charged to the client" : "Cost, what they are paid"}
                </span>
                <span className="text-sm font-medium tabular-nums">
                  {hidden ? (
                    // Never "none": an administrator-only figure must not read
                    // as an absence to somebody who simply cannot see it.
                    <span className="text-ink-tertiary">Administrator only</span>
                  ) : rate ? (
                    <>
                      {formatMoney(rate.amountCents, rate.currency)} / hour
                      <span className="ml-2 text-xs font-normal text-ink-tertiary">{describeRange(rate)}</span>
                    </>
                  ) : (
                    <span className="text-ink-tertiary">Not set</span>
                  )}
                </span>
              </div>
            );
          })}

          {scheduled.length > 0 && (
            <div className="mt-1 grid gap-1 border-t border-border pt-2">
              {scheduled.map((r) => (
                <div key={r.id} className="flex justify-between gap-4 text-xs">
                  <span className="text-ink-secondary">
                    Scheduled {r.kind === "cost" ? "cost" : "billable"}
                  </span>
                  <span className="tabular-nums text-ink-secondary">
                    {formatMoney(r.amountCents, r.currency)}{" "}
                    <span className="text-ink-tertiary">{describeRange(r)}</span>
                  </span>
                </div>
              ))}
            </div>
          )}

          {history.length > 0 && (
            <details className="mt-1">
              <summary className="cursor-pointer text-xs text-ink-tertiary">
                Earlier rates ({history.length})
              </summary>
              <div className="mt-2 grid gap-1">
                {history.map((r) => (
                  <div key={r.id} className="flex justify-between gap-4 text-xs text-ink-secondary">
                    <span>{r.kind === "cost" ? "Cost" : "Billable"}</span>
                    <span className="tabular-nums">
                      {formatMoney(r.amountCents, r.currency)} <span className="text-ink-tertiary">{describeRange(r)}</span>
                    </span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      {mayEdit && (
        <div className="mt-4 border-t border-border pt-4">
          <div className={mayEditCost ? "grid gap-3 md:grid-cols-2" : "grid gap-3"}>
            <Field label="Billable rate" help="What the client is charged per hour.">
              <Input
                inputMode="decimal"
                placeholder="150.00"
                value={values.billable}
                onChange={(e) => editAmount("billable", e.target.value)}
                onBlur={(e) => editAmount("billable", formatMoneyInput(e.target.value))}
              />
            </Field>
            {/* A manager may change billable rates without learning pay. The
                server enforces the same boundary even if this field is forged. */}
            {mayEditCost && (
              <Field label="Cost rate" help="What the person is paid per hour.">
                <Input
                  inputMode="decimal"
                  placeholder="60.00"
                  value={values.cost}
                  onChange={(e) => editAmount("cost", e.target.value)}
                  onBlur={(e) => editAmount("cost", formatMoneyInput(e.target.value))}
                />
              </Field>
            )}
          </div>
          <div className="mt-3 grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
            <Field label="From" help="Earlier entries keep the rate they were written with.">
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Button onClick={() => save.mutate()} loading={save.isPending}
              disabled={!from || hasInvalidEdit || changed.length === 0}>
              Set rate
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
