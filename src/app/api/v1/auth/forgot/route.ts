/**
 * POST /api/v1/auth/forgot
 *
 * Public. Begins a password reset.
 *
 * **Always answers the same way.** Whether the address is known, archived, or
 * an `@imported.invalid` placeholder, the response and the status are
 * identical. A reply that differed would make this an account enumeration
 * endpoint on a public URL, and knowing who works somewhere is most of the work
 * of choosing a phishing target.
 *
 * Rate limited on both axes the abuse moves along: the caller's address, and
 * the mailbox being targeted. Without the second, one attacker can flood one
 * person's inbox from many addresses.
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

export async function POST(req: NextRequest) {
  const requestId = newId();

  try {
    const ip = clientIp(req);
    const { email } = parseOrThrow(schema, await req.json().catch(() => ({})));

    if (ip) await enforce("auth", `forgot:ip:${ip}`);
    await enforce("email", `forgot:addr:${email}`);

    await requestPasswordReset(email);
    return NextResponse.json(SAME_ANSWER, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const problem = toProblem(e, requestId);
    if (problem.status >= 500) console.error(`[${requestId}] forgot failed`, e);
    return NextResponse.json(problem, {
      status: problem.status,
      headers: { "Content-Type": "application/problem+json", "Cache-Control": "private, no-store" },
    });
  }
}
