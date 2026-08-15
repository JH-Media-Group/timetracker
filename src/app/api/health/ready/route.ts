import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/server/db/client";

/**
 * Readiness: should this instance be sent traffic?
 *
 * This one does reach Postgres, because an app that cannot reach its database
 * serves errors to every request it accepts. The deploy pipeline in
 * BACKEND_PRD §17.4 polls this for 90 seconds after a container swap and rolls
 * back if it never turns green, so the check has to be the one that would
 * actually notice a broken release: a migration that did not run, or a
 * `DATABASE_URL` pointing somewhere it cannot reach.
 *
 * It returns 503 rather than 200-with-a-sad-body, because a load balancer reads
 * the status code and nothing else.
 *
 * The error detail is deliberately not echoed. This endpoint is unauthenticated
 * so that a proxy can poll it before anybody signs in, and a connection error
 * from Postgres carries the host, the port and the user name.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await db.execute(sql`SELECT 1`);
    return NextResponse.json(
      { data: { status: "ok", database: "ok" } },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    return NextResponse.json(
      { data: { status: "degraded", database: "unreachable" } },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
}
