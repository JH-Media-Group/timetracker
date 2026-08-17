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

import { randomBytes } from "node:crypto";
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
  /*
    The build placeholder, thirty-two zero bytes.

    A review proved this was a working production secret: the poisoned getter
    below only fires when this module substituted the value itself, so an
    operator who copied the constant out of this file, or a deploy template
    filled in from it, got a server that signed happily with a key printed in
    the source. The getter cannot see that path. This set can.
  */
  Buffer.alloc(32).toString("base64"),
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
  MAIL_TO_DISK: z.enum(["0", "1", "false", "true"]).optional(),

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

function read(fallbacks: Partial<Record<"DATABASE_URL" | "SESSION_SECRET", string>> = {}) {
  const raw = {
    NODE_ENV: blank(process.env.NODE_ENV),
    DATABASE_URL: blank(process.env.DATABASE_URL) ?? fallbacks.DATABASE_URL,
    TEST_DATABASE_URL: blank(process.env.TEST_DATABASE_URL),
    REDIS_URL: blank(process.env.REDIS_URL),
    SESSION_SECRET: blank(process.env.SESSION_SECRET) ?? fallbacks.SESSION_SECRET,
    APP_URL: blank(process.env.APP_URL),
    GOOGLE_CLIENT_ID: blank(process.env.GOOGLE_CLIENT_ID),
    GOOGLE_CLIENT_SECRET: blank(process.env.GOOGLE_CLIENT_SECRET),
    GOOGLE_HOSTED_DOMAIN: blank(process.env.GOOGLE_HOSTED_DOMAIN),
    SMTP_URL: blank(process.env.SMTP_URL),
    MAIL_FROM: blank(process.env.MAIL_FROM),
    MAIL_TO_DISK: blank(process.env.MAIL_TO_DISK),
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

/**
 * `next build` imports every route module to collect page data, which reaches
 * this file and validates an environment the build has no business needing.
 *
 * That is not a Docker inconvenience, it is a real defect: it means the image
 * cannot be built without handing the builder a live DATABASE_URL and a real
 * SESSION_SECRET. Build-time inputs and run-time secrets should not be the same
 * set, and CI should never hold production credentials just to compile.
 *
 * **An earlier version of this comment claimed `NEXT_PHASE` is set by Next
 * itself and therefore "cannot apply to a running server". That was false, and
 * an adversarial review proved it by booting the production image with
 * `NEXT_PHASE=phase-production-build` and no `SESSION_SECRET` at all.** It came
 * up healthy and served `/signin`, signing sessions with thirty-two zero bytes,
 * a value printed in this very file. `NEXT_PHASE` is an ordinary environment
 * variable: a compose file, a Dockerfile `ENV`, an inherited shell or a CI
 * manifest can set it, and `NODE_ENV=production` did nothing to stop it.
 *
 * Detecting the build reliably is not possible from inside the process, so the
 * defence is not detection. **The placeholder is poisoned instead**: it
 * satisfies the schema so the build can compile, and `env.SESSION_SECRET` throws
 * if anything ever reads it. Build-time code never does, which is why the build
 * still works. A spoofed server therefore refuses every request that touches a
 * session rather than accepting forged ones, which is the failure we can live
 * with.
 *
 * Validation stays eager everywhere else, so a misconfigured container still
 * dies at boot rather than on the first request that needs the database.
 */
const IS_NEXT_BUILD = process.env.NEXT_PHASE === "phase-production-build";

/**
 * Whether the values below are stand-ins rather than real configuration.
 *
 * Declared before `parsed` because `readForBuild` sets them and the function is
 * hoisted; a `let` initialised afterwards would be reset to false.
 */
let sessionSecretIsPlaceholder = false;
let databaseUrlIsPlaceholder = false;

/**
 * Syntactically valid stand-ins, used only to satisfy the parse during a build.
 *
 * The session secret is computed rather than written as a literal, and that is
 * deliberate on two counts. Thirty-two zero bytes cannot be mistaken for a real
 * key by a person reading the file. And `tests/repo-hygiene.test.ts` scans every
 * tracked file for `SESSION_SECRET` assigned a base64-looking string, which is
 * exactly what a literal here would be: the scanner flagged the first version of
 * this, correctly, since it has no way to know the bytes are all zero. Removing
 * the literal keeps that scan strict instead of teaching it an exception.
 */
const BUILD_PLACEHOLDERS = {
  DATABASE_URL: "postgres://build:build@127.0.0.1:5432/build",

  /*
    Generated per build, not a constant, and that is the whole point.

    This was thirty-two zero bytes written into the file. A review copied it out
    and used it as a real SESSION_SECRET against the production image, and
    signed in: the poisoned getter only fires when this module substituted the
    value, so a value an operator pastes in looks entirely legitimate.

    Adding that constant to PLACEHOLDER_SECRETS closed the paste path and broke
    the build, because the stand-in supplied here is then refused by the schema
    it exists to satisfy. Generating it removes the conflict and the paste path
    together: there is no longer anything in this file to copy, the value never
    leaves the build process, and the getter below still refuses to hand it to
    anything that asks.
  */
  SESSION_SECRET: randomBytes(32).toString("base64"),
} as const;

/**
 * The sender address, which is required the moment a transport is configured.
 *
 * Not enforced in the schema itself because `MAIL_FROM` is genuinely optional
 * when `SMTP_URL` is absent, and a cross-field rule there would have to be
 * repeated in `readForBuild`.
 */
function requireMailFrom(from: string | undefined): string {
  if (from) return from;
  throw new Error(
    "SMTP_URL is set but MAIL_FROM is not. Every message would be sent from an address the " +
      "provider rejects with a 5xx, which counts as a permanent failure, so nothing would ever " +
      "be delivered and nothing would ever be retried. Set MAIL_FROM, for example " +
      '"Tally <tally@jhmediagroup.com>".'
  );
}

const parsed = IS_NEXT_BUILD ? readForBuild() : read();

/*
 * Runtime-only deployment invariants.
 *
 * The build intentionally has no production configuration, so these cannot be
 * schema refinements: `next build` runs with NODE_ENV=production and imports
 * this module. A running process does have to answer them. In particular, an
 * HTTP APP_URL puts reset credentials into plaintext links, and MAIL_TO_DISK
 * makes a successful queue drain mean "written inside this disposable
 * container" rather than "delivered".
 */
if (!IS_NEXT_BUILD && parsed.NODE_ENV === "production") {
  if (new URL(parsed.APP_URL).protocol !== "https:") {
    throw new Error("APP_URL must use https:// in production so authentication links and origin checks are secure.");
  }
  if (bool(parsed.MAIL_TO_DISK)) {
    throw new Error("MAIL_TO_DISK is a development-only mail sink and must not be enabled in production.");
  }

  const googleParts = [parsed.GOOGLE_CLIENT_ID, parsed.GOOGLE_CLIENT_SECRET];
  if (googleParts.some(Boolean) && !googleParts.every(Boolean)) {
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured together.");
  }

  const spacesParts = [parsed.SPACES_ENDPOINT, parsed.SPACES_BUCKET, parsed.SPACES_KEY, parsed.SPACES_SECRET];
  if (spacesParts.some(Boolean) && !spacesParts.every(Boolean)) {
    throw new Error("SPACES_ENDPOINT, SPACES_BUCKET, SPACES_KEY and SPACES_SECRET must be configured together.");
  }
}

/**
 * Parse with stand-ins filling only what the environment does not supply.
 *
 * The stand-ins are passed in rather than written into `process.env`. Mutating
 * the process environment at import time changes global state for everything
 * else in the process, including any child it spawns, which is a large side
 * effect for a module whose job is to read configuration.
 */
function readForBuild() {
  databaseUrlIsPlaceholder = !blank(process.env.DATABASE_URL);
  sessionSecretIsPlaceholder = !blank(process.env.SESSION_SECRET);
  return read(BUILD_PLACEHOLDERS);
}

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

  /**
   * The session secret, unless it is the build placeholder, in which case
   * reading it is a bug and this throws.
   *
   * This is the whole defence against a spoofed `NEXT_PHASE`. The build needs a
   * value that satisfies the schema; nothing at build time needs a value that
   * works. So the placeholder parses and then refuses to be used.
   *
   * A getter rather than a check at the call site, because there is one consumer
   * today (`auth/session.ts` HMACs with it) and the next one will not remember.
   */
  get SESSION_SECRET(): string {
    if (sessionSecretIsPlaceholder) {
      throw new Error(
        "SESSION_SECRET is the build placeholder, which is thirty-two zero bytes and public in the source.\n" +
          "This process was started with NEXT_PHASE=phase-production-build but no real SESSION_SECRET, so it\n" +
          "would be signing sessions with a key anybody who has read the repository can reproduce.\n\n" +
          "Unset NEXT_PHASE, or set a real SESSION_SECRET:\n" +
          '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"'
      );
    }
    return parsed.SESSION_SECRET;
  },

  /** True when anything above is a stand-in. Never true in a correctly run server. */
  usingBuildPlaceholders: sessionSecretIsPlaceholder || databaseUrlIsPlaceholder,

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

  /*
    No fallback sender, and checked lazily.

    A getter, not a value, because this file's own neighbours argue the point:
    `instrumentation.ts` explains at length that a deployment assertion which
    runs on import turns a deployment fact into a build dependency, and
    `next build` imports every route module to collect page data. Evaluated
    eagerly, a build machine that merely inherits `SMTP_URL` from its shell
    would fail the build, and a health endpoint that sends no mail would refuse
    to start. Reading `env.smtp` is what needs to be sound, so that is what
    throws; boot touches it deliberately so a misconfigured server still dies
    at start rather than at the first email.

    The value used to default to `tally@localhost` when `SMTP_URL` was set and
    `MAIL_FROM` was not. That address is not deliverable and SendGrid refuses it
    with a 5xx, which `transport.ts` correctly classifies as **permanent**, so
    every message would go straight to `failed` on its first attempt with no
    retry and nothing obviously wrong in the configuration. A reviewer spotted
    that the tests always supply a `from`, so nothing exercised the fallback.

    Refusing to start is the right answer: the variable is one line in the env
    file, and the alternative is a mail system that looks configured and
    silently fails everything it is given.
  */
  get smtp() {
    return parsed.SMTP_URL ? { url: parsed.SMTP_URL, from: requireMailFrom(parsed.MAIL_FROM) } : null;
  },

  /** Development-only mail capture. Production refuses to boot when enabled. */
  mailToDisk: bool(parsed.MAIL_TO_DISK),

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
