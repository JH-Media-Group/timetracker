/**
 * POST /api/v1/auth/forgot
 *
 * Public. Begins a password reset.
 *
 * **A known and an unknown address are answered identically, and take the same
 * time.** Whether the address is known, archived, or an `@imported.invalid`
 * placeholder, the body, the status and the duration are indistinguishable.
 *
 * A malformed request or an exhausted rate limit does answer differently, which
 * is fine: neither says anything about whether an account exists. The claim is
 * about the enumeration channel, not about every response this route can make. A reply that
 * differed would make this an account enumeration endpoint on a public URL, and
 * knowing who works somewhere is most of the work of choosing a phishing target.
 *
 * The timing half is not theoretical. A review measured the first version of
 * this route: a known address took a median of 8.35ms because it wrote three
 * rows, an unknown one 1.43ms because it returned immediately, and the two
 * distributions did not overlap at all. Identical bodies and headers were
 * carrying a perfectly readable signal underneath.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requestPasswordReset } from "@/server/services/auth-tokens";
import { enforce } from "@/server/auth/rate-limit";
import { clientIp, parseOrThrow, problemResponse } from "@/server/http";
import { newId } from "@/server/db/ids";

const schema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address."),
});

const SAME_ANSWER = {
  data: { ok: true, detail: "If that address has an account, a reset link is on its way." },
};

/**
 * Every response takes at least this long.
 *
 * Comfortably above the slow branch's measured spread, so the work done inside
 * disappears into the floor. Cheap here: this endpoint is rate limited and a
 * person uses it perhaps twice a year, and a fixed cost is far easier to reason
 * about than trying to make two different amounts of work take equal time.
 */
const FLOOR_MS = 250;

export async function POST(req: NextRequest) {
  const requestId = newId();
  const startedAt = Date.now();

  const settle = async () => {
    const remaining = FLOOR_MS - (Date.now() - startedAt);
    if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
  };

  try {
    const ip = clientIp(req);
    const { email } = parseOrThrow(schema, await req.json().catch(() => ({})));

    /*
      Per address, and only when the address is known.

      A previous version fell back to a constant key when `clientIp()` returned
      null, which it does unless TRUST_PROXY says a proxy is setting
      X-Forwarded-For, and `.env.example` ships TRUST_PROXY=0. That put every
      caller on earth in one bucket: ten anonymous posts every fifteen minutes
      disabled password recovery for the whole company, and with SSO dropped
      this is the only way back in.

      `auth/signin` already carries this exact argument, three files away, and
      it was reintroduced here anyway. A shared bucket is not a weaker limit, it
      is a different mechanism: it rations everybody by the behaviour of one
      stranger. `tests/routes.test.ts` now fails on a constant limiter key so
      that it stays gone.

      What bounds this route without an address: the response floor caps one
      connection at four requests a second, and the per-address minute floor in `requestPasswordReset` caps mail and token writes.
    */
    if (ip) await enforce("auth", `forgot:ip:${ip}`);

    /*
      No per-address bucket. The service throttles by interval instead.

      A bucket keyed on the victim's address was a weapon either way round.
      Enforced, thirty posts locked a real person out of recovery for an hour.
      Consumed silently, they got "a reset link is on its way" and no link,
      which is the same denial with the honesty removed. `requestPasswordReset`
      now declines to issue only if it issued one in the last minute, which
      always expires and leaves the reassuring answer true.

      The per-address volume cap that bucket was nominally for is the same
      minute floor: one message per address per minute.
    */
    await requestPasswordReset(email);

    await settle();
    return NextResponse.json(SAME_ANSWER, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    /*
      Built once, and logged on the status actually returned.

      This used to call `toProblem` here and again inside `problemResponse`, and
      then gate the log on the first one. `problemResponse` answers from
      `fromDatabaseError(e) ?? e`, so the two could disagree: a database error
      that translates to a 4xx was still logged at error level as a failure.
    */
    const response = problemResponse(e, requestId);
    if (response.status >= 500) console.error(`[${requestId}] forgot failed`, e);

    // The floor applies to failures too, or the error path becomes the oracle.
    await settle();

    /*
      Through the shared builder, which is the only thing that sets Retry-After.

      Hand-rolling these headers meant a `rate_limited` answer from this route
      carried no Retry-After at all, so a client had nothing to back off on and
      the header existed on every other route in the application but this one.
      A reviewer noticed. Copying four headers is exactly the kind of duplicate
      that drifts from the original the moment the original gains a fifth.
    */
    return response;
  }
}
