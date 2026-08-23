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
import { Button, Card, Field, Input, Select, Spinner } from "@/components/ui/primitives";
import { SectionTitle } from "@/components/app/kpi";
import { useApp, useCan } from "@/components/app/providers";
import { useToast } from "@/components/ui/toast";
import { formatMoney } from "@/lib/format";
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

export function RatesPanel({ userId, editable = false }: { userId: string; editable?: boolean }) {
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

  const [kind, setKind] = React.useState<"billable" | "cost">("billable");
  const [amount, setAmount] = React.useState("");
  const [from, setFrom] = React.useState(() => todayIn(settings.timezone));

  const save = useMutation({
    mutationFn: () =>
      api.setRate(userId, {
        kind,
        // Cents, because money is cents everywhere. Rounded rather than
        // truncated so 152.505 does not quietly become 152.50.
        amountCents: Math.round(Number(amount) * 100),
        effectiveFrom: from,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["rates", userId] });
      // The person's page shows the rate in force, and it just changed.
      queryClient.invalidateQueries({ queryKey: ["bootstrap"] });
      setAmount("");
      toast.push({ tone: "success", title: `${kind === "cost" ? "Cost" : "Billable"} rate updated.` });
    },
    onError: (error) =>
      toast.push({
        tone: "danger",
        title: error instanceof Error ? error.message : "Could not change that rate.",
      }),
  });

  if (!maySeeAny) return null;

  /*
    In force today, not merely open-ended.

    Picking the row with no end date reported a raise scheduled for next quarter
    as the person's rate, while `/team` (which asks the database for the range
    covering today) showed the real one, and today's actual rate was folded away
    under "Earlier rates". That is the same two-displays-disagreeing problem
    this panel replaced the KpiRows to avoid.
  */
  const now = todayIn(settings.timezone);
  const inForce = (k: "billable" | "cost") =>
    (rates ?? []).find(
      (r) => r.kind === k && (!r.startsOn || r.startsOn <= now) && (!r.endsOn || r.endsOn >= now)
    ) ?? null;

  const scheduled = (rates ?? []).filter((r) => r.startsOn && r.startsOn > now);
  const history = (rates ?? []).filter((r) => r.endsOn && r.endsOn < now);
  /*
    Two decimal places, and nothing clever.

    `Number()` accepts more than money does. The change handler strips
    everything but digits and a dot, so "1e3" arrives as "13" and would have
    been saved as thirteen dollars rather than a thousand, and "-5" as five.
    Three decimals rounded silently. A regex is the honest filter here: if it
    does not look like money, the button stays off.
  */
  const amountIsValid = /^\d{1,7}(\.\d{1,2})?$/.test(amount.trim());

  return (
    <Card>
      <SectionTitle>Rates</SectionTitle>

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
            const rate = inForce(k);
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
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Rate">
              <Select value={kind} onChange={(e) => setKind(e.target.value as "billable" | "cost")}>
                <option value="billable">Billable</option>
                {/* Offering cost to somebody who cannot set it would be a
                    button that always fails. The server refuses it regardless. */}
                {mayEditCost && <option value="cost">Cost</option>}
              </Select>
            </Field>
            <Field label="Hourly amount">
              <Input
                inputMode="decimal"
                placeholder="150.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
              />
            </Field>
            <Field label="From" help="Earlier entries keep the rate they were written with.">
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </Field>
          </div>
          <div className="mt-3 flex justify-end">
            <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!amountIsValid || !from}>
              Set rate
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
