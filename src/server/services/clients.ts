/**
 * Clients and their contacts.
 *
 * The archive guard is the interesting part: archiving a client with active
 * projects would hide work people are still tracking against, so it is refused
 * with a list of what is in the way rather than silently cascading.
 */

import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { assertCan, withTransaction, type Ctx } from "@/server/ctx";
import * as s from "@/server/db/schema";
import { newId } from "@/server/db/ids";
import { clientScope } from "@/server/auth/scope";
import { AppError, notFound, validationFailed } from "@/server/errors";
import { serializeClient, type ClientDto } from "@/server/serialize";

export interface ClientInput {
  name: string;
  address?: string | null;
  currency?: string;
  paymentTerm?: string;
  paymentTermDays?: number | null;
  taxPercent?: number | null;
  discountPercent?: number | null;
  invoicePrefix?: string | null;
  contacts?: ContactInput[];
}

export interface ContactInput {
  id?: string;
  firstName?: string | null;
  lastName?: string | null;
  title?: string | null;
  email?: string | null;
  phone?: string | null;
  isPrimary?: boolean;
}

/* -------------------------------------------------------------------- read */

export async function listClients(
  ctx: Ctx,
  opts: { includeArchived?: boolean; archivedOnly?: boolean } = {}
): Promise<ClientDto[]> {
  const conditions = [clientScope(ctx)];
  if (opts.archivedOnly) conditions.push(sql`${s.clients.archivedAt} IS NOT NULL`);
  else if (!opts.includeArchived) conditions.push(isNull(s.clients.archivedAt));

  const rows = await ctx.db
    .select()
    .from(s.clients)
    .where(and(...conditions))
    .orderBy(asc(s.clients.name));

  if (rows.length === 0) return [];

  const contacts = await ctx.db
    .select()
    .from(s.clientContacts)
    .where(isNull(s.clientContacts.archivedAt))
    .orderBy(asc(s.clientContacts.createdAt));

  const byClient = new Map<string, (typeof contacts)[number][]>();
  for (const c of contacts) {
    const list = byClient.get(c.clientId);
    if (list) list.push(c);
    else byClient.set(c.clientId, [c]);
  }

  return rows.map((r) => serializeClient(r, byClient.get(r.id) ?? []));
}

export async function getClient(ctx: Ctx, id: string): Promise<ClientDto> {
  const [row] = await ctx.db
    .select()
    .from(s.clients)
    .where(and(eq(s.clients.id, id), clientScope(ctx)))
    .limit(1);

  // 404 rather than 403 for a client outside scope: a 403 would confirm it
  // exists, which is information the actor is not entitled to.
  if (!row) throw notFound("That client");

  const contacts = await ctx.db
    .select()
    .from(s.clientContacts)
    .where(and(eq(s.clientContacts.clientId, id), isNull(s.clientContacts.archivedAt)))
    .orderBy(asc(s.clientContacts.createdAt));

  return serializeClient(row, contacts);
}

/* ------------------------------------------------------------------- write */

export async function createClient(ctx: Ctx, input: ClientInput): Promise<ClientDto> {
  assertCan(ctx, "client:manage");
  const name = input.name.trim();
  if (!name) throw validationFailed({ name: ["A client needs a name."] });

  return withTransaction(ctx, async (tx) => {
    const id = newId();
    await tx.db.insert(s.clients).values({
      id,
      name,
      address: input.address ?? null,
      currency: input.currency ?? "USD",
      paymentTerm: input.paymentTerm ?? "net_30",
      paymentTermDays: input.paymentTermDays ?? null,
      taxPercent: numeric(input.taxPercent),
      discountPercent: numeric(input.discountPercent),
      invoicePrefix: input.invoicePrefix ?? null,
      createdBy: tx.actor.userId,
      updatedBy: tx.actor.userId,
    });

    await replaceContacts(tx, id, input.contacts ?? []);

    tx.audit({ action: "client.create", entityType: "client", entityId: id, entityLabel: name, after: input });
    tx.emit({ topic: "client.created", payload: { clientId: id, name } });

    return getClient(tx, id);
  });
}

