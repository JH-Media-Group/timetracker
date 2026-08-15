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
import { createCtx, systemActor } from "@/server/ctx";
import { db } from "@/server/db/client";
import * as s from "@/server/db/schema";
import { newId } from "@/server/db/ids";
import { ESCALATION_DAYS, sendDueReminders } from "@/server/services/invoice-reminders";
import { formatMoney } from "@/lib/format";
import { invalidateSettings } from "@/server/services/settings";

/*
  A real Ctx, not a hand-rolled one.

  The first version of this file built `{ db, audit, actor }` by hand, which was
  enough for the services as they were then and stopped being enough the moment
  the reminder pass started using `withTransaction`: the buffers it flushes were
  simply absent. A fake context that diverges from the real one makes a test
  less faithful exactly where it matters, so this uses the same constructor the
  application does.
*/
/*
  Built against a real user row, because `invoice_messages.sent_by` is a real
  foreign key. The default system actor uses a zero uuid, which no `users` row
  has; in production `systemCtx()` resolves the account owner, so this mirrors
  that rather than the placeholder.
*/
let ctx: ReturnType<typeof createCtx>;

async function actorUser(): Promise<string> {
  const [existing] = await db.select({ id: s.users.id }).from(s.users).limit(1);
  if (existing) return existing.id;

  const [profile] = await db.select().from(s.permissionProfiles).limit(1);
  const id = newId();
  await db.insert(s.users).values({
    id,
    email: `reminder-actor-${id}@example.test`,
    firstName: "Job",
    lastName: "Runner",
    profileId: profile!.id,
  });
  return id;
}

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
  ctx = createCtx({ actor: systemActor(await actorUser()), db });

  /*
    Undo the shared settings row here, not at the end of the test that changes
    it. `settings` is a singleton, so a test that fails partway through leaves
    its override in place and every later test in the file renders from it. That
    happened: one genuine failure became six.
  */
  await db.update(s.settings).set({ invoiceMessages: {} });
  invalidateSettings();
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

  /**
   * This test used to assert the bug.
   *
   * It said an invoice several steps late "catches up one per run", which
   * sounded orderly and, with the mail job on a five-minute cadence, meant
   * three emails to a client inside a quarter of an hour. A review pointed at
   * it. Crossing several steps at once now sends exactly one message, and it is
   * the one that fits: nobody needs the "one day late" note when they are a
   * month past due.
   */
  it("sends one message when several steps are crossed at once", async () => {
    const { id } = await seedInvoice({ dueDaysAgo: ESCALATION_DAYS[2] });
    await sendDueReminders(ctx, TODAY);
    expect(await reminderCount(id)).toBe(1);

    for (let i = 0; i < 5; i++) await sendDueReminders(ctx, TODAY);
    expect(await reminderCount(id), "the job runs every five minutes").toBe(1);
  });

  it("sends again once a later step is genuinely reached", async () => {
    const { id } = await seedInvoice({ dueDaysAgo: ESCALATION_DAYS[0] });
    await sendDueReminders(ctx, TODAY);
    expect(await reminderCount(id)).toBe(1);

    // Time passes: the invoice is now past the second step.
    await db
      .update(s.invoices)
      .set({ dueDate: isoDaysAgo(ESCALATION_DAYS[1]) })
      .where(eq(s.invoices.id, id));

    await sendDueReminders(ctx, TODAY);
    expect(await reminderCount(id)).toBe(2);
    await sendDueReminders(ctx, TODAY);
    expect(await reminderCount(id)).toBe(2);
  });

  it("stops after the last step, however late the invoice gets", async () => {
    const { id } = await seedInvoice({ dueDaysAgo: 400 });
    for (let i = 0; i < 10; i++) await sendDueReminders(ctx, TODAY);
    expect(await reminderCount(id)).toBe(1);
  });

  it("two overlapping runs send one reminder, not two", async () => {
    // The scan runs outside a transaction, so both runs can see the same
    // invoice. The per-invoice lock and the level recheck under it are what
    // stop both of them deciding to send.
    const { id } = await seedInvoice({ dueDaysAgo: 3 });
    await Promise.all([sendDueReminders(ctx, TODAY), sendDueReminders(ctx, TODAY)]);
    expect(await reminderCount(id)).toBe(1);
  });

  it("does not spend an escalation step on an invoice it could not chase", async () => {
    // Advancing the level without sending would mean that once a contact is
    // added, the invoice is silently already "chased".
    const { id, clientId } = await seedInvoice({ dueDaysAgo: 3, withContact: false });
    await sendDueReminders(ctx, TODAY);
    expect(await reminderCount(id)).toBe(0);

    await db.insert(s.clientContacts).values({
      id: newId(),
      clientId,
      firstName: "A",
      lastName: "Contact",
      email: `late-${clientId}@example.test`,
    });

    await sendDueReminders(ctx, TODAY);
    expect(await reminderCount(id)).toBe(1);
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

  it("refuses to send a template with a token nothing fills", async () => {
    /*
      `renderLabel` leaves an unknown token exactly as written, which is fine on
      a screen somebody can fix and wrong in an email to a client. The editor
      used to offer `{{link}}` with nothing supplying it, so a template using it
      sent a client that literal text.
    */
    await db
      .update(s.settings)
      .set({ invoiceMessages: { reminderBody: "Pay here: {{link}}", reminderSubject: "Invoice {{number}}" } });
    // getSettings caches for five seconds, so a direct write needs this too.
    invalidateSettings();

    const { id } = await seedInvoice({ dueDaysAgo: 2 });
    await expect(sendDueReminders(ctx, TODAY)).rejects.toThrow(/\{\{link\}\}, which nothing fills in/);
    expect(await reminderCount(id)).toBe(0);

  });

  it("does not refuse an invoice because the client's name has braces in it", async () => {
    /*
      The guard used to scan the rendered output, which contains the client's
      own name, so a company called "{{ACME}}" had its invoice refused and the
      error blamed a template that was perfectly fine. Only the template can
      promise a token, so only the template is checked.
    */
    const { id, clientId } = await seedInvoice({ dueDaysAgo: 2 });
    await db.update(s.clients).set({ name: "{{ACME}} Media {{ Ltd }}" }).where(eq(s.clients.id, clientId));

    await expect(sendDueReminders(ctx, TODAY)).resolves.toMatchObject({ sent: 1 });
    expect(await reminderCount(id)).toBe(1);
  });

  it("formats money the same way the invoice screen does", async () => {
    // A local formatter drifted on currencies without two decimal places, so a
    // client could read one total in the email and another on the invoice.
    await seedInvoice({ dueDaysAgo: 2 });
    await sendDueReminders(ctx, TODAY);

    const [queued] = await db.select().from(s.outboundMessages);
    expect(queued!.bodyText).toContain(formatMoney(100_00, "USD"));
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
