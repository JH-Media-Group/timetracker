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

/**
 * The last answer, and when it was reached.
 *
 * This endpoint is unauthenticated and does not go through `route()`, so it
 * declares no rate-limit class and nothing meters it. Every call used to take a
 * connection from a pool capped at 12, which means an unauthenticated caller
 * could occupy pool slots at will, and would do the most damage exactly when
 * Postgres was already struggling, which is when the probe matters most.
 *
 * A cache fixes that without any of the machinery: a prober polling every 15
 * seconds does not need a fresh query per caller, and two seconds is far below
 * any sensible probe interval, so a real outage is still noticed within one
 * cycle. Concurrent callers during a slow query share the in-flight promise
 * rather than opening more connections.
 */
const TTL_MS = 2_000;
let cached: { at: number; ok: boolean } | null = null;
let inFlight: Promise<boolean> | null = null;

async function databaseAnswers(): Promise<boolean> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.ok;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    let ok = true;
    try {
      await db.execute(sql`SELECT 1`);
    } catch {
      ok = false;
    }
    cached = { at: Date.now(), ok };
    inFlight = null;
    return ok;
  })();

  return inFlight;
}

export async function GET() {
  try {
    if (!(await databaseAnswers())) throw new Error("unreachable");
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
