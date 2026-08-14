"use client";

/**
 * Reports.
 *
 * Four reports, one chrome: pick a report, pick a period, pick what to group by.
 * The chart answers the shape question and the table answers the number
 * question, and they are always built from the same rows so they cannot
 * disagree.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import * as api from "@/lib/api";
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

  const financial = can("report:view_financial") || can("rates:view_cost");
  const report = (params.get("r") as ReportKey) || "time";

  const tabs = [
    { value: "time", label: "Time" },
    ...(financial ? [{ value: "profitability", label: "Profitability" }] : []),
    ...(can("time:view_others") ? [{ value: "team", label: "Team" }] : []),
    ...(can("invoice:manage") || financial ? [{ value: "invoicing", label: "Invoicing" }] : []),
  ];

  const allowed = tabs.some((t) => t.value === report) ? report : "time";

  // Every report reads the same two collections, so they are fetched once here
  // and passed down rather than refetched per tab.
  const { data: entries = [], isLoading: loadingTime } = useQuery({
    queryKey: ["time", "range", period.from, period.to],
    queryFn: () => api.listTimeEntries({ from: period.from, to: period.to }),
  });
  const { data: expenses = [] } = useQuery({
    queryKey: ["expenses", period.from, period.to],
    queryFn: () => api.listExpenses({ from: period.from, to: period.to }),
  });
  const { data: invoices = [] } = useQuery({ queryKey: ["invoices"], queryFn: api.listInvoices });

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
          <TimeReport entries={entries} loading={loadingTime} period={period} />
        ) : allowed === "profitability" ? (
          <ProfitabilityReport entries={entries} expenses={expenses} invoices={invoices} />
        ) : allowed === "team" ? (
          <TeamReport entries={entries} period={period} />
        ) : (
          <InvoicingReport invoices={invoices} period={period} />
        )}
      </PageBody>
    </>
  );
}
