import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/server/db/client";

/**
 * Liveness and readiness in one, kept for anything already pointed at it.
 *
 * **Prefer `/api/health/live` and `/api/health/ready`.** Splitting them is not
 * pedantry: this endpoint reports 503 when Postgres is unreachable, and used as
 * a container healthcheck that restarts a web process which is itself perfectly
 * fine. See the comment on `live/route.ts`.
 *
 * This behaves as `ready` does.
 */
export async function GET() {
  try {
    await db.execute(sql`SELECT 1`);
    return NextResponse.json(
      { data: { status: "ok", database: "ok" } },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    // The detail used to be echoed here. This endpoint is unauthenticated so a
    // proxy can poll it before anybody signs in, and a Postgres connection
    // error names the host, the port and the user.
    return NextResponse.json(
      { data: { status: "degraded", database: "unreachable" } },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
}
