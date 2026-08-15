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

import { and, eq, inArray, sql } from "drizzle-orm";
import { createCtx, systemActor } from "@/server/ctx";
import { db, sql as pg } from "@/server/db/client";
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

/**
 * One clock reading for the whole file, not one per call.
 *
 * `isoDaysAgo` used to read `Date.now()` each time it was called while `TODAY`
 * was captured at module load. Almost always identical, and wrong for the two
 * minutes a year the run crosses UTC midnight between the import and a seed:
 * every seeded date comes out a day younger than `TODAY` assumes, `stepsPassed`
 * lands on zero, and every test that sends fails while every test that does not
 * passes. Anchoring both to one instant removes the window rather than shrinking
 * it.
 */
const ANCHOR = Date.now();
const isoDaysAgo = (n: number) => new Date(ANCHOR - n * DAY).toISOString().slice(0, 10);
const TODAY = isoDaysAgo(0);

/**
 * Every client these tests create, so cleanup can delete by id.
 *
 * It used to delete `WHERE name LIKE 'Client %'`, which is fine until a test
 * renames one. The braces test does exactly that, so its client survived the
 * cleanup and collided with `clients_name_unique` on the next run: the file
 * passed alone and failed whenever anything ran before it. Matching on a
 * mutable column to find rows you created is the bug; the ids are not mutable.
 */
const madeClients: string[] = [];

