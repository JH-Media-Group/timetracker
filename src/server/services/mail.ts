/**
 * The outbound mail queue (TALLY-49).
 *
 * WHY A QUEUE AND NOT A SEND
 *
 * Every mutating request runs inside a transaction. Sending during one means an
 * email goes out and the transaction then rolls back, so the client has an
 * invoice we have no record of issuing. Queueing writes a row in the same
 * transaction as the thing it describes: either both survive or neither does.
 *
 * It also means a slow or unreachable SMTP server delays nobody's request.
 *
 * WHAT MAKES IT SAFE TO RUN TWICE
 *
 * The drain claims rows with `FOR UPDATE SKIP LOCKED` and moves them to
 * `sending` inside that lock, so two overlapping runs cannot pick the same row.
 * A crash between the send and the record leaves a row in `sending`, which the
 * next run reclaims after a timeout: **that can send twice**. Deliberate. A
 * duplicate invoice email is an awkward moment; an invoice that was never sent
 * and looks sent is a payment nobody chases.
 */

import { and, asc, eq, isNotNull, lte, or, sql } from "drizzle-orm";
import type { Ctx } from "@/server/ctx";
import { db } from "@/server/db/client";
import * as s from "@/server/db/schema";
import { newId } from "@/server/db/ids";
import { canSend, PermanentSendFailure, send } from "@/server/mail/transport";

export interface QueuedMail {
  kind: "invite" | "password_reset" | "invoice" | "reminder" | "thank_you" | "notification";
  to: string;
  cc?: string[];
  subject: string;
  text: string;
  relatedType?: string;
  relatedId?: string;
  userId?: string;
}

/** Attempts after which a message stops being retried. */
const MAX_ATTEMPTS = 6;

/** A row claimed for longer than this is assumed abandoned by a dead run. */
const SENDING_TIMEOUT_MS = 5 * 60_000;

/**
 * Exponential, in minutes: 1, 2, 4, 8, 16, 32.
 *
 * Long enough that a greylist has cleared by the second attempt and an outage
 * is not hammered, short enough that a password reset still arrives while the
 * person is waiting for it.
 */
const backoffMs = (attempts: number) => Math.min(2 ** attempts, 32) * 60_000;

/**
 * Queue a message. Call inside the transaction that produced it.
 *
 * With no transport configured the row is written `not_configured` rather than
 * `queued`, so it never sits pretending to be on its way. This is the same
 * honesty `invoice_messages.delivery_state` already practises.
 */
export async function queueMail(ctx: Ctx, mail: QueuedMail): Promise<{ id: string; queued: boolean }> {
  const id = newId();
  const configured = canSend();

  await ctx.db.insert(s.outboundMessages).values({
    id,
    kind: mail.kind,
    toAddress: mail.to,
    ccAddresses: mail.cc ?? [],
    subject: mail.subject,
    bodyText: mail.text,
    state: configured ? "queued" : "not_configured",
    relatedType: mail.relatedType ?? null,
    relatedId: mail.relatedId ?? null,
    userId: mail.userId ?? null,
  });

  return { id, queued: configured };
}

export interface DrainReport {
  claimed: number;
  sent: number;
  retrying: number;
  failed: number;
  skipped: "no_transport" | null;
}

/**
 * Send what is due. Called by `pnpm jobs:mail`, never by a request.
 *
 * Takes no `Ctx` because it is not somebody's action and writes no audit row:
 * the queue row is its own record, and an audit entry per email would bury the
 * log in machine noise. The thing that produced the message audited it.
 */
export async function drainMail(options: { limit?: number } = {}): Promise<DrainReport> {
  const report: DrainReport = { claimed: 0, sent: 0, retrying: 0, failed: 0, skipped: null };

  if (!canSend() && process.env.MAIL_TO_DISK !== "1") {
    report.skipped = "no_transport";
    return report;
  }

  const limit = options.limit ?? 50;

  for (let i = 0; i < limit; i++) {
    const claimed = await claimOne();
    if (!claimed) break;
    report.claimed++;

    try {
      const result = await send({
        to: claimed.toAddress,
        cc: Array.isArray(claimed.ccAddresses) ? (claimed.ccAddresses as string[]) : [],
        subject: claimed.subject,
        text: claimed.bodyText,
      });

      await db
        .update(s.outboundMessages)
        .set({ state: "sent", sentAt: new Date(), providerMessageId: result.messageId, lastError: null })
        .where(eq(s.outboundMessages.id, claimed.id));
      report.sent++;
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      const permanent = e instanceof PermanentSendFailure;
      const attempts = claimed.attempts + 1;
      const exhausted = permanent || attempts >= MAX_ATTEMPTS;

      await db
        .update(s.outboundMessages)
        .set({
          state: exhausted ? "failed" : "queued",
          lastError: detail.slice(0, 1000),
          nextAttemptAt: new Date(Date.now() + backoffMs(attempts)),
        })
        .where(eq(s.outboundMessages.id, claimed.id));

      if (exhausted) report.failed++;
      else report.retrying++;
    }
  }

  return report;
}

/**
 * Take one message, under a lock, and mark it `sending` before returning.
 *
 * `SKIP LOCKED` is what lets two runs overlap safely: the second passes over
 * anything the first is holding rather than blocking on it. `attempts` is
 * incremented here rather than on failure, so a row that kills the process
 * still counts its try and cannot loop forever.
 */
async function claimOne() {
  const rows = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(s.outboundMessages)
      .where(
        and(
          lte(s.outboundMessages.nextAttemptAt, new Date()),
          or(
            eq(s.outboundMessages.state, "queued"),
            // Reclaim a row a dead run left behind.
            and(
              eq(s.outboundMessages.state, "sending"),
              lte(s.outboundMessages.nextAttemptAt, new Date(Date.now() - SENDING_TIMEOUT_MS))
            )
          )
        )
      )
      .orderBy(asc(s.outboundMessages.nextAttemptAt))
      .limit(1)
      .for("update", { skipLocked: true });

    if (!row) return [];

    await tx
      .update(s.outboundMessages)
      .set({ state: "sending", attempts: row.attempts + 1 })
      .where(eq(s.outboundMessages.id, row.id));

    return [row];
  });

  return rows[0] ?? null;
}

/** What is waiting, for the job's own reporting and for a health view. */
export async function mailQueueDepth(): Promise<{ queued: number; failed: number }> {
  const [row] = await db.execute<{ queued: string; failed: string }>(sql`
    SELECT count(*) FILTER (WHERE state = 'queued')::text AS queued,
           count(*) FILTER (WHERE state = 'failed')::text AS failed
      FROM outbound_messages
  `);
  return { queued: Number(row?.queued ?? 0), failed: Number(row?.failed ?? 0) };
}

/** Messages about one thing, newest first. Used by the invoice timeline. */
export async function messagesFor(relatedType: string, relatedId: string) {
  return db
    .select()
    .from(s.outboundMessages)
    .where(
      and(
        eq(s.outboundMessages.relatedType, relatedType),
        eq(s.outboundMessages.relatedId, relatedId),
        isNotNull(s.outboundMessages.id)
      )
    )
    .orderBy(asc(s.outboundMessages.createdAt));
}
