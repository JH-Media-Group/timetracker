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
  return NextResponse.json(
    { data: { status: "ok" } },
    { headers: { "Cache-Control": "no-store" } }
  );
}
