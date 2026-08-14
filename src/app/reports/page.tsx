"use client";

/**
 * Reports.
 *
 * Four reports, one chrome: pick a report, pick a period, pick what to group by.
 * The chart answers the shape question and the table answers the number
 * question, and they are always built from the same rows so they cannot
 * disagree.
 *
 * Each report fetches its own grouped rows from its own endpoint. The page used
 * to fetch every time entry in the period and hand them down to be aggregated
 * in the browser, which was a second implementation of the same money questions
 * and disagreed with the server on three of the four.
 */

import * as React from "react";
import { Tabs } from "@/components/ui/primitives";
import { PageBody, PageHeader, PeriodPicker, usePeriod, useUrlState } from "@/components/app/page-chrome";
import { useCan } from "@/components/app/providers";
import { EmptyState } from "@/components/ui/primitives";
import { TimeReport } from "./time-report";
import { ProfitabilityReport } from "./profitability-report";
import { TeamReport } from "./team-report";
import { InvoicingReport } from "./invoicing-report";

export type ReportKey = "time" | "profitability" | "team" | "invoicing";

export default function ReportsPage() {
  const { params, set } = useUrlState();
  const can = useCan();
  const { granularity, anchor, period, onChange } = usePeriod("month", ["week", "month", "quarter", "year", "all"]);

  const report = (params.get("r") as ReportKey) || "time";

  // Each tab is gated on the capability its endpoint checks, so a tab that is
  // present is a tab whose request will be answered.
  const tabs = [
    { value: "time", label: "Time" },
    ...(can("report:view_financial") ? [{ value: "profitability", label: "Profitability" }] : []),
    ...(can("report:view_team") || can("report:view_all") ? [{ value: "team", label: "Team" }] : []),
    ...(can("report:view_financial") ? [{ value: "invoicing", label: "Invoicing" }] : []),
  ];

  const allowed = tabs.some((t) => t.value === report) ? report : "time";

  return (
    <>
      <PageHeader title="Reports">
        <Tabs
          value={allowed}
          onValueChange={(v) => set({ r: v === "time" ? null : v })}
          tabs={tabs}
        />
      </PageHeader>

      <PageBody className="pt-4">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <PeriodPicker
            granularity={granularity}
            anchor={anchor}
            onChange={onChange}
            allowed={["week", "month", "quarter", "year", "all"]}
          />
          <span className="text-base text-ink-secondary">{period.from} to {period.to}</span>
        </div>

        {tabs.length === 0 ? (
          <EmptyState title="No reports available.">Your permissions do not include any reports.</EmptyState>
        ) : allowed === "time" ? (
          <TimeReport period={period} />
        ) : allowed === "profitability" ? (
          <ProfitabilityReport period={period} />
        ) : allowed === "team" ? (
          <TeamReport period={period} />
        ) : (
          <InvoicingReport period={period} />
        )}
      </PageBody>
    </>
  );
}
