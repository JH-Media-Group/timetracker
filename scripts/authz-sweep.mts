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


/**
 * Signs in and returns the cookie, or explains why it could not.
 *
 * Sign-in is limited to ten attempts per fifteen minutes per address, which is
 * the point of the limiter and which these scripts will hit if they are run
 * back to back. Reading `set-cookie` off a 429 gives a TypeError about null,
 * which reads as a broken script rather than as a working defence.
 */
async function signIn(base: string, email: string, password: string): Promise<string> {
  const res = await fetch(`${base}/api/v1/auth/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base },
    body: JSON.stringify({ email, password }),
  });

  const cookie = res.headers.get("set-cookie");
  if (res.ok && cookie) return cookie.split(";")[0]!;

  if (res.status === 429) {
    const retry = res.headers.get("retry-after");
    throw new Error(
      `Sign-in is rate limited${retry ? `, retry in ${retry}s` : ""}. ` +
        "Ten attempts per fifteen minutes per address, which is the limiter working. " +
        "Wait, or restart Redis to clear the buckets."
    );
  }

  throw new Error(`Could not sign in as ${email}: ${res.status} ${await res.text()}`);
}

async function main() {
  const created: string[] = [];
  const cookies = new Map<BaseProfileKey, string>();

  const [profileRows, settingsRow] = await Promise.all([
    db.select({ id: s.permissionProfiles.id, baseKey: s.permissionProfiles.baseKey }).from(s.permissionProfiles),
    db.select().from(s.settings).limit(1),
  ]);
  if (!settingsRow.length) throw new Error("No settings row. Run pnpm db:seed first.");

  const profileId = new Map(profileRows.filter((p) => p.baseKey).map((p) => [p.baseKey!, p.id]));
  const passwordHash = await hashPassword(PASSWORD);

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
