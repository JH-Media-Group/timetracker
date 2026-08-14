/**
 * One rule, no imports.
 *
 * Deliberately free of dependencies so `src/instrumentation.ts` can use it.
 * That file is compiled for the edge runtime as well as the Node one, and
 * anything it reaches has to survive being bundled for edge: importing
 * `env.ts` from there pulls in dotenv, which needs node's `crypto`, and the
 * build fails with "Module not found: Can't resolve 'crypto'".
 *
 * Keeping the rule here rather than inlining it in the instrumentation hook
 * means there is still exactly one statement of it, which `tests/env.test.ts`
 * can call directly without starting a server.
 */

/** Why the proxy configuration is wrong, or null when it is fine. */
export function proxyConfigurationError(
  nodeEnv: string | undefined,
  trustProxy: string | undefined
): string | null {
  if (nodeEnv !== "production") return null;
  if (trustProxy !== undefined && trustProxy !== "") return null;

  return (
    "TRUST_PROXY must be set explicitly in production.\n" +
    "  TRUST_PROXY=1  behind a reverse proxy that sets X-Forwarded-For (this is us: Caddy).\n" +
    "  TRUST_PROXY=0  serving directly, accepting there is no per-address rate limit.\n" +
    "\n" +
    "Unset silently chooses the second, and nothing says so: clientIp() returns null for " +
    "every request, so no per-address limit is applied to sign-in and sessions.ip records " +
    "nothing for every session. Both wrong answers are quiet, which is why this is a boot " +
    "failure rather than a default."
  );
}
