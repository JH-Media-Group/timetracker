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
      A ceiling even when the caller has no address.

      `clientIp()` returns null unless TRUST_PROXY says a proxy is setting
      X-Forwarded-For, and `.env.example` ships TRUST_PROXY=0, so `if (ip)`
      meant this endpoint had no limit at all in the configuration most likely
      to be running. Falling back to a shared bucket is coarse, and coarse is
      better than absent: the per-address minute floor and the response floor
      already bound the interesting work, so this only stops the crude case.
    */
    await enforce("auth", ip ? `reset:ip:${ip}` : "reset:no-client-ip");

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
