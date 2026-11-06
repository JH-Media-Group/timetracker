import { NextResponse } from "next/server";
import { authorizationServerMetadata } from "@/server/auth/oauth-metadata";
export const GET = async () => NextResponse.json(authorizationServerMetadata(), { headers: { "cache-control": "public, max-age=3600" } });
