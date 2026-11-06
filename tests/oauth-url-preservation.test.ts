import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { query } from "@/server/http";
import { z } from "zod";
import { middleware } from "@/middleware";

afterEach(() => vi.unstubAllEnvs());

describe("OAuth query preservation on public and internal hostnames", () => {
  it.each(["http://127.0.0.1:43210/callback", "https://client.example/callback"])("keeps callback %s and opaque state when Next constructs the request", (redirectUri) => {
    const config = readFileSync("next.config.mjs", "utf8");
    // Next compiles this configuration into its NextRequest implementation.
    const preserve = /skipMiddlewareUrlNormalize:\s*true/.test(config);
    vi.stubEnv("__NEXT_NO_MIDDLEWARE_URL_NORMALIZE", preserve ? "1" : undefined);
    for (const host of ["https://tally.example", "http://web:3000"]) {
      const params = new URLSearchParams({ redirect_uri: redirectUri, state: "opaque-127.0.0.1-state" });
      const request = new NextRequest(`${host}/api/v1/oauth/request?${params}`);
      expect(query(request, z.object({ redirect_uri: z.string(), state: z.string() }))).toEqual({ redirect_uri: redirectUri, state: "opaque-127.0.0.1-state" });
      const destination = `/settings?${params}`;
      const redirected = middleware(new NextRequest(host + destination));
      expect(new URL(redirected.headers.get("location")!).searchParams.get("next")).toBe(destination);
    }
  });
});
