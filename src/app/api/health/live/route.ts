import { NextResponse } from "next/server";

/**
 * Liveness: is this process running and able to answer?
 *
 * **This must not touch the database, and that is the whole point of it being
 * separate from `ready`.** The container healthcheck in BACKEND_PRD §17.1 polls
 * this endpoint, and an unhealthy container gets restarted. If liveness went to
 * Postgres, a database blip would restart every web container that could not
 * reach it, which does not fix the database and turns a recoverable outage into
 * a restart loop against a server already under strain.
 *
 * Liveness answers "should this process be killed and replaced". Readiness
 * answers "should traffic be sent here". They fail for different reasons and a
 * single endpoint cannot mean both.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  /*
    One exception to "touches nothing": a process running on build placeholders
    is not alive in any useful sense and must not be reported as healthy.

    A review started this image with `NEXT_PHASE=phase-production-build` and no
    `SESSION_SECRET`. Validation was skipped, the container came up, Docker
    marked it healthy, and it served a sign-in page that could never sign anyone
    in. Throwing from `register()` did not stop it: Next fails the boot on an
    error while *loading* the instrumentation module, but a throw from inside
    `register()` did not take the server down.

    So the state is reported where an orchestrator will actually read it. This
    is also the only consumer of `usingBuildPlaceholders`, which a review
    correctly called an orphan when nothing read it.
  */
  const { env } = await import("@/server/env");

  if (env.usingBuildPlaceholders) {
    return NextResponse.json(
      { data: { status: "misconfigured", detail: "running on build placeholders; unset NEXT_PHASE" } },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }

  return NextResponse.json(
    { data: { status: "ok" } },
    { headers: { "Cache-Control": "no-store" } }
  );
}
