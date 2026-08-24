import { NextResponse } from "next/server";
import { env } from "@/server/env";
export const GET = async () => NextResponse.json({ resource: `${env.APP_URL.replace(/\/$/, "")}/mcp`, authorization_servers: [env.APP_URL], scopes_supported: ["tally.read", "tally.time.write", "tally.expenses", "tally.approvals", "tally.admin"] }, { headers: { "cache-control": "public, max-age=3600" } });
