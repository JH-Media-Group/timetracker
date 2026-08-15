/**
 * POST /api/v1/auth/forgot
 *
 * Public. Begins a password reset.
 *
 * **Always answers the same way, and takes the same time doing it.** Whether
 * the address is known, archived, or an `@imported.invalid` placeholder, the
 * response, the status and the duration are indistinguishable. A reply that
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
import { consume, enforce } from "@/server/auth/rate-limit";
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

    if (ip) await enforce("auth", `forgot:ip:${ip}`);

    /*
      The per-address bucket limits *sending*, and never refuses the request.

      It used to `enforce`, which threw a 429 once the bucket was empty. That
      let anybody lock a chosen person out of the only self-service recovery
      path there is, now that SSO is gone: thirty posts an hour at somebody's
      address and their own reset attempts start bouncing. A reviewer did it in
      31 requests.

      Consuming without throwing keeps the protection that matters, which is a
      cap on how much mail one address can be sent, and drops the part that was
      a weapon. When the bucket is empty we simply do not issue: any link
      already sent stays valid for its full hour, and the caller cannot tell,
      because the answer and the timing are the same either way.
    */
    const budget = await consume("email", `forgot:addr:${email}`);
    if (budget.allowed) await requestPasswordReset(email);

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
