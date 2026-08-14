/**
 * Proof that a script is pointed at a development stack.
 *
 * `authz-sweep` and `scope-probe` are read-only in spirit and destructive in
 * fact. Between them they insert six users, one of them an administrator whose
 * password is a string literal published in this repository, run a hundred and
 * fifty authenticated requests, delete audit rows, and clear a sign-in
 * rate-limit bucket. All of that is fine against a throwaway database and none
 * of it is fine anywhere else.
 *
 * Until this file existed, the only thing standing between those scripts and
 * the production database was a sentence in a comment saying they should not be
 * run there. `src/server/env.ts` loads `.env.local` and then `.env`, so on the
 * droplet the scripts would inherit the production `DATABASE_URL` and
 * `REDIS_URL` without being told, and `BASE` already defaults to
 * `http://localhost:3200`, which is exactly how production serves. Somebody
 * running `pnpm authz:sweep` in the deploy directory to check the permission
 * matrix, which `CLAUDE.md` advertises as ordinary repo tooling, would have
 * created a live administrator account with a known password. If the run were
 * interrupted before its cleanup, that account would still be there.
 *
 * So the rule is now a function, and the function is tested. It fails closed:
 * anything it cannot parse and prove is local is treated as not local.
 *
 * **What it does not prove.** It establishes that every connection terminates on
 * a loopback address, not that the thing listening there is a development
 * database. An SSH tunnel forwarding `localhost:5432` to production satisfies
 * every check here, and nothing in this process can see through it. That is a
 * real limit and it is written down rather than implied away, because the
 * failure it leaves is somebody deliberately opening a tunnel to production and
 * then running a development tool through it. The guard is for the accident,
 * which is the case that actually happens: inheriting production values from a
 * `.env` in a deploy directory without noticing.
 *
 * `src/server/db/reset.ts` guards itself the same way, and this is deliberately
 * the stricter version of that pattern. `reset.ts` offers `ALLOW_DESTRUCTIVE=1`
 * as an override because dropping tables is sometimes exactly what you meant.
 * There is no override here: nobody ever means to seed an administrator into
 * production, so an escape hatch would only ever be used by mistake.
 */

import { env } from "../../src/server/env";

/**
 * Addresses that can only mean this machine.
 *
 * Deliberately not a pattern. `10.x`, `192.168.x` and `*.local` are somebody's
 * network, and a staging box on the LAN is exactly the kind of thing that looks
 * safe and holds real data.
 */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** The host, or null when the string is not a URL we can reason about. */
function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

export interface Target {
  nodeEnv: string;
  databaseUrl: string;
  redisUrl?: string | undefined;
  base: string;
}

/**
 * Why this target is not local, or null when it is.
 *
 * Split out from the assertion so the rule can be tested without a process
 * whose environment has to be rewritten to exercise it.
 */
export function whyNotLocal(target: Target): string | null {
  if (target.nodeEnv === "production") {
    return "NODE_ENV is production.";
  }

  const checks: [label: string, value: string | undefined][] = [
    ["DATABASE_URL", target.databaseUrl],
    ["REDIS_URL", target.redisUrl],
    ["BASE", target.base],
  ];

  for (const [label, value] of checks) {
    if (value === undefined || value === "") {
      // REDIS_URL is genuinely optional; the other two are not, and an empty
      // one means we cannot prove anything about where this is pointed.
      if (label === "REDIS_URL") continue;
      return `${label} is not set, so there is no way to tell what this would run against.`;
    }

    const host = hostOf(value);
    if (host === null) {
      return `${label} is not a URL this can parse, so it cannot be shown to be local.`;
    }
    if (!LOOPBACK.has(host)) {
      return `${label} points at ${host}, which is not this machine.`;
    }
  }

  return null;
}

/**
 * Refuses to continue unless every address this script will touch is loopback.
 *
 * Call it before the first write, not before the first read: the point is to be
 * ahead of the damage, and by the time a script is signing in it has already
 * inserted its users.
 */
export function assertLocalTarget(base: string): void {
  const reason = whyNotLocal({
    nodeEnv: env.NODE_ENV,
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    base,
  });

  if (reason === null) return;

  throw new Error(
    `Refusing to run: ${reason}\n` +
      "\n" +
      "This script creates users (including an administrator whose password is\n" +
      "in the repository), runs authenticated requests, deletes audit rows, and\n" +
      "clears a sign-in rate-limit bucket. It is only safe against a local\n" +
      "development stack, so it checks rather than assuming.\n" +
      "\n" +
      "NODE_ENV, DATABASE_URL and REDIS_URL must all be local, and BASE must be\n" +
      "a loopback address. Note that env.ts reads .env.local and then .env, so a\n" +
      "deploy directory will hand you production values without mentioning it."
  );
}
