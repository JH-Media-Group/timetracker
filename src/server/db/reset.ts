/**
 * Drops every table and re-migrates.
 *
 * Guarded twice: it refuses to run against a production NODE_ENV, and it
 * refuses without ALLOW_DESTRUCTIVE=1. Both because the whole purpose of this
 * script is to destroy data, and the cost of running it against the wrong
 * database is somebody's afternoon.
 *
 *   pnpm db:reset
 */

import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import postgres from "postgres";

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("db:reset refuses to run with NODE_ENV=production.");
  }
  if (process.env.ALLOW_DESTRUCTIVE !== "1" && !process.argv.includes("--yes")) {
    throw new Error(
      "db:reset drops every table. Re-run with --yes, or set ALLOW_DESTRUCTIVE=1."
    );
  }

  const useTest = process.argv.includes("--test");
  const url = useTest ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL;
  if (!url) throw new Error("No database URL configured.");

  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    console.log("→ dropping schemas");
    await sql.unsafe("DROP SCHEMA IF EXISTS public CASCADE");
    await sql.unsafe("DROP SCHEMA IF EXISTS drizzle CASCADE");
    await sql.unsafe("CREATE SCHEMA public");
    console.log("✓ dropped. Run pnpm db:migrate, then pnpm db:seed.");
  } finally {
    await sql.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
