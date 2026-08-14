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

const bool = (v: string | undefined) => v === "1" || v === "true";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  TEST_DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),
  SESSION_SECRET: z.string().min(16, "SESSION_SECRET must be at least 16 characters"),
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
} as const;

export type Env = typeof env;
