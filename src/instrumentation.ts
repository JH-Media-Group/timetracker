/**
 * Checks that belong to a running server rather than to a build.
 *
 * Next calls `register()` once when the server starts, and does not call it
 * during `next build`. That distinction is the whole point of this file.
 *
 * The temptation is to put deployment assertions at the top of `env.ts`, where
 * they run on import and feel thorough. They are not: `next build` also runs
 * with `NODE_ENV=production` and imports every route module to collect page
 * data, so an assertion there turns a deployment fact into a build dependency
 * and fails the build on a machine with no business knowing the production
 * topology. That is not hypothetical; it is what the first version of the
 * TRUST_PROXY check did, and the build died with "Failed to collect page data
 * for /api/v1/auth/providers".
 *
 * An artifact is built once and run in several places. Anything that varies
 * between those places is checked here.
 *
 * Note what this file may import: it is compiled for the edge runtime as well
 * as the Node one, so it reads `process.env` and a dependency-free module
 * rather than `env.ts`, which pulls in dotenv and fails to bundle for edge.
 */

import { proxyConfigurationError } from "@/server/proxy-check";

export function register(): void {
  const problem = proxyConfigurationError(process.env.NODE_ENV, process.env.TRUST_PROXY);
  if (problem) throw new Error(problem);
}
