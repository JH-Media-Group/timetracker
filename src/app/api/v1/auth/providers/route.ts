/**
 * GET /api/v1/auth/providers
 *
 * What ways in exist. Public by necessity: the sign-in page has to render
 * before anybody has a session. It reports only whether a provider is
 * configured, never any part of the credential.
 */

import { NextResponse } from "next/server";
import { env } from "@/server/env";

export function GET() {
  return NextResponse.json(
    {
      data: {
        google: Boolean(env.google),
        password: true,
        hostedDomain: env.google ? env.GOOGLE_HOSTED_DOMAIN : null,
      },
    },
    { headers: { "Cache-Control": "private, no-store" } }
  );
}
