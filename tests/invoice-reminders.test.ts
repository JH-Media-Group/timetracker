/**
 * Overdue reminders (TALLY-50).
 *
 * The property worth defending is restraint. An invoice forty days late must
 * produce three reminders in its lifetime, not forty, and the failure mode of
 * getting that wrong is not noise in a log: it is a client being emailed every
 * morning and a template that everyone learns to filter.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/mail/transport", async () => {
  const actual = await vi.importActual<typeof import("@/server/mail/transport")>("@/server/mail/transport");
  return { ...actual, canSend: () => true, send: vi.fn(async () => ({ messageId: null })) };
});

import { eq, sql } from "drizzle-orm";
import { db } from "@/server/db/client";
import * as s from "@/server/db/schema";
import { newId } from "@/server/db/ids";
import { ESCALATION_DAYS, sendDueReminders } from "@/server/services/invoice-reminders";

const ctx = {
  db,
  audit: () => {},
  actor: { userId: null as unknown as string, capabilities: new Set(["invoice:send"]) },
} as never;

const DAY = 86_400_000;
const isoDaysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
const TODAY = new Date().toISOString().slice(0, 10);

async function seedInvoice(opts: { dueDaysAgo: number; withContact?: boolean; paid?: number }) {
  const clientId = newId();
  await db.insert(s.clients).values({ id: clientId, name: `Client ${clientId}` });

  if (opts.withContact !== false) {
    await db.insert(s.clientContacts).values({
      id: newId(),
      clientId,
      firstName: "A",
      lastName: "Contact",
      email: `contact-${clientId}@example.test`,
    });
  }

  const id = newId();
  await db.insert(s.invoices).values({
    id,
    clientId,
    number: `INV-${id.slice(-6)}`,
    state: "open",
    issueDate: isoDaysAgo(opts.dueDaysAgo + 30),
    dueDate: isoDaysAgo(opts.dueDaysAgo),
    currency: "USD",
    subtotalCents: 100_00,
    totalCents: 100_00,
    paidCents: opts.paid ?? 0,
  });
  return { id, clientId };
}

const reminderCount = async (invoiceId: string) =>
  (
    await db
      .select()
      .from(s.invoiceMessages)
      .where(eq(s.invoiceMessages.invoiceId, invoiceId))
  ).filter((m) => m.kind === "reminder").length;

beforeEach(async () => {
  await db.delete(s.outboundMessages);
  await db.delete(s.invoiceMessages);
  await db.delete(s.invoices);
  await db.delete(s.clientContacts);
  await db.delete(s.clients).where(sql`name LIKE 'Client %'`);
});

describe("sendDueReminders", () => {
  it("does not chase an invoice that is not yet due", async () => {
    const { id } = await seedInvoice({ dueDaysAgo: -5 });
    const report = await sendDueReminders(ctx, TODAY);
    expect(report.sent).toBe(0);
    expect(await reminderCount(id)).toBe(0);
  });

  it("sends one reminder once an invoice is a day late", async () => {
    const { id } = await seedInvoice({ dueDaysAgo: 1 });
    expect((await sendDueReminders(ctx, TODAY)).sent).toBe(1);
    expect(await reminderCount(id)).toBe(1);
  });

  it("does not send again the next day, or the day after that", async () => {
    // The whole point. Running daily must not mean mailing daily.
    const { id } = await seedInvoice({ dueDaysAgo: 1 });
    await sendDueReminders(ctx, TODAY);

    for (let i = 0; i < 5; i++) await sendDueReminders(ctx, TODAY);
    expect(await reminderCount(id)).toBe(1);
  });

  it("sends again only when the next escalation step is crossed", async () => {
    const { id } = await seedInvoice({ dueDaysAgo: ESCALATION_DAYS[1] });
    await sendDueReminders(ctx, TODAY);
    // Two steps passed at once, and it is behind by two, so it catches up one
    // per run rather than sending two emails in the same minute.
    expect(await reminderCount(id)).toBe(1);
    await sendDueReminders(ctx, TODAY);
    expect(await reminderCount(id)).toBe(2);
    await sendDueReminders(ctx, TODAY);
    expect(await reminderCount(id)).toBe(2);
  });

  it("stops after the last step, however late the invoice gets", async () => {
    const { id } = await seedInvoice({ dueDaysAgo: 400 });
    for (let i = 0; i < 10; i++) await sendDueReminders(ctx, TODAY);
    expect(await reminderCount(id)).toBe(ESCALATION_DAYS.length);
  });

  it("still chases a partly paid invoice", async () => {
    // Half paid is still owed, and its state is `open` exactly as an untouched
    // one is. A state check alone would let it go quiet.
    const { id } = await seedInvoice({ dueDaysAgo: 1, paid: 50_00 });
    expect((await sendDueReminders(ctx, TODAY)).sent).toBe(1);
    expect(await reminderCount(id)).toBe(1);
  });

  it("does not chase a fully paid invoice", async () => {
    const { id } = await seedInvoice({ dueDaysAgo: 30, paid: 100_00 });
    expect((await sendDueReminders(ctx, TODAY)).sent).toBe(0);
    expect(await reminderCount(id)).toBe(0);
  });

  it("reports an overdue invoice with nobody to chase, rather than passing over it", async () => {
    // An invoice nobody is chasing, that nobody knows nobody is chasing, is the
    // worst of the available outcomes.
    const { id } = await seedInvoice({ dueDaysAgo: 10, withContact: false });
    const report = await sendDueReminders(ctx, TODAY);
    expect(report.sent).toBe(0);
    expect(report.skippedNoContact).toHaveLength(1);
    expect(await reminderCount(id)).toBe(0);
  });

  it("queues real mail, not just a record of intent", async () => {
    await seedInvoice({ dueDaysAgo: 1 });
    await sendDueReminders(ctx, TODAY);

    const queued = await db.select().from(s.outboundMessages);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.kind).toBe("reminder");
    expect(queued[0]!.subject).toMatch(/invoice/i);
    // Rendered from the template, so no token is left standing in the text.
    expect(queued[0]!.bodyText).not.toMatch(/\{\{/);
  });
});
