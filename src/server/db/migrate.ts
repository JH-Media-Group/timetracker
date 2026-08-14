/**
 * Migration runner.
 *
 * Three phases, in order:
 *   1. extensions, which have to exist before any table that uses their types;
 *   2. Drizzle's generated table DDL;
 *   3. the manual files, which carry what Drizzle's builder cannot express:
 *      partial indexes, exclusion and check constraints, composite foreign
 *      keys, NULLS NOT DISTINCT, and the reporting view.
 *
 * Each manual file runs inside its own transaction and is recorded in a ledger,
 * so a failure halfway through leaves the schema at the last complete file
 * rather than in an undefined state, and a re-run is a no-op instead of
 * re-executing every statement.
 *
 * Run with `pnpm db:migrate`, or `pnpm db:migrate:test` for the test database.
 */

import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

const root = process.cwd();
const manualDir = join(root, "drizzle", "manual");

/**
 * Statements are separated by a line containing only `--> statement-breakpoint`.
 * Splitting on an explicit marker rather than on semicolons keeps DO blocks and
 * function bodies intact, both of which contain semicolons of their own.
 */
function statementsIn(text: string): string[] {
  return text
    .split(/^--> statement-breakpoint$/m)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^(--[^\n]*\n?)*$/.test(s));
}

const hashOf = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

async function ensureLedger(sql: postgres.Sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS manual_migrations (
      filename   text PRIMARY KEY,
      hash       text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;
}

async function runManualFile(sql: postgres.Sql, filename: string) {
  const text = await readFile(join(manualDir, filename), "utf8");
  const hash = hashOf(text);

  const [existing] = await sql<{ hash: string }[]>`
    SELECT hash FROM manual_migrations WHERE filename = ${filename}
  `;

  if (existing) {
    if (existing.hash === hash) {
      console.log(`   ${filename} (already applied)`);
      return;
    }
    // The file changed. Every statement in these files is written to be
    // idempotent precisely so an edit can be re-applied, so re-run it and
    // record the new hash.
    console.log(`   ${filename} (changed, re-applying)`);
  } else {
    console.log(`   ${filename}`);
  }

  await sql.begin(async (tx) => {
    for (const statement of statementsIn(text)) {
      await tx.unsafe(statement);
    }
    await tx`
      INSERT INTO manual_migrations (filename, hash) VALUES (${filename}, ${hash})
      ON CONFLICT (filename) DO UPDATE SET hash = EXCLUDED.hash, applied_at = now()
    `;
  });
}

async function main() {
  const useTest = process.argv.includes("--test");
  const url = useTest ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      useTest
        ? "TEST_DATABASE_URL is not set."
        : "DATABASE_URL is not set. Copy .env.example to .env.local."
    );
  }

  const sql = postgres(url, { max: 1, onnotice: () => {} });

  try {
    await ensureLedger(sql);

    console.log("→ extensions");
    await runManualFile(sql, "0000_extensions.sql");

    console.log("→ drizzle migrations");
    await migrate(drizzle(sql), { migrationsFolder: join(root, "drizzle") });

    console.log("→ constraints, partial indexes, views");
    const files = (await readdir(manualDir))
      .filter((f) => f.endsWith(".sql") && f !== "0000_extensions.sql")
      .sort();
    for (const f of files) await runManualFile(sql, f);

    console.log("✓ migrated");
  } finally {
    await sql.end();
  }
}

main().catch((e) => {
  console.error("\n✗ migration failed\n");
  console.error(e);
  process.exit(1);
});
