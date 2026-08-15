/**
 * POST /api/v1/auth/reset
 *
 * Public. Spends an invite or reset token and sets the password.
 *
 * Signs nobody in on success. The set-password page sends them to the sign-in
 * screen to use the password they just chose, which proves it works while they
 * are still paying attention rather than a week later.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { consumeToken } from "@/server/services/auth-tokens";
import { enforce } from "@/server/auth/rate-limit";
import { toProblem } from "@/server/errors";
import { clientIp, parseOrThrow } from "@/server/http";
import { newId } from "@/server/db/ids";

const schema = z.object({
  token: z.string().min(1, "That link is missing its token."),
  password: z.string().min(1, "Choose a password."),
});

export async function POST(req: NextRequest) {
  const requestId = newId();

  try {
    const ip = clientIp(req);
    const { token, password } = parseOrThrow(schema, await req.json().catch(() => ({})));

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
      connection at four requests a second, and the token lookup happens before any expensive work, so a junk request costs one indexed query.
    */
    if (ip) await enforce("auth", `reset:ip:${ip}`);

    await consumeToken(token, password);
    return NextResponse.json(
      { data: { ok: true } },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    const problem = toProblem(e, requestId);
    if (problem.status >= 500) console.error(`[${requestId}] reset failed`, e);
    return NextResponse.json(problem, {
      status: problem.status,
      headers: { "Content-Type": "application/problem+json", "Cache-Control": "private, no-store" },
    });
  }
}
