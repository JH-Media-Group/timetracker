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
 * next run reclaims after a timeout, **so a message can be sent more than
 * once**. Deliberate. A duplicate invoice email is an awkward moment; an invoice
 * that was never sent and looks sent is a payment nobody chases.
 *
 * This said "can send twice", which understated it: the reclaim happens on every
 * run and the claim allows six attempts, so a process wedged past its lease can
 * have the same message go out up to six times. In practice the transport caps a
 * socket at twenty seconds, so it takes a stalled process rather than a stalled
 * connection, but the number in the comment was simply wrong.
 */

import { and, asc, eq, lt, or, sql } from "drizzle-orm";
import type { Ctx } from "@/server/ctx";
import { db } from "@/server/db/client";
import * as s from "@/server/db/schema";
import { newId } from "@/server/db/ids";
import { canSend, PermanentSendFailure, send } from "@/server/mail/transport";
import { TOKEN_TTL_MS, type TokenPurpose } from "@/server/auth/token-ttl";

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

/**
 * Kinds whose body carries a single-use credential in its link.
 *
 * Typed as `TokenPurpose`, not `string`, so that adding a kind here without a
 * matching entry in `TOKEN_TTL_MS` fails to compile. Untyped, the expiry sweep
 * below would compute `undefined / 1000`, bind `NaN` into `make_interval`, and
 * throw at the top of every drain, which would stop all mail rather than the
 * one kind somebody had just added.
 */
const AUTH_KINDS = new Set<TokenPurpose>(["invite", "password_reset"]);

/** Narrows a row's `kind`, which the database types only as text. */
const carriesCredential = (kind: string): boolean => AUTH_KINDS.has(kind as TokenPurpose);

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
  /** Sends whose result was discarded because another worker had taken the row. */
  lostLease: number;
  /** Invites and resets failed unsent because their link had already expired. */
  expired: number;
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
  const report: DrainReport = {
    claimed: 0,
    sent: 0,
    retrying: 0,
    failed: 0,
    reconciled: 0,
    lostLease: 0,
    expired: 0,
    skipped: null,
  };

  // One question, one answer. `canSend` already accounts for the disk sink.
  if (!canSend()) {
    report.skipped = "no_transport";
    return report;
  }

  report.reconciled = await reconcileStranded();
  report.expired = await expireUndeliverableAuthMail();

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

      const won = await db
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
          bodyText: carriesCredential(claimed.kind)
            ? sql`regexp_replace(${s.outboundMessages.bodyText}, 'token=[A-Za-z0-9_-]+', 'token=[redacted]', 'g')`
            : undefined,
        })
        .where(and(eq(s.outboundMessages.id, claimed.id), eq(s.outboundMessages.claimId, claimed.claimId!)))
        .returning({ id: s.outboundMessages.id });

      /*
        Only count it if this worker still held the lease.

        A drain that overran its five minutes has already been reclaimed, and
        another worker has sent the message. Writing `sent` here anyway would be
        harmless; writing `queued` from the failure path below would not, and
        the row would go out a third time. Losing the lease means this result is
        somebody else's business now.
      */
      if (won.length) report.sent++;
      else report.lostLease++;
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      const permanent = e instanceof PermanentSendFailure;
      const attempts = claimed.attempts + 1;
      const exhausted = permanent || attempts >= MAX_ATTEMPTS;

      const won = await db
        .update(s.outboundMessages)
        .set({
          state: exhausted ? "failed" : "queued",
          lastError: detail.slice(0, 1000),
          nextAttemptAt: sql`now() + make_interval(secs => ${backoffSeconds(attempts)})`,
          // Same reasoning as the success path: a message that will never be
          // sent must not keep a live token in the table.
          bodyText:
            exhausted && carriesCredential(claimed.kind)
              ? sql`regexp_replace(${s.outboundMessages.bodyText}, 'token=[A-Za-z0-9_-]+', 'token=[redacted]', 'g')`
              : undefined,
        })
        .where(and(eq(s.outboundMessages.id, claimed.id), eq(s.outboundMessages.claimId, claimed.claimId!)))
        .returning({ id: s.outboundMessages.id });

      if (!won.length) report.lostLease++;
      else if (exhausted) report.failed++;
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
      /*
        Take the lease away, or this decision is not final.

        Marking the row `failed` while leaving `claim_id` set meant the original
        send could still be alive: if it came back successful minutes later its
        completion predicate still matched, and it rewrote `failed` to `sent`
        under an operator who had already been told delivery failed and may have
        resent by hand. Clearing the claim makes that write miss, which is what
        `lostLease` counts and warns about. A reviewer found this: the comment
        above the completion check says "losing the lease means this result is
        somebody else's business now", and reconciliation was not actually
        taking the lease away.
      */
      claimId: null,
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
 * Refuse to send an invite or a reset whose link is already dead.
 *
 * **The `not_configured` arm made this urgent, and it is the sharpest edge in
 * this file.** Those rows used to be unsendable for ever, so their age did not
 * matter. Now they are claimable, which means the first `pnpm jobs:mail` after
 * SendGrid is configured delivers every invite and every password reset queued
 * since the beginning, in one batch, to real staff addresses. The tokens they
 * carry expired an hour or a week after they were minted, and `issue()`
 * supersedes an outstanding token every time a newer one is made, so the links
 * are dead twice over. To the people receiving them, a sudden wave of
 * "Reset your Tally password" that nobody asked for and whose links do nothing
 * is indistinguishable from a phishing campaign, and it is the sort of thing
 * that gets a sending domain reported by its own staff.
 *
 * A reviewer reproduced it with a 21 day old reset: the drain sent it.
 *
 * So a message whose credential has outlived its TTL is failed rather than
 * sent, with the reason recorded and the dead token redacted out of the body.
 * Nothing is lost: whoever needs an invite can be sent one, and the reset page
 * is one click away. Non-auth mail is untouched, because a late invoice email
 * is still worth sending.
 */
