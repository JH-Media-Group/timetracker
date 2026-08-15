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
import { toProblem } from "@/server/errors";
import { clientIp, parseOrThrow } from "@/server/http";
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
      A ceiling even when the caller has no address.

      `clientIp()` returns null unless TRUST_PROXY says a proxy is setting
      X-Forwarded-For, and `.env.example` ships TRUST_PROXY=0, so `if (ip)`
      meant this endpoint had no limit at all in the configuration most likely
      to be running. Falling back to a shared bucket is coarse, and coarse is
      better than absent: the per-address minute floor and the response floor
      already bound the interesting work, so this only stops the crude case.
    */
    await enforce("auth", ip ? `forgot:ip:${ip}` : "forgot:no-client-ip");

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
    const problem = toProblem(e, requestId);
    if (problem.status >= 500) console.error(`[${requestId}] forgot failed`, e);

    // The floor applies to failures too, or the error path becomes the oracle.
    await settle();
    return NextResponse.json(problem, {
      status: problem.status,
      headers: { "Content-Type": "application/problem+json", "Cache-Control": "private, no-store" },
    });
  }
}