export async function updateClient(ctx: Ctx, id: string, input: Partial<ClientInput>): Promise<ClientDto> {
  assertCan(ctx, "client:manage");

  return withTransaction(ctx, async (tx) => {
    const before = await getClient(tx, id);

    const patch: Record<string, unknown> = { updatedAt: tx.now(), updatedBy: tx.actor.userId };
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) throw validationFailed({ name: ["A client needs a name."] });
      patch.name = name;
    }
    if (input.address !== undefined) patch.address = input.address;
    if (input.currency !== undefined) patch.currency = input.currency;
    if (input.paymentTerm !== undefined) patch.paymentTerm = input.paymentTerm;
    if (input.paymentTermDays !== undefined) patch.paymentTermDays = input.paymentTermDays;
    if (input.taxPercent !== undefined) patch.taxPercent = numeric(input.taxPercent);
    if (input.discountPercent !== undefined) patch.discountPercent = numeric(input.discountPercent);
    if (input.invoicePrefix !== undefined) patch.invoicePrefix = input.invoicePrefix;

    await tx.db.update(s.clients).set(patch as never).where(eq(s.clients.id, id));

    if (input.contacts) await replaceContacts(tx, id, input.contacts);

    const after = await getClient(tx, id);
    tx.audit({ action: "client.update", entityType: "client", entityId: id, entityLabel: after.name, before, after });

    return after;
  });
}

export async function archiveClient(ctx: Ctx, id: string, archived: boolean): Promise<ClientDto> {
  assertCan(ctx, "client:manage");

  return withTransaction(ctx, async (tx) => {
    const before = await getClient(tx, id);

    if (archived) {
      // Archiving a client with live projects would hide work people are still
      // tracking against. Refuse and say what is in the way.
      const active = await tx.db
        .select({ id: s.projects.id, name: s.projects.name })
        .from(s.projects)
        .where(and(eq(s.projects.clientId, id), isNull(s.projects.archivedAt)));

      if (active.length > 0) {
        throw new AppError(
          "archive_blocked",
          `Archive or move ${active.length === 1 ? "this project" : `these ${active.length} projects`} first.`,
          { meta: { projects: active } }
        );
      }
    }

    await tx.db
      .update(s.clients)
      .set({ archivedAt: archived ? tx.now() : null, updatedAt: tx.now(), updatedBy: tx.actor.userId })
      .where(eq(s.clients.id, id));

    const after = await getClient(tx, id);
    tx.audit({
      action: archived ? "client.archive" : "client.restore",
      entityType: "client",
      entityId: id,
      entityLabel: after.name,
      before,
      after,
    });

    return after;
  });
}

/* ---------------------------------------------------------------- contacts */

/**
 * Replaces the contact list wholesale.
 *
 * Contacts arrive from the editor as a complete list, so a diff is simpler and
 * safer than per-row endpoints: anything missing from the incoming list is
 * archived rather than deleted, because an invoice may still name it.
 */
async function replaceContacts(ctx: Ctx, clientId: string, contacts: ContactInput[]) {
  const existing = await ctx.db
    .select({ id: s.clientContacts.id })
    .from(s.clientContacts)
    .where(and(eq(s.clientContacts.clientId, clientId), isNull(s.clientContacts.archivedAt)));

  const keep = new Set<string>();

  for (const [index, contact] of contacts.entries()) {
    const isPrimary = contact.isPrimary ?? index === 0;
    const values = {
      firstName: contact.firstName?.trim() || null,
      lastName: contact.lastName?.trim() || null,
      title: contact.title?.trim() || null,
      email: contact.email?.trim() || null,
      phoneMobile: contact.phone?.trim() || null,
      isPrimary,
      updatedAt: ctx.now(),
    };

    const existingId = contact.id && existing.some((e) => e.id === contact.id) ? contact.id : null;

    if (existingId) {
      keep.add(existingId);
      await ctx.db.update(s.clientContacts).set(values).where(eq(s.clientContacts.id, existingId));
    } else {
      const id = newId();
      keep.add(id);
      await ctx.db.insert(s.clientContacts).values({ id, clientId, ...values });
    }
  }

  const removed = existing.filter((e) => !keep.has(e.id)).map((e) => e.id);
  if (removed.length > 0) {
    await ctx.db
      .update(s.clientContacts)
      .set({ archivedAt: ctx.now() })
      .where(inArray(s.clientContacts.id, removed));
  }
}

/** numeric(6,3) columns take a string; a number would be coerced with a warning. */
const numeric = (v: number | null | undefined): string | null => (v == null ? null : String(v));
