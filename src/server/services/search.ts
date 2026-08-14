/**
 * The command palette's backing query.
 *
 * One request across projects, clients, people, tasks, and invoices, ranked and
 * capped per type. Trigram similarity rather than full-text search, because
 * this is short-name matching: somebody typing "Example Client 28" expects to find "Ann &
 * Robert H Example Client 29", and a tsvector will not match mid-word.
 *
 * Results are permission-filtered **before** ranking, never after. Filtering
 * after would mean the cap of five is applied to rows the actor cannot see, so
 * a project manager searching a common word could get an empty list while the
 * matches sat in somebody else's scope.
 */

import { sql } from "drizzle-orm";
import type { Ctx } from "@/server/ctx";
import * as s from "@/server/db/schema";
import { clientScope, invoiceScope, projectScope, userScope } from "@/server/auth/scope";

export type SearchHitType = "project" | "client" | "person" | "task" | "invoice";

export interface SearchHit {
  type: SearchHitType;
  id: string;
  label: string;
  sub?: string | null;
  score: number;
}

export interface SearchResult {
  hits: SearchHit[];
  totals: Record<SearchHitType, number>;
}

const PER_TYPE = 5;

export async function search(ctx: Ctx, term: string): Promise<SearchResult> {
  const q = term.trim();
  const empty: SearchResult = { hits: [], totals: { project: 0, client: 0, person: 0, task: 0, invoice: 0 } };
  if (q.length < 1) return empty;

  const pattern = `%${q}%`;

  // Each branch carries its own scope predicate. They are separate queries
  // rather than one UNION because the predicates reference different tables and
  // a single query would need every scope join present at once.
  const [projects, clients, people, tasks, invoices] = await Promise.all([
    ctx.db
      .select({
        id: s.projects.id,
        label: s.projects.name,
        sub: s.clients.name,
        score: sql<number>`similarity(${s.projects.name}, ${q})`,
      })
      .from(s.projects)
      .innerJoin(s.clients, sql`${s.clients.id} = ${s.projects.clientId}`)
      .where(
        sql`${projectScope(ctx)} AND ${s.projects.archivedAt} IS NULL
            AND (${s.projects.name} ILIKE ${pattern} OR ${s.clients.name} ILIKE ${pattern} OR ${s.projects.code} ILIKE ${pattern})`
      )
      .orderBy(sql`similarity(${s.projects.name}, ${q}) DESC, ${s.projects.name}`)
      .limit(PER_TYPE),

    ctx.db
      .select({
        id: s.clients.id,
        label: s.clients.name,
        sub: sql<string | null>`NULL`,
        score: sql<number>`similarity(${s.clients.name}, ${q})`,
      })
      .from(s.clients)
      .where(sql`${clientScope(ctx)} AND ${s.clients.archivedAt} IS NULL AND ${s.clients.name} ILIKE ${pattern}`)
      .orderBy(sql`similarity(${s.clients.name}, ${q}) DESC, ${s.clients.name}`)
      .limit(PER_TYPE),

    ctx.db
      .select({
        id: s.users.id,
        label: sql<string>`${s.users.firstName} || ' ' || ${s.users.lastName}`,
        sub: s.users.email,
        score: sql<number>`similarity(${s.users.firstName} || ' ' || ${s.users.lastName}, ${q})`,
      })
      .from(s.users)
      .where(
        sql`${userScope(ctx)} AND ${s.users.archivedAt} IS NULL
            AND (${s.users.firstName} || ' ' || ${s.users.lastName} ILIKE ${pattern} OR ${s.users.email} ILIKE ${pattern})`
      )
      .orderBy(sql`similarity(${s.users.firstName} || ' ' || ${s.users.lastName}, ${q}) DESC`)
      .limit(PER_TYPE),

    ctx.db
      .select({
        id: s.tasks.id,
        label: s.tasks.name,
        sub: sql<string | null>`NULL`,
        score: sql<number>`similarity(${s.tasks.name}, ${q})`,
      })
      .from(s.tasks)
      .where(sql`${s.tasks.archivedAt} IS NULL AND ${s.tasks.name} ILIKE ${pattern}`)
      .orderBy(sql`similarity(${s.tasks.name}, ${q}) DESC, ${s.tasks.name}`)
      .limit(PER_TYPE),

    ctx.db
      .select({
        id: s.invoices.id,
        label: s.invoices.number,
        sub: s.clients.name,
        score: sql<number>`similarity(${s.invoices.number}, ${q})`,
      })
      .from(s.invoices)
      .innerJoin(s.clients, sql`${s.clients.id} = ${s.invoices.clientId}`)
      .where(
        sql`${invoiceScope(ctx)} AND ${s.invoices.deletedAt} IS NULL
            AND (${s.invoices.number} ILIKE ${pattern} OR ${s.invoices.subject} ILIKE ${pattern})`
      )
      .orderBy(sql`${s.invoices.issueDate} DESC`)
      .limit(PER_TYPE),
  ]);

  const hits: SearchHit[] = [
    ...projects.map((r) => ({ type: "project" as const, id: r.id, label: r.label, sub: r.sub, score: Number(r.score) })),
    ...clients.map((r) => ({ type: "client" as const, id: r.id, label: r.label, sub: r.sub, score: Number(r.score) })),
    ...people.map((r) => ({ type: "person" as const, id: r.id, label: r.label, sub: r.sub, score: Number(r.score) })),
    ...tasks.map((r) => ({ type: "task" as const, id: r.id, label: r.label, sub: r.sub, score: Number(r.score) })),
    ...invoices.map((r) => ({ type: "invoice" as const, id: r.id, label: r.label, sub: r.sub, score: Number(r.score) })),
  ];

  return {
    hits,
    totals: {
      project: projects.length,
      client: clients.length,
      person: people.length,
      task: tasks.length,
      invoice: invoices.length,
    },
  };
}
