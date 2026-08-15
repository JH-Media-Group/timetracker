/**
 * The outbound mail queue (TALLY-49).
 *
 * The properties that matter are the ones that only show up under failure: a
 * transient error must come back, a permanent one must not, and two runs must
 * not send the same message twice. None of those are visible from a happy path,
 * so every case here forces the failure rather than waiting for it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/mail/transport", async () => {
  const actual = await vi.importActual<typeof import("@/server/mail/transport")>("@/server/mail/transport");
  return {
    ...actual,
    canSend: () => true,
    send: vi.fn(),
  };
});

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/server/db/client";
import * as s from "@/server/db/schema";
import { newId } from "@/server/db/ids";
import { drainMail, mailQueueDepth, queueMail } from "@/server/services/mail";
import { PermanentSendFailure, send } from "@/server/mail/transport";

const sent = vi.mocked(send);

/** A Ctx is only used for its `db`, so the queue can be exercised without one. */
const ctx = { db } as never;

async function queue(to = "someone@example.invalid") {
  const { id } = await queueMail(ctx, { kind: "notification", to, subject: "Subject", text: "Body" });
  return id;
}

const rowFor = async (id: string) =>
  (await db.select().from(s.outboundMessages).where(eq(s.outboundMessages.id, id)))[0]!;

beforeEach(async () => {
  await db.delete(s.outboundMessages);
  sent.mockReset();
});

afterEach(async () => {
  await db.delete(s.outboundMessages);
});

describe("queueMail", () => {
  it("writes a queued row when a transport is configured", async () => {
    const row = await rowFor(await queue());
    expect(row.state).toBe("queued");
    expect(row.attempts).toBe(0);
  });
});

/**
 * Rows written before a transport existed.
 *
 * The claim predicate grew a `not_configured` arm and shipped with nothing
 * exercising it, which a reviewer pointed out and which is how the expiry hole
 * below went unnoticed: these are exactly the rows that pile up on a deployment
 * with no SMTP, and exactly the rows that all become sendable at once the moment
 * a key is configured.
 */
describe("reconciling a row a dead process abandoned", () => {
  it("takes the lease away, so a late success cannot undo the failure", async () => {
    /*
      Marking the row `failed` is only half of it.

      `reconcileStranded` used to leave `claim_id` set. If the original send was
      not dead but merely slow, and came back successful minutes later, its
      completion predicate still matched and rewrote `failed` to `sent` under an
      operator who had already been told delivery failed and may well have
      resent by hand. Clearing the claim makes that write miss, which is what
      `lostLease` counts and what the job warns about.
    */
    const id = newId();
    const staleClaim = newId();
    await db.insert(s.outboundMessages).values({
      id,
      kind: "invoice",
      toAddress: "client@example.invalid",
      ccAddresses: [],
      subject: "Subject",
      bodyText: "Body",
      state: "sending",
      attempts: 6,
      claimId: staleClaim,
    });
    // Claimed longer ago than the lease, which is what makes it reconcilable.
    await db.execute(
      sql`UPDATE outbound_messages SET next_attempt_at = now() - interval '10 minutes' WHERE id = ${id}`
    );

    expect((await drainMail()).reconciled).toBe(1);
    expect((await rowFor(id)).state).toBe("failed");

    // The original send finally returns. This is the exact write it makes.
    const won = await db
      .update(s.outboundMessages)
      .set({ state: "sent", sentAt: sql`now()` })
      .where(and(eq(s.outboundMessages.id, id), eq(s.outboundMessages.claimId, staleClaim)))
      .returning({ id: s.outboundMessages.id });

    expect(won, "the lease is gone, so the write must miss").toHaveLength(0);
    expect((await rowFor(id)).state, "and the operator's answer stands").toBe("failed");
  });
});

