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

export async function register(): Promise<void> {
  const problem = proxyConfigurationError(process.env.NODE_ENV, process.env.TRUST_PROXY);
  if (problem) throw new Error(problem);

  /*
    Validate the environment here, at boot, because nothing else does.

    "A misconfigured container dies at boot with a readable message" was written
    in env.ts and was not true. `output: "standalone"` loads route modules
    lazily, so env.ts is not reached until the first request that happens to
    need it. A review started this image with no DATABASE_URL and no
    SESSION_SECRET: it stayed up, Docker marked it healthy, and it served a
    fully rendered sign-in page to anybody who asked. The only sign of trouble
    was a stack trace per request in stderr.

    A deploy that rolls back on a failing readiness check never sees a problem
    it cannot detect, so this has to fail loudly at start.

    The import is dynamic and inside the runtime guard because this file is also
    compiled for the edge runtime, where env.ts cannot be bundled: it reaches
    dotenv. That is the constraint the comment at the top of this file records,
    and a static import would break the build rather than the boot.
  */
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { env } = await import("@/server/env");

    /*
      Touch the mail configuration, because reading it is what validates it.

      `env.smtp` throws when `SMTP_URL` is set without `MAIL_FROM`, a
      combination that would send every message from an address the provider
      rejects with a 5xx. `transport.ts` correctly treats a 5xx as permanent, so
      nothing would ever be delivered and nothing would ever be retried: a mail
      system that looks configured and silently fails everything. It is a
      deployment fact, so it is checked here rather than on import, for the
      reason this file exists.
    */
    void env.smtp;

    if (env.usingBuildPlaceholders) {
      throw new Error(
        "This process is running on build placeholders, not real configuration.\n" +
          "NEXT_PHASE is set to phase-production-build, which suppresses environment validation.\n" +
          "That is a build-time setting. Unset it, and supply DATABASE_URL and SESSION_SECRET."
      );
    }
  }
}
