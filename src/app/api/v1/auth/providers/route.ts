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
        // False until the callback route exists, whatever the environment says.
        // Reporting a provider whose sign-in link 404s is worse than not
        // offering it: the person clicks the button they were told to use and
        // lands on an error page.
        google: false,
        googleConfigured: Boolean(env.google),
        password: true,
        hostedDomain: env.google ? env.GOOGLE_HOSTED_DOMAIN : null,
      },
    },
    { headers: { "Cache-Control": "private, no-store" } }
  );
}
