import { NextResponse } from "next/server";
import { protectedResourceMetadata } from "@/server/auth/oauth-metadata";
export const GET = async () => NextResponse.json(protectedResourceMetadata(), { headers: { "cache-control": "public, max-age=3600" } });
