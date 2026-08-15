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

import { and, asc, eq, isNotNull, lt, or, sql } from "drizzle-orm";
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

/** Kinds whose body carries a single-use credential in its link. */
const AUTH_KINDS = new Set(["invite", "password_reset"]);

/** A row claimed for longer than this is assumed abandoned by a dead run. */
const SENDING_TIMEOUT_SECONDS = 5 * 60;

/**
 * Exponential, in minutes: 1, 2, 4, 8, 16, 32.
 *
 * Long enough that a greylist has cleared by the second attempt and an outage
 * is not hammered, short enough that a password reset still arrives while the
 * person is waiting for it.
 *
 * Takes the number of attempts already made, so the first failure (attempts=1)
 * waits one minute. The comment used to say 1,2,4,... while the code produced
 * 2,4,8,... because it was handed the post-increment count; the sequence a
 * reviewer measured did not match the sequence written directly above it.
 */
const backoffSeconds = (attemptsMade: number) => Math.min(2 ** (attemptsMade - 1), 32) * 60;

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
  /** Rows a dead process left behind that had no attempts left, moved to `failed`. */
  reconciled: number;
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
  const report: DrainReport = { claimed: 0, sent: 0, retrying: 0, failed: 0, reconciled: 0, skipped: null };

  // One question, one answer. `canSend` already accounts for the disk sink.
  if (!canSend()) {
    report.skipped = "no_transport";
    return report;
  }

  report.reconciled = await reconcileStranded();

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
        .set({
          state: "sent",
          sentAt: sql`now()`,
          providerMessageId: result.messageId,
          lastError: null,
          /*
            A single-use credential must not outlive its use.

            `body_text` holds the rendered email, and for an invite or a reset
            that includes the set-password link, token and all. A reviewer
            proved the point by hashing a stored token and matching it to
            `auth_tokens.token_hash` in the next table along: the raw token sat
            beside its own digest, which makes the hashing this file argues for
            worth nothing to anybody holding a backup. Redacted on the way to a
            terminal state, so the exposure lasts one drain interval rather than
            for ever.
          */
          bodyText: AUTH_KINDS.has(claimed.kind)
            ? sql`regexp_replace(${s.outboundMessages.bodyText}, 'token=[A-Za-z0-9_-]+', 'token=[redacted]', 'g')`
            : undefined,
        })
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
          nextAttemptAt: sql`now() + make_interval(secs => ${backoffSeconds(attempts)})`,
          // Same reasoning as the success path: a message that will never be
          // sent must not keep a live token in the table.
          bodyText:
            exhausted && AUTH_KINDS.has(claimed.kind)
              ? sql`regexp_replace(${s.outboundMessages.bodyText}, 'token=[A-Za-z0-9_-]+', 'token=[redacted]', 'g')`
              : undefined,
        })
        .where(eq(s.outboundMessages.id, claimed.id));

      if (exhausted) report.failed++;
      else report.retrying++;
    }
  }

  return report;
}

/**
 * Move abandoned, exhausted rows to `failed` so nothing is invisible.
 *
 * **This exists because the previous fix created the hole it closes.** Adding
 * `attempts < MAX_ATTEMPTS` to the claim predicate correctly stopped a crash
 * loop re-incrementing for ever, and in doing so made a row that died mid-send
 * on its last attempt unclaimable: it sat in `sending`, was counted by neither
 * `queued` nor `failed`, and an operator looking at the queue saw nothing
 * wrong while a message was never going to be sent. Silent non-delivery is the
 * outcome this whole design is arranged to avoid, and a fix to a smaller
 * problem reintroduced it.
 *
 * The timeout still applies, so a row being sent right now is not touched.
 */
async function reconcileStranded(): Promise<number> {
  const rows = await db
    .update(s.outboundMessages)
    .set({
      state: "failed",
      lastError: sql`coalesce(${s.outboundMessages.lastError}, 'abandoned mid-send with no attempts left')`,
    })
    .where(
      and(
        eq(s.outboundMessages.state, "sending"),
        sql`${s.outboundMessages.attempts} >= ${MAX_ATTEMPTS}`,
        sql`${s.outboundMessages.nextAttemptAt} <= now() - make_interval(secs => ${SENDING_TIMEOUT_SECONDS})`
      )
    )
    .returning({ id: s.outboundMessages.id });

  return rows.length;
}