async function seedInvoice(opts: { dueDaysAgo: number; withContact?: boolean; paid?: number }) {
  const clientId = newId();
  madeClients.push(clientId);
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

/**
 * How many reminders a client has actually been sent.
 *
 * Counts the outbound queue as well as the invoice history, and insists the two
 * agree. Counting only `invoice_messages` let the restraint tests pass while
 * queueing was broken, which is the half that reaches the client: they would
 * have reported "one reminder" for an invoice nobody had emailed.
 */
const reminderCount = async (invoiceId: string) => {
  const history = (
    await db.select().from(s.invoiceMessages).where(eq(s.invoiceMessages.invoiceId, invoiceId))
  ).filter((m) => m.kind === "reminder").length;

  const queued = (
    await db
      .select()
      .from(s.outboundMessages)
      .where(and(eq(s.outboundMessages.relatedType, "invoice"), eq(s.outboundMessages.relatedId, invoiceId)))
  ).filter((m) => m.kind === "reminder").length;

  expect(queued, "a recorded reminder that was never queued has not been sent").toBe(history);
  return history;
};

/** The invoice number, which is what the failure report identifies rows by. */
const numberOf = async (invoiceId: string) => {
  const [row] = await db
    .select({ number: s.invoices.number })
    .from(s.invoices)
    .where(eq(s.invoices.id, invoiceId));
  return row!.number ?? invoiceId;
};

/** The escalation step the invoice is recorded as having been chased at. */
const levelOf = async (invoiceId: string) => {
  const [row] = await db
    .select({ level: s.invoices.reminderLevel })
    .from(s.invoices)
    .where(eq(s.invoices.id, invoiceId));
  return row!.level;
};

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
  if (madeClients.length) {
    await db.delete(s.clients).where(inArray(s.clients.id, madeClients));
    madeClients.length = 0;
  }
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

  it("chases again after an extension, rather than being silenced for good", async () => {
    /*
      The ordinary way an invoice used to go quiet for ever.

      A client asks for more time, somebody moves the due date out, and the
      invoice stops being late. Its level stayed at whatever it had reached, and
      because the scan only asked for `due_date <= today` it was never looked at
      again to be corrected. When the new date passed and it was a day late, one
      step showed against a recorded three, which reads as already chased. The
      symptom is an invoice nobody is chasing and no error anywhere.
    */
    const { id } = await seedInvoice({ dueDaysAgo: ESCALATION_DAYS[2] });
    await sendDueReminders(ctx, TODAY);
    expect(await reminderCount(id)).toBe(1);
    expect(await levelOf(id)).toBe(3);

    // Thirty more days granted. Not late any more.
    await db.update(s.invoices).set({ dueDate: isoDaysAgo(-30) }).where(eq(s.invoices.id, id));

    expect((await sendDueReminders(ctx, TODAY)).sent, "an extension sends nothing").toBe(0);

    // The extension runs out. A new due date, so a fresh escalation.
    await db.update(s.invoices).set({ dueDate: isoDaysAgo(ESCALATION_DAYS[0]) }).where(eq(s.invoices.id, id));

    expect((await sendDueReminders(ctx, TODAY)).sent).toBe(1);
    expect(await reminderCount(id)).toBe(2);
    expect(await levelOf(id), "step one, against the new date").toBe(1);
  });

  it("does not re-send a step the client already had when a due-date edit is undone", async () => {
    /*
      The defect the first fix introduced, and the reason the level is paired
      with a date rather than simply wound back.

      Winding the level down whenever the invoice was less late meant any edit
      to a due date reset the escalation, including one made by mistake. Put the
      date back and the client received a second copy of a dunning email they
      already had. A reviewer walked the sequence: typo, cron runs inside five
      minutes, typo corrected, cron runs again, second email.

      Because the level belongs to a due date, restoring the date restores the
      level with it.
    */
    const { id } = await seedInvoice({ dueDaysAgo: ESCALATION_DAYS[2] });
    await sendDueReminders(ctx, TODAY);
    expect(await reminderCount(id)).toBe(1);

    const original = isoDaysAgo(ESCALATION_DAYS[2]);

    // Somebody fat-fingers the due date, and the job runs before it is noticed.
    await db.update(s.invoices).set({ dueDate: isoDaysAgo(-60) }).where(eq(s.invoices.id, id));
    expect((await sendDueReminders(ctx, TODAY)).sent).toBe(0);

    // The mistake is corrected.
    await db.update(s.invoices).set({ dueDate: original }).where(eq(s.invoices.id, id));

    expect((await sendDueReminders(ctx, TODAY)).sent, "the client already had this one").toBe(0);
    expect(await reminderCount(id)).toBe(1);
  });

  it("starts a fresh escalation against a genuinely new due date", async () => {
    // The other half of the same rule. A due date that moves to a *different*
    // date is a different schedule, and step one against it is a message the
    // client has not had.
    const { id } = await seedInvoice({ dueDaysAgo: ESCALATION_DAYS[2] });
    await sendDueReminders(ctx, TODAY);

    await db
      .update(s.invoices)
      .set({ dueDate: isoDaysAgo(ESCALATION_DAYS[2] - 1) })
      .where(eq(s.invoices.id, id));

    expect((await sendDueReminders(ctx, TODAY)).sent).toBe(1);
    expect(await reminderCount(id)).toBe(2);
  });

  it("leaves an invoice that is not yet due alone", async () => {
    const { id } = await seedInvoice({ dueDaysAgo: -5 });
    await sendDueReminders(ctx, TODAY);
    expect(await levelOf(id)).toBe(0);
    expect(await reminderCount(id)).toBe(0);
  });

  it("stops after the last step, however late the invoice gets", async () => {
    const { id } = await seedInvoice({ dueDaysAgo: 400 });
    for (let i = 0; i < 10; i++) await sendDueReminders(ctx, TODAY);
    expect(await reminderCount(id)).toBe(1);
  });

  it("waits for another run that already holds the invoice", async () => {
    /*
      This used to be `Promise.all([sendDueReminders(), sendDueReminders()])`,
      which passed with the row lock deleted: two calls in one process do not
      interleave inside a transaction, and superseding alone satisfied the
      assertion. A reviewer mutation-tested it and it did not notice.

      So the lock is exercised directly. A second connection takes the invoice
      row and holds it; the reminder pass must block on that rather than read a
      stale level and decide to send. When the holder commits with the level
      already advanced, the pass finds nothing to do.
    */
    const { id } = await seedInvoice({ dueDaysAgo: 3 });

    const holder = pg.reserve ? await pg.reserve() : null;
    if (!holder) return; // driver without reserve(); nothing to assert safely

    try {
      await holder`BEGIN`;
      await holder`SELECT id FROM invoices WHERE id = ${id} FOR UPDATE`;
      // Both columns, because that is what a real run writes. Setting the level
      // alone leaves `reminder_due_date` null, which reads as "chased against
      // some other date" and correctly earns a fresh reminder, so the test
      // would be asserting against a state no run can produce.
      await holder`UPDATE invoices SET reminder_level = 3, reminder_due_date = due_date WHERE id = ${id}`;

      let finished = false;
      const pass = sendDueReminders(ctx, TODAY).then((r) => {
        finished = true;
        return r;
      });

      await new Promise((r) => setTimeout(r, 300));
      expect(finished, "the pass must block on the lock, not read around it").toBe(false);

      await holder`COMMIT`;
      const report = await pass;

      expect(report.sent, "the other run had already chased it").toBe(0);
      expect(await reminderCount(id)).toBe(0);
    } finally {
      await holder`ROLLBACK`.catch(() => {});
      holder.release();
    }
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

    /*
      The run survives it. This used to assert the whole call rejected, which
      was the behaviour and was wrong: the mail job runs this before draining,
      in one try, so a single unrenderable invoice threw, the job exited, and no
      password reset or invite in the queue was ever sent again.
    */
    const report = await sendDueReminders(ctx, TODAY);
    expect(report.sent).toBe(0);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]!.reason).toMatch(/\{\{link\}\}, which nothing fills in/);
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
    // Unique, because `clients.name` is unique and a fixed literal in a test is
    // a collision waiting for the second run.
    await db
      .update(s.clients)
      .set({ name: `{{ACME}} Media {{ Ltd }} ${clientId}` })
      .where(eq(s.clients.id, clientId));

    await expect(sendDueReminders(ctx, TODAY)).resolves.toMatchObject({ sent: 1 });
    expect(await reminderCount(id)).toBe(1);
  });

  it("keeps chasing the other invoices when one cannot render", async () => {
    // The blast radius of a bad template is that invoice, not the run.
    const bad = await seedInvoice({ dueDaysAgo: 5 });
    const good = await seedInvoice({ dueDaysAgo: 5 });

    await db
      .update(s.settings)
      .set({ invoiceMessages: { reminderBody: "Pay: {{link}}", reminderSubject: "Invoice {{number}}" } });
    invalidateSettings();

    const report = await sendDueReminders(ctx, TODAY);

    /*
      Both fail, because the template is one account-level setting: there is no
      way to make a single invoice unrenderable. So the assertion has to be
      that **each specific invoice was reached**, not that the count came out
      at two. A reviewer pointed out that counting alone survives a mutation
      which catches the first failure and then mechanically records identical
      failures for the rest without attempting them.

      Naming both invoices is what proves the loop carried on past the throw.
    */
    expect(report.considered).toBe(2);
    const numbers = await Promise.all([numberOf(bad.id), numberOf(good.id)]);
    expect(report.failed.map((f) => f.invoice).sort()).toEqual([...numbers].sort());
    expect(report.sent).toBe(0);
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