async function expireUndeliverableAuthMail(): Promise<number> {
  const rows = await db
    .update(s.outboundMessages)
    .set({
      state: "failed",
      lastError: "the link in this message expired before a transport existed to send it",
      bodyText: sql`regexp_replace(${s.outboundMessages.bodyText}, 'token=[A-Za-z0-9_-]+', 'token=[redacted]', 'g')`,
    })
    .where(
      and(
        or(eq(s.outboundMessages.state, "queued"), eq(s.outboundMessages.state, "not_configured")),
        or(
          ...[...AUTH_KINDS].map((kind) =>
            and(
              eq(s.outboundMessages.kind, kind),
              // The database clock on both sides, as everywhere else here.
              sql`${s.outboundMessages.createdAt} < now() - make_interval(secs => ${
                TOKEN_TTL_MS[kind] / 1000
              })`
            )
          )
        )
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
            /*
              Messages written before a transport existed.

              `not_configured` records that nothing was attempted, which is
              honest, and it was also a state nothing could leave: every invite,
              reset and invoice queued before SendGrid is configured stayed
              there for ever, still holding a live token, and the depth report
              did not count them so the queue looked empty. That is today's
              deployment, not a hypothetical. Configuring a transport now picks
              them up on the next run.
            */
            eq(s.outboundMessages.state, "not_configured"),
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

    const claimId = newId();

    await tx
      .update(s.outboundMessages)
      // `next_attempt_at` becomes the claim time, so the stuck-row timeout runs
      // from now rather than from whenever this row first became due.
      .set({ state: "sending", attempts: row.attempts + 1, nextAttemptAt: sql`now()`, claimId })
      .where(eq(s.outboundMessages.id, row.id));

    return [{ ...row, claimId }];
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
export async function mailQueueDepth(): Promise<{
  queued: number;
  sending: number;
  failed: number;
  notConfigured: number;
}> {
  const [row] = await db.execute<Record<string, string>>(sql`
    SELECT count(*) FILTER (WHERE state = 'queued')::text          AS queued,
           count(*) FILTER (WHERE state = 'sending')::text         AS sending,
           count(*) FILTER (WHERE state = 'failed')::text          AS failed,
           count(*) FILTER (WHERE state = 'not_configured')::text  AS not_configured
      FROM outbound_messages
  `);
  return {
    queued: Number(row?.queued ?? 0),
    sending: Number(row?.sending ?? 0),
    failed: Number(row?.failed ?? 0),
    notConfigured: Number(row?.not_configured ?? 0),
  };
}