describe("messages queued before a transport existed", () => {
  /** Insert directly, because `queueMail` writes this state only when it cannot send. */
  async function queueUnconfigured(kind: string, ageDays: number, to = "person@example.invalid") {
    const id = newId();
    await db.insert(s.outboundMessages).values({
      id,
      kind: kind as never,
      toAddress: to,
      ccAddresses: [],
      subject: "Subject",
      bodyText: "Choose a password: http://localhost:3200/set-password?token=abcdef123456",
      state: "not_configured",
    });
    await db.execute(
      sql`UPDATE outbound_messages SET created_at = now() - make_interval(days => ${ageDays}) WHERE id = ${id}`
    );
    return id;
  }

  it("sends one once a transport appears", async () => {
    sent.mockResolvedValue({ messageId: null });
    const id = await queueUnconfigured("invoice", 0);

    expect((await drainMail()).sent).toBe(1);
    expect((await rowFor(id)).state).toBe("sent");
  });

  it("counts them in the queue depth, so the backlog is not invisible", async () => {
    await queueUnconfigured("invoice", 0);
    expect((await mailQueueDepth()).notConfigured).toBe(1);
  });

  it("refuses to send an invite whose link expired while it waited", async () => {
    /*
      The sharpest edge in the queue, and it only became reachable when
      `not_configured` rows became claimable.

      Configuring SendGrid would otherwise deliver every invite and every reset
      queued since the beginning, in one batch, to real staff addresses, each
      carrying a token that expired an hour or a week after it was minted and
      was superseded besides. A wave of unsolicited "Reset your Tally password"
      messages whose links do nothing is indistinguishable from phishing, and
      the people best placed to report it are the recipients.
    */
    sent.mockResolvedValue({ messageId: null });
    const id = await queueUnconfigured("invite", 21);

    const report = await drainMail();
    expect(report.expired, "failed rather than sent").toBe(1);
    expect(report.sent).toBe(0);
    expect(sent, "nothing may reach the transport").not.toHaveBeenCalled();

    const row = await rowFor(id);
    expect(row.state).toBe("failed");
    expect(row.lastError).toMatch(/expired/);
    expect(row.bodyText, "and the dead token is redacted on the way out").toContain("token=[redacted]");
  });

  it("refuses a password reset after an hour, not after a week", async () => {
    // The two kinds have different lives, and using one cutoff for both would
    // send hour-old resets or hold week-old invites. Two days is stale for a
    // reset and fresh for an invite.
    sent.mockResolvedValue({ messageId: null });
    const reset = await queueUnconfigured("password_reset", 2);
    const invite = await queueUnconfigured("invite", 2);

    const report = await drainMail();
    expect(report.expired).toBe(1);
    expect((await rowFor(reset)).state).toBe("failed");
    expect((await rowFor(invite)).state, "still well inside its seven days").toBe("sent");
  });

  it("leaves a late invoice email alone, because it is still worth sending", async () => {
    // The expiry is about dead credentials, not about age. An invoice chased
    // late is still an invoice the client should receive.
    sent.mockResolvedValue({ messageId: null });
    const id = await queueUnconfigured("invoice", 400);

    const report = await drainMail();
    expect(report.expired).toBe(0);
    expect((await rowFor(id)).state).toBe("sent");
  });

  it("does not expire an invite that is still inside its window", async () => {
    sent.mockResolvedValue({ messageId: null });
    const id = await queueUnconfigured("invite", 1);

    expect((await drainMail()).expired).toBe(0);
    expect((await rowFor(id)).state).toBe("sent");
  });
});

