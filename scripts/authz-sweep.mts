/**
 * Authorization sweep.
 *
 * Signs in as one person per base permission profile and asks every read
 * endpoint the same question, then prints the matrix. It exists because the
 * capability gate is spread across three layers (the route option, the service
 * `assertCan`, and the scope predicate), and the only way to be sure a route is
 * gated is to send the request.
 *
 * What to look for in the output:
 *
 *   - A `200` where the matrix in BACKEND_PRD section 7.2 says a profile should
 *     see nothing. That is a hole.
 *   - A `403` where the profile is supposed to have access. That is a lockout,
 *     which is less dangerous and more likely to be noticed, but still wrong.
 *   - Any `500`. A route that crashes rather than refusing has not decided.
 *
 * Run against a development database. It creates a user per profile, signs in
 * as each, and deletes them afterwards.
 *
 *   pnpm tsx scripts/authz-sweep.mts
 */

import { eq, inArray } from "drizzle-orm";
import { db } from "../src/server/db/client";
import * as s from "../src/server/db/schema";
import { newId } from "../src/server/db/ids";
import { hashPassword } from "../src/server/auth/password";
import { BASE_PROFILES, type BaseProfileKey } from "../src/server/auth/capabilities";
import { clearSignInLimits, signIn } from "./lib/dev-signin.mts";
import { assertLocalTarget } from "./lib/dev-only.mts";

const BASE = process.env.BASE ?? "http://localhost:3200";
const PASSWORD = "authz-sweep-password";
const PROFILES = Object.keys(BASE_PROFILES) as BaseProfileKey[];

/** Every read endpoint, with a sample of the parameters each one needs. */
const period = "from=2026-01-01&to=2026-12-31";
const ENDPOINTS: string[] = [
  "/api/v1/bootstrap",
  "/api/v1/me",
  "/api/v1/me/capabilities",
  "/api/v1/users",
  "/api/v1/clients",
  "/api/v1/projects",
  "/api/v1/tasks",
  "/api/v1/settings",
  "/api/v1/roles",
  "/api/v1/departments",
  "/api/v1/permission-profiles",
  "/api/v1/expense-categories",
  "/api/v1/expenses",
  "/api/v1/time-entries",
  "/api/v1/time-entries/running",
  `/api/v1/timesheet/summary?${period}`,
  "/api/v1/approvals",
  "/api/v1/approvals/me",
  "/api/v1/invoices",
  "/api/v1/recurring-invoices",
  "/api/v1/retainers",
  "/api/v1/notifications",
  "/api/v1/search?q=a",
  `/api/v1/reports/time?${period}`,
  `/api/v1/reports/profitability?${period}`,
  `/api/v1/reports/team?${period}`,
  `/api/v1/reports/invoicing?${period}`,
];



async function main() {
  // Before the first read, let alone the first write. Everything below this
  // line inserts users, one of them an administrator whose password is a
  // literal in this file.
  assertLocalTarget(BASE);

  const created: string[] = [];
  const cookies = new Map<BaseProfileKey, string>();

  const [profileRows, settingsRow] = await Promise.all([
    db.select({ id: s.permissionProfiles.id, baseKey: s.permissionProfiles.baseKey }).from(s.permissionProfiles),
    db.select().from(s.settings).limit(1),
  ]);
  if (!settingsRow.length) throw new Error("No settings row. Run pnpm db:seed first.");

  const profileId = new Map(profileRows.filter((p) => p.baseKey).map((p) => [p.baseKey!, p.id]));
  const passwordHash = await hashPassword(PASSWORD);

  // Six sign-ins against a ten-per-fifteen-minutes limit means this tool cannot
  // be run twice without clearing after itself.
  await clearSignInLimits(PROFILES.map((k) => `authz-${k}@sweep.invalid`));

  try {
    for (const key of PROFILES) {
      const id = newId();
      const email = `authz-${key}@sweep.invalid`;
      await db.insert(s.users).values({
        id,
        email,
        firstName: "Sweep",
        lastName: key,
        passwordHash,
        profileId: profileId.get(key)!,
        // The owner flag is not a profile; giving it to the administrator row
        // here would test something the profile does not grant.
        isOwner: false,
        weeklyCapacitySeconds: 144000,
      });
      created.push(id);

      cookies.set(key, await signIn(BASE, email, PASSWORD));
    }

    const width = Math.max(...ENDPOINTS.map((e) => e.length)) + 2;
    console.log("\n" + "endpoint".padEnd(width) + PROFILES.map((p) => p.slice(0, 8).padStart(9)).join(""));
    console.log("-".repeat(width + PROFILES.length * 9));

    const holes: string[] = [];
    for (const endpoint of ENDPOINTS) {
      const cells: string[] = [];
      for (const key of PROFILES) {
        const res = await fetch(BASE + endpoint, {
          headers: { Cookie: cookies.get(key)!, Origin: BASE },
        });
        cells.push(String(res.status).padStart(9));
        if (res.status >= 500) holes.push(`${key} ${endpoint} -> ${res.status}`);
      }
      console.log(endpoint.padEnd(width) + cells.join(""));
    }

    console.log("\n200 = allowed, 403 = refused by capability, 404 = out of scope, 422 = bad parameters");
    if (holes.length) {
      console.log("\nSERVER ERRORS (a route that crashes has not decided):");
      for (const h of holes) console.log("  " + h);
      process.exitCode = 1;
    }
  } finally {
    if (created.length) {
      await db.delete(s.sessions).where(inArray(s.sessions.userId, created));
      await db.delete(s.auditLog).where(inArray(s.auditLog.actorId, created));
      await db.delete(s.users).where(inArray(s.users.id, created));
      console.log(`\ncleaned up ${created.length} sweep accounts`);
    }
  }
}

await main();
process.exit(process.exitCode ?? 0);
