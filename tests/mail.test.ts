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

import { eq } from "drizzle-orm";
import { db } from "@/server/db/client";
import * as s from "@/server/db/schema";
import { newId } from "@/server/db/ids";
import { drainMail, queueMail } from "@/server/services/mail";
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

  it("respects the limit so one run cannot hold the process forever", async () => {
    sent.mockResolvedValue({ messageId: null });
    for (let i = 0; i < 5; i++) await queue(`person${i}@example.invalid`);

    const report = await drainMail({ limit: 2 });
    expect(report.sent).toBe(2);
  });
});