describe("drainMail", () => {
  it("sends a queued message and records the provider id", async () => {
    sent.mockResolvedValue({ messageId: "<abc@sendgrid>" });
    const id = await queue();

    const report = await drainMail();
    expect(report.sent).toBe(1);

    const row = await rowFor(id);
    expect(row.state).toBe("sent");
    expect(row.providerMessageId).toBe("<abc@sendgrid>");
    expect(row.sentAt).not.toBeNull();
  });

  it("retries a transient failure, with the next attempt in the future", async () => {
    sent.mockRejectedValue(new Error("451 greylisted, try again later"));
    const id = await queue();

    const report = await drainMail();
    expect(report.retrying).toBe(1);
    expect(report.failed).toBe(0);

    const row = await rowFor(id);
    expect(row.state).toBe("queued");
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain("greylisted");
    // Backoff: it must not be picked up again on the very next run.
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("does not retry a permanent refusal", async () => {
    // A 5xx means the address is wrong. Sending it again tomorrow produces the
    // same answer and spends the domain's reputation a second time.
    sent.mockRejectedValue(new PermanentSendFailure("550 no such mailbox"));
    const id = await queue();

    const report = await drainMail();
    expect(report.failed).toBe(1);

    const row = await rowFor(id);
    expect(row.state).toBe("failed");
    expect(row.attempts).toBe(1);
  });

  it("gives up after six attempts rather than retrying forever", async () => {
    sent.mockRejectedValue(new Error("connection refused"));
    const id = await queue();

    // Each run backs the row off, so the clock is wound forward between them.
    for (let i = 0; i < 6; i++) {
      await db
        .update(s.outboundMessages)
        .set({ nextAttemptAt: new Date(Date.now() - 1000) })
        .where(eq(s.outboundMessages.id, id));
      await drainMail();
    }

    const row = await rowFor(id);
    expect(row.attempts).toBe(6);
    expect(row.state).toBe("failed");
  });

  it("leaves a message alone until its backoff has elapsed", async () => {
    sent.mockResolvedValue({ messageId: null });
    const id = await queue();
    await db
      .update(s.outboundMessages)
      .set({ nextAttemptAt: new Date(Date.now() + 60_000) })
      .where(eq(s.outboundMessages.id, id));

    const report = await drainMail();
    expect(report.claimed).toBe(0);
    expect(sent).not.toHaveBeenCalled();
  });

  it("sends each message once when two runs overlap", async () => {
    // The claim takes a row lock and moves the row out of `queued` inside it,
    // so a concurrent run passes over it rather than sending it again.
    sent.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 40));
      return { messageId: null };
    });
    for (let i = 0; i < 4; i++) await queue(`person${i}@example.invalid`);

    const [a, b] = await Promise.all([drainMail(), drainMail()]);
    expect(a.sent + b.sent).toBe(4);
    expect(sent).toHaveBeenCalledTimes(4);

    const rows = await db.select().from(s.outboundMessages);
    expect(rows.every((r) => r.state === "sent")).toBe(true);
  });

  /**
   * The case the original concurrency test missed.
   *
   * It queued fresh rows, whose `next_attempt_at` is now, and a fresh row can
   * never satisfy the stuck-row predicate. Every row in a backlog, and every
   * retry whose backoff has elapsed, is already overdue, and those used to
   * become reclaimable the instant they were claimed.
   */
  it("does not let a second drain reclaim a row the first is still sending", async () => {
    const id = await queue();
    // Overdue by an hour, which is ordinary for a backlog or a late retry.
    await db
      .update(s.outboundMessages)
      .set({ nextAttemptAt: new Date(Date.now() - 60 * 60_000) })
      .where(eq(s.outboundMessages.id, id));

    /*
      The second drain has to start AFTER the first has claimed and committed,
      and WHILE it is still sending. Running both with Promise.all does not
      reproduce it: both reach the claim at once, and SKIP LOCKED already
      handles that, which is why the first version of this test passed against
      the bug it was written for.
    */
    let claimed!: () => void;
    const hasClaimed = new Promise<void>((r) => (claimed = r));

    sent.mockImplementation(async () => {
      claimed();
      await new Promise((r) => setTimeout(r, 200));
      return { messageId: null };
    });

    const first = drainMail();
    await hasClaimed;
    const second = await drainMail();
    const a = await first;

    expect(second.claimed, "a row being sent must not be reclaimed").toBe(0);
    expect(a.sent).toBe(1);
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it("stops reclaiming a row whose attempts are spent, however it died", async () => {
    // Only the catch path used to mark exhaustion, so a process dying inside
    // send() reclaimed and re-incremented for ever, well past the cap.
    const id = await queue();
    await db
      .update(s.outboundMessages)
      .set({
        state: "sending",
        attempts: 6,
        nextAttemptAt: new Date(Date.now() - 60 * 60_000),
      })
      .where(eq(s.outboundMessages.id, id));

    const report = await drainMail();
    expect(report.claimed).toBe(0);
    expect(sent).not.toHaveBeenCalled();
  });

  it("rescues a row abandoned mid-send with no attempts left", async () => {
    /*
      The hole the previous fix opened. Refusing to claim an exhausted row was
      right, and it made a row that died on its last attempt unclaimable: stuck
      in `sending`, counted by neither `queued` nor `failed`, invisible to
      anybody looking at the queue while the message was never going to be sent.
    */
    const id = await queue();
    await db.execute(
      sql`UPDATE outbound_messages SET state = 'sending', attempts = 6,
              next_attempt_at = now() - interval '1 hour' WHERE id = ${id}`
    );

    const report = await drainMail();
    expect(report.reconciled).toBe(1);

    const row = await rowFor(id);
    expect(row.state).toBe("failed");
    expect(row.lastError).toMatch(/abandoned mid-send/);
    expect((await mailQueueDepth()).failed).toBe(1);
  });

  it("does not disturb a row that is genuinely being sent right now", async () => {
    const id = await queue();
    await db
      .update(s.outboundMessages)
      .set({ state: "sending", attempts: 6 })
      .where(eq(s.outboundMessages.id, id));

    const report = await drainMail();
    expect(report.reconciled, "inside the timeout, so it is still in flight").toBe(0);
    expect((await rowFor(id)).state).toBe("sending");
  });

  it("ignores the result of a worker that overran its lease", async () => {
    /*
      The overlap test above only covers two drains inside the timeout, where
      the lease has not expired. The dangerous case is a worker that stalls past
      five minutes: another drain reclaims and sends, and then the first one
      wakes up. If its result were still accepted it could put an already-sent
      row back to `queued` and the message would go out a third time.
    */
    const id = await queue();

    let release!: () => void;
    const stalled = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const hasStarted = new Promise<void>((r) => (started = r));

    sent.mockImplementationOnce(async () => {
      started();
      await stalled;
      // The slow worker "succeeds", long after losing its claim.
      return { messageId: "from-the-stalled-worker" };
    });

    const slow = drainMail();
    await hasStarted;

    // Age the lease so the row looks abandoned, then let a second drain take it.
    await db.execute(sql`UPDATE outbound_messages SET next_attempt_at = now() - interval '1 hour' WHERE id = ${id}`);
    sent.mockResolvedValue({ messageId: "from-the-second-worker" });
    const second = await drainMail();
    expect(second.sent).toBe(1);

    release();
    const first = await slow;

    expect(first.lostLease, "the stalled worker must not write to a row it no longer owns").toBe(1);
    expect(first.sent).toBe(0);

    const row = await rowFor(id);
    expect(row.state).toBe("sent");
    expect(row.providerMessageId).toBe("from-the-second-worker");
  });

  it("respects the limit so one run cannot hold the process forever", async () => {
    sent.mockResolvedValue({ messageId: null });
    for (let i = 0; i < 5; i++) await queue(`person${i}@example.invalid`);

    const report = await drainMail({ limit: 2 });
    expect(report.sent).toBe(2);
  });
});
