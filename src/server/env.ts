/**
 * Environment configuration.
 *
 * Parsed once, at import, and validated. A missing DATABASE_URL should stop the
 * process with a readable message, not surface forty minutes later as a
 * connection error inside a request handler.
 *
 * Optional integrations are modelled as "present or absent", never as an empty
 * string, so a feature check reads `if (env.smtp)` rather than
 * `if (process.env.SMTP_URL && process.env.SMTP_URL !== "")`.
 */

import { z } from "zod";

/**
 * Load .env.local ourselves rather than depending on the caller.
 *
 * ES module imports are hoisted, so a script that calls dotenv's `config()` at
 * the top of its file still runs every `import` first, and this module reads an
 * empty environment. The failure is a confusing "DATABASE_URL is required" from
 * a script whose second line configures it.
 *
 * `override: false` keeps Next's own loading and any real process environment
 * authoritative; this only fills gaps.
 */
if (!process.env.DATABASE_URL || !process.env.SESSION_SECRET) {
  try {
    // Required lazily so the bundler does not pull dotenv into the client.
    const dotenv = require("dotenv") as typeof import("dotenv");
    dotenv.config({ path: ".env.local", quiet: true, override: false });
    dotenv.config({ path: ".env", quiet: true, override: false });
  } catch {
    // dotenv is a dev dependency. In production the environment is real.
  }
}

const bool = (v: string | undefined) => v === "1" || v === "true";

/**
 * Values that pass a naive length check but mean "nobody configured this".
 *
 * A session secret that shipped in the repository is not a secret, and the
 * failure mode of accepting one is silent: the app boots, sessions work, and
 * anybody who has read the repo can mint a valid cookie.
 */
const PLACEHOLDER_SECRETS = new Set([
  "replace-me-with-32-random-bytes-base64",
  "changeme",
  "secret",
  "test-session-secret-at-least-16-chars",
]);

/** How many bytes a secret actually carries, treating base64 as base64. */
function decodedBytes(value: string): number {
  const trimmed = value.trim();
  if (/^[A-Za-z0-9+/=_-]+$/.test(trimmed) && trimmed.length >= 24) {
    try {
      return Buffer.from(trimmed, "base64").length;
    } catch {
      /* fall through to the raw length */
    }
  }
  return Buffer.byteLength(trimmed, "utf8");
}

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  TEST_DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),
  SESSION_SECRET: z
    .string()
    .min(1, "SESSION_SECRET is required")
    .refine((v) => !PLACEHOLDER_SECRETS.has(v.trim()), {
      message:
        "SESSION_SECRET is still the example value from .env.example. " +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    })
    .refine((v) => decodedBytes(v) >= 32, {
      message: "SESSION_SECRET must carry at least 32 bytes of entropy (44 base64 characters)",
    }),
  APP_URL: z.string().url().default("http://localhost:3200"),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_HOSTED_DOMAIN: z.string().default("jhmediagroup.com"),

  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().optional(),

  SPACES_ENDPOINT: z.string().optional(),
  SPACES_REGION: z.string().optional(),
  SPACES_BUCKET: z.string().optional(),
  SPACES_KEY: z.string().optional(),
  SPACES_SECRET: z.string().optional(),

  /** Set by the test harness to allow destructive operations. */
  ALLOW_DESTRUCTIVE: z.string().optional(),

  /**
   * Set only when the app genuinely sits behind a reverse proxy that rewrites
   * X-Forwarded-For. Believing that header without a proxy in front lets any
   * caller choose their own address and step around a per-IP rate limit.
   *
   * A closed set rather than a string, because the reader is `v === "1" || v ===
   * "true"` and everything else quietly means false. `TRUST_PROXY=yes` looked
   * like it had been configured, satisfied a check that only asked whether the
   * variable was present, and disabled the per-address limiter anyway. A typo
   * now fails at boot in every environment instead of being interpreted.
   */
  TRUST_PROXY: z
    .enum(["0", "1", "false", "true"], {
      message: 'TRUST_PROXY must be exactly "1", "0", "true" or "false".',
    })
    .optional(),
});

