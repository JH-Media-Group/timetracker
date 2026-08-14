import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/server/db/client";

/**
 * Liveness and readiness in one.
 *
 * Readiness means the database answers, because an app that cannot reach
 * Postgres is not ready for traffic however healthy its process looks.
 */
export async function GET() {
  try {
    await db.execute(sql`SELECT 1`);
    return NextResponse.json(
      { data: { status: "ok", database: "ok" } },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    return NextResponse.json(
      { data: { status: "degraded", database: "unreachable", detail: e instanceof Error ? e.message : "unknown" } },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
}
