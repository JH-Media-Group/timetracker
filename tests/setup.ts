/**
 * Test bootstrap.
 *
 * Points every test at TEST_DATABASE_URL. The guard is not paranoia: the suite
 * truncates every table in the public schema, and the failure mode of getting
 * this wrong is losing a day of seeded development data.
 *
 * The check parses the URL and compares the database *name* exactly. An earlier
 * version searched the whole URL for the substring "tally_test", which a
 * password or a query parameter could satisfy by accident.
 */

import { config } from "dotenv";

config({ path: ".env.local", quiet: true });

// NODE_ENV is typed readonly by @types/node; the assignment is deliberate and
// has to happen before anything imports src/server/env.ts.
const environment = process.env as Record<string, string | undefined>;
environment.NODE_ENV = "test";

const REQUIRED_DB_NAME = "tally_test";

function databaseNameOf(url: string): string {
  // postgres://user:pass@host:port/dbname?params
  const withoutQuery = url.split("?")[0]!;
  const lastSlash = withoutQuery.lastIndexOf("/");
  return lastSlash === -1 ? "" : withoutQuery.slice(lastSlash + 1);
}

/** Redacts credentials, so a thrown error can safely reach a CI log. */
function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.password = "";
    u.username = u.username ? "***" : "";
    return u.toString();
  } catch {
    return "<unparseable database url>";
  }
}

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) {
  throw new Error("TEST_DATABASE_URL is not set. Tests refuse to run against the development database.");
}

const testDbName = databaseNameOf(testUrl);
if (testDbName !== REQUIRED_DB_NAME) {
  throw new Error(
    `TEST_DATABASE_URL must point at a database named "${REQUIRED_DB_NAME}". ` +
      `Got "${testDbName}" from ${safeUrl(testUrl)}. Tests truncate every table.`
  );
}

const devUrl = process.env.DATABASE_URL;
if (devUrl && databaseNameOf(devUrl) === testDbName && devUrl === testUrl) {
  // Same database for both is only a mistake if the dev URL is genuinely in use.
  // Identical strings mean someone copied one into the other.
  throw new Error("TEST_DATABASE_URL and DATABASE_URL are identical. Tests truncate tables.");
}

environment.DATABASE_URL = testUrl;
environment.SESSION_SECRET ??= "test-session-secret-at-least-16-chars";
environment.ALLOW_DESTRUCTIVE = "1";