const blank = (v: string | undefined) => (v == null || v.trim() === "" ? undefined : v);

function read() {
  const raw = {
    NODE_ENV: blank(process.env.NODE_ENV),
    DATABASE_URL: blank(process.env.DATABASE_URL),
    TEST_DATABASE_URL: blank(process.env.TEST_DATABASE_URL),
    REDIS_URL: blank(process.env.REDIS_URL),
    SESSION_SECRET: blank(process.env.SESSION_SECRET),
    APP_URL: blank(process.env.APP_URL),
    GOOGLE_CLIENT_ID: blank(process.env.GOOGLE_CLIENT_ID),
    GOOGLE_CLIENT_SECRET: blank(process.env.GOOGLE_CLIENT_SECRET),
    GOOGLE_HOSTED_DOMAIN: blank(process.env.GOOGLE_HOSTED_DOMAIN),
    SMTP_URL: blank(process.env.SMTP_URL),
    MAIL_FROM: blank(process.env.MAIL_FROM),
    SPACES_ENDPOINT: blank(process.env.SPACES_ENDPOINT),
    SPACES_REGION: blank(process.env.SPACES_REGION),
    SPACES_BUCKET: blank(process.env.SPACES_BUCKET),
    SPACES_KEY: blank(process.env.SPACES_KEY),
    SPACES_SECRET: blank(process.env.SPACES_SECRET),
    ALLOW_DESTRUCTIVE: blank(process.env.ALLOW_DESTRUCTIVE),
    TRUST_PROXY: blank(process.env.TRUST_PROXY),
  };

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(
      `Environment is not configured.\n${lines.join("\n")}\n\n` +
        `Copy .env.example to .env.local and fill it in.`
    );
  }
  return parsed.data;
}

const parsed = read();

if (parsed.NODE_ENV === "production") {
  if (!parsed.GOOGLE_CLIENT_ID) {
    console.warn(
      "[env] Google Workspace SSO is not configured. Password sign-in is the only route in."
    );
  }
}

/**
 * Whether the deployment sits behind a proxy is asserted in
 * `src/instrumentation.ts`, which runs when the server starts and not during
 * `next build`. It is not asserted here, because module load happens during the
 * build too, and requiring a deployment fact to compile an artifact is how the
 * first version of that check broke `next build` outright.
 *
 * The schema above does the other half: `TRUST_PROXY=yes` is refused everywhere
 * rather than silently meaning "no".
 */


export const env = {
  ...parsed,
  isProduction: parsed.NODE_ENV === "production",
  isTest: parsed.NODE_ENV === "test",

  /** Google SSO is only usable when both halves of the credential are present. */
  google:
    parsed.GOOGLE_CLIENT_ID && parsed.GOOGLE_CLIENT_SECRET
      ? {
          clientId: parsed.GOOGLE_CLIENT_ID,
          clientSecret: parsed.GOOGLE_CLIENT_SECRET,
          hostedDomain: parsed.GOOGLE_HOSTED_DOMAIN,
        }
      : null,

  smtp: parsed.SMTP_URL ? { url: parsed.SMTP_URL, from: parsed.MAIL_FROM ?? "tally@localhost" } : null,

  spaces:
    parsed.SPACES_ENDPOINT && parsed.SPACES_BUCKET && parsed.SPACES_KEY && parsed.SPACES_SECRET
      ? {
          endpoint: parsed.SPACES_ENDPOINT,
          region: parsed.SPACES_REGION ?? "us-east-1",
          bucket: parsed.SPACES_BUCKET,
          key: parsed.SPACES_KEY,
          secret: parsed.SPACES_SECRET,
        }
      : null,

  allowDestructive: bool(parsed.ALLOW_DESTRUCTIVE),
  TRUST_PROXY: bool(parsed.TRUST_PROXY),
} as const;

export type Env = typeof env;
