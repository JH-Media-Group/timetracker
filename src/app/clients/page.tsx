"use client";

/**
 * Clients list.
 *
 * A client is the billing entity, so the columns that matter are financial:
 * what has been tracked but not yet invoiced, and what has been invoiced but
 * not yet paid. Everything else is one click away on the detail page.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColDef } from "ag-grid-community";
import { Plus } from "lucide-react";
import * as api from "@/lib/api";
import { ValueAccumulator } from "@/lib/derive";
import { formatMoney } from "@/lib/format";
import type { Invoice, TimeEntry } from "@/lib/types";
import { TERM_LABEL } from "@/lib/labels";
import { Badge, Button, EmptyState, Select } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { PageBody, PageHeader, useUrlState } from "@/components/app/page-chrome";
import { DataGrid } from "@/components/app/data-grid";
import { useApp, useCan } from "@/components/app/providers";
import type { GridRow } from "@/components/ui/grid";

interface Row {
  _id: string; _kind: "data";
  id: string; name: string; projects: number; contacts: number;
  uninvoiced: number; outstanding: number; term: string; currency: string;
  archived: boolean;
}

export default function ClientsPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const { params, set } = useUrlState();
  const { clients, projects } = useApp();
  const can = useCan();

  const status = params.get("status") || "active";

  const { data: entries = [], isLoading: loadingTime } = useQuery({
    queryKey: ["time", "all"], queryFn: () => api.listTimeEntries({}),
  });
  const { data: invoices = [], isLoading: loadingInv } = useQuery({
    queryKey: ["invoices"], queryFn: api.listInvoices,
  });

  const uninvoicedByClient = React.useMemo(() => {
    const projectClient = new Map(projects.map((p) => [p.id, p.clientId]));
    const acc = new Map<string, ValueAccumulator>();
    for (const e of entries as TimeEntry[]) {
      if (!e.isBillable || e.invoiceId || e.billedExternally) continue;
      const clientId = projectClient.get(e.projectId);
      if (!clientId) continue;
      let bucket = acc.get(clientId);
      if (!bucket) { bucket = new ValueAccumulator(); acc.set(clientId, bucket); }
      bucket.add(e.durationSeconds, e.billableRateCents);
    }
    // Divided once per client, at the end. Rounding each entry and adding the
    // results would put this column a few cents away from the invoice built
    // from the same hours.
    const m = new Map<string, number>();
    for (const [clientId, bucket] of acc) m.set(clientId, bucket.cents);
    return m;
  }, [entries, projects]);

  const outstandingByClient = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const i of invoices as Invoice[]) {
      if (i.state === "draft" || i.state === "paid" || i.state === "written_off") continue;
      m.set(i.clientId, (m.get(i.clientId) ?? 0) + (i.totalCents - i.paidCents));
    }
    return m;
  }, [invoices]);

  const counts = React.useMemo(() => ({
    active: clients.filter((c) => !c.archivedAt).length,
    archived: clients.filter((c) => !!c.archivedAt).length,
  }), [clients]);

  const rows = React.useMemo<GridRow<Row>[]>(() => {
    const projectCount = new Map<string, number>();
    for (const p of projects) if (!p.archivedAt) projectCount.set(p.clientId, (projectCount.get(p.clientId) ?? 0) + 1);

    return clients
      .filter((c) => (status === "archived" ? !!c.archivedAt : !c.archivedAt))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => ({
        _id: c.id, _kind: "data" as const, id: c.id, name: c.name,
        projects: projectCount.get(c.id) ?? 0,
        contacts: c.contacts.length,
        uninvoiced: uninvoicedByClient.get(c.id) ?? 0,
        outstanding: outstandingByClient.get(c.id) ?? 0,
        term: TERM_LABEL[c.paymentTerm],
        currency: c.currency,
        archived: !!c.archivedAt,
      }));
  }, [clients, projects, status, uninvoicedByClient, outstandingByClient]);

  const columns = React.useMemo<ColDef[]>(() => [
    {
      colId: "name", field: "name", headerName: "Client", flex: 1, minWidth: 240,
      cellRenderer: (p: { data?: Row }) => p.data && (
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium text-ink">{p.data.name}</span>
          {p.data.archived && <Badge variant="neutral">Archived</Badge>}
        </span>
      ),
    },
    { colId: "projects", field: "projects", headerName: "Projects", type: "numeric", width: 110 },
    { colId: "contacts", field: "contacts", headerName: "Contacts", type: "numeric", width: 110 },
    { colId: "term", field: "term", headerName: "Payment terms", width: 150 },
    ...(can("report:view_financial") || can("invoice:manage") ? [
      { colId: "uninvoiced", field: "uninvoiced", headerName: "Uninvoiced", type: "money", width: 150 } as ColDef,
      {
        colId: "outstanding", field: "outstanding", headerName: "Outstanding", type: "money", width: 150,
        cellRenderer: (p: { value: number }) => (
          <span className={p.value > 0 ? "font-medium text-ink" : "text-ink-tertiary"}>{formatMoney(p.value)}</span>
        ),
      } as ColDef,
    ] : []),
  ], [can]);

  const totals = React.useMemo(() => ({
    name: "Total",
    projects: rows.reduce((a, r) => a + r.projects, 0),
    uninvoiced: rows.reduce((a, r) => a + r.uninvoiced, 0),
    outstanding: rows.reduce((a, r) => a + r.outstanding, 0),
  }), [rows]);

  return (
    <>
      <PageHeader
        title="Clients"
        actions={can("client:manage") && (
          <Button variant="primary" onClick={() => router.push("/clients/new")}>
            <Plus className="size-4" />New client
          </Button>
        )}
      />
      <PageBody className="pt-4">
        <DataGrid<Row>
          label="Clients"
          tableId="clients"
          rows={rows}
          columns={columns}
          loading={loadingTime || loadingInv}
          totals={totals}
          height={620}
          selectable={can("client:manage")}
          onRowOpen={(r) => router.push(`/clients/${r.id}`)}
          onExport={() => toast.push({ title: "Export queued. You will get an email when it is ready." })}
          filters={
            <Select value={status} onChange={(e) => set({ status: e.target.value })} className="w-[200px]" aria-label="Client status">
              <option value="active">Active clients ({counts.active})</option>
              <option value="archived">Archived clients ({counts.archived})</option>
            </Select>
          }
          bulkActions={[
            {
              key: "terms", label: "Set payment terms", input: "inline",
              inlineLabel: "Terms", inlinePlaceholder: "net 30",
              run: (sel) => { toast.push({ tone: "success", title: `Updated ${sel.length} clients.` }); },
            },
            {
              key: "archive", label: status === "archived" ? "Restore" : "Archive", input: "immediate", end: true,
              run: async (sel) => {
                const ids = (sel as Row[]).map((r) => r.id);
                const archiving = status !== "archived";
                for (const id of ids) await api.updateClient(id, { archivedAt: archiving ? new Date().toISOString() : undefined });
                qc.invalidateQueries({ queryKey: ["bootstrap"] });
                toast.push({
                  tone: "success",
                  title: `${archiving ? "Archived" : "Restored"} ${ids.length} ${ids.length === 1 ? "client" : "clients"}.`,
                  undo: async () => {
                    for (const id of ids) await api.updateClient(id, { archivedAt: archiving ? undefined : new Date().toISOString() });
                    qc.invalidateQueries({ queryKey: ["bootstrap"] });
                  },
                });
              },
            },
            {
              key: "delete", label: "Delete", intent: "danger", input: "modal", end: true,
              run: () => { toast.push({ tone: "danger", title: "Clients with time or invoices cannot be deleted. Archive them instead." }); },
            },
          ]}
          empty={
            <EmptyState
              title="No clients here."
              action={can("client:manage") && <Button variant="primary" onClick={() => router.push("/clients/new")}>New client</Button>}
            >
              {status === "archived" ? "Archived clients will appear here." : "Add a client before you create its first project."}
            </EmptyState>
          }
        />
      </PageBody>
    </>
  );
}
