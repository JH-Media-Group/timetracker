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

/**
 * Every response takes at least this long.
 *
 * The sibling `forgot` route has one to close a timing oracle. This one has it
 * for the other reason: with `TRUST_PROXY=0`, which is what `.env.example`
 * ships, `clientIp()` returns null and the limiter below never runs, so without
 * a floor there is no bound on this endpoint at all. A comment here used to
 * claim the floor as a mitigation while the floor lived only in the other file,
 * which a reviewer caught. Rather than delete the claim, the thing it claimed
 * now exists.
 *
 * A floor bounds one connection, not many, so it is a speed bump and not a
 * rate limit. The real bound is `TRUST_PROXY=1` behind the reverse proxy, and
 * the deployment notes say so.
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

      What bounds this route without an address, stated accurately: a cheap
      sha256 lookup decides whether the expensive argon2 hash is worth doing, so
      a junk token costs one indexed query rather than 25ms of CPU, and the
      response floor above costs an attacker one connection per four requests a
      second. Neither is a rate limit, and many connections defeat both. The
      control that actually bounds this endpoint is `TRUST_PROXY=1` in front of
      a proxy that sets X-Forwarded-For, which makes the limiter below apply.
    */
    if (ip) await enforce("auth", `reset:ip:${ip}`);

    await consumeToken(token, password);

    await settle();
    return NextResponse.json(
      { data: { ok: true } },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    const problem = toProblem(e, requestId);
    if (problem.status >= 500) console.error(`[${requestId}] reset failed`, e);

    // The floor applies to failures too, or the cheap path becomes the fast one
    // and the endpoint tells an attacker which tokens exist.
    await settle();
    return NextResponse.json(problem, {
      status: problem.status,
      headers: { "Content-Type": "application/problem+json", "Cache-Control": "private, no-store" },
    });
  }
}