/**
 * Take one message, under a lock, and mark it `sending` before returning.
 *
 * `SKIP LOCKED` is what lets two runs overlap safely: the second passes over
 * anything the first is holding rather than blocking on it. `attempts` is
 * incremented here rather than on failure, so a row that kills the process
 * still counts its try and cannot loop forever.
 *
 * TWO THINGS A REVIEW BROKE, BOTH ABOUT ROWS THAT ARE ALREADY LATE
 *
 * The claim used to leave `next_attempt_at` alone. For a row queued a moment
 * ago that is harmless, which is exactly what the concurrency test used and
 * why it passed. For any row already more than `SENDING_TIMEOUT_MS` overdue,
 * which is every row in a backlog and every retry whose backoff has elapsed,
 * the row satisfied the stuck-row predicate the instant it was claimed: a
 * second drain could pick it up and send it while the first was still sending.
 * The claim now stamps `next_attempt_at`, so the timeout is measured from the
 * claim rather than from whenever the row became due.
 *
 * And the claim did not look at `attempts`. Only the catch path marked a row
 * exhausted, so a process dying inside `send()` reclaimed and re-incremented
 * for ever, well past the cap. The predicate now refuses a row that has spent
 * its attempts, whatever state it is in.
 */
async function claimOne() {
  const rows = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(s.outboundMessages)
      .where(
        and(
          /*
            Both sides of every time comparison come from the database clock.

            `next_attempt_at` is written by Postgres, and this used to compare it
            against `new Date()` from Node. Two clocks, and any skew between the
            app container and the database makes a due row look not yet due. It
            showed up first as a test that failed about one run in five, which is
            the polite version of the same bug: on a droplet whose clock has
            drifted a second, mail simply sits there.
          */
          sql`${s.outboundMessages.nextAttemptAt} <= now()`,
          lt(s.outboundMessages.attempts, MAX_ATTEMPTS),
          or(
            eq(s.outboundMessages.state, "queued"),
            // Reclaim a row a dead run left behind. Measured from the claim,
            // which is what `next_attempt_at` records once a row is `sending`.
            and(
              eq(s.outboundMessages.state, "sending"),
              sql`${s.outboundMessages.nextAttemptAt} <= now() - make_interval(secs => ${SENDING_TIMEOUT_SECONDS})`
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
      // `next_attempt_at` becomes the claim time, so the stuck-row timeout runs
      // from now rather than from whenever this row first became due.
      .set({ state: "sending", attempts: row.attempts + 1, nextAttemptAt: sql`now()` })
      .where(eq(s.outboundMessages.id, row.id));

    return [row];
  });

  return rows[0] ?? null;
}

/**
 * What is waiting, for the job's own reporting and for a health view.
 *
 * `sending` is counted too. It was omitted, so a row stuck in that state was
 * absent from every number an operator could look at, which is the same as not
 * existing right up until a client asks where their invoice is.
 */
export async function mailQueueDepth(): Promise<{ queued: number; sending: number; failed: number }> {
  const [row] = await db.execute<{ queued: string; sending: string; failed: string }>(sql`
    SELECT count(*) FILTER (WHERE state = 'queued')::text  AS queued,
           count(*) FILTER (WHERE state = 'sending')::text AS sending,
           count(*) FILTER (WHERE state = 'failed')::text  AS failed
      FROM outbound_messages
  `);
  return {
    queued: Number(row?.queued ?? 0),
    sending: Number(row?.sending ?? 0),
    failed: Number(row?.failed ?? 0),
  };
}

/**
 * Messages about one thing, oldest first, for a timeline.
 *
 * Its comment used to say "newest first" while it ordered ascending, which a
 * reviewer noticed precisely because nothing calls it: an unused function whose
 * documentation disagrees with its code is a trap set for whoever calls it
 * first. Kept because the invoice timeline wants it, with the comment now
 * matching what it does.
 */
export async function messagesFor(relatedType: string, relatedId: string) {
  return db
    .select()
    .from(s.outboundMessages)
    .where(and(eq(s.outboundMessages.relatedType, relatedType), eq(s.outboundMessages.relatedId, relatedId)))
    .orderBy(asc(s.outboundMessages.createdAt));
}
