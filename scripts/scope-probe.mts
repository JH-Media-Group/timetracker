/**
 * Scope probe.
 *
 * The authorization sweep asks "can this profile reach this endpoint". This
 * asks the harder question: when it can, does it get only what it should?
 *
 * A capability gate that passes and a scope predicate that does not filter is
 * the shape of every serious leak in an app like this, and it looks identical
 * to correct behaviour from the outside unless somebody counts the rows.
 *
 *   pnpm tsx scripts/scope-probe.mts
 */

import { inArray } from "drizzle-orm";
import { db } from "../src/server/db/client";
import * as s from "../src/server/db/schema";
import { newId } from "../src/server/db/ids";
import { hashPassword } from "../src/server/auth/password";

const BASE = process.env.BASE ?? "http://localhost:3200";
const PASSWORD = "scope-probe-password";

let failures = 0;

function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "  LEAK"}  ${name}${detail ? `   ${detail}` : ""}`);
}

async function main() {
  const created: string[] = [];

  const [memberProfile] = await db
    .select({ id: s.permissionProfiles.id })
    .from(s.permissionProfiles)
    .where(inArray(s.permissionProfiles.baseKey, ["member"]))
    .limit(1);
  if (!memberProfile) throw new Error("No member profile. Run pnpm db:migrate first.");

  const id = newId();
  const email = "scope-probe@sweep.invalid";
  await db.insert(s.users).values({
    id,
    email,
    firstName: "Scope",
    lastName: "Probe",
    passwordHash: await hashPassword(PASSWORD),
    profileId: memberProfile.id,
    isOwner: false,
    weeklyCapacitySeconds: 144000,
  });
  created.push(id);

  try {
    const signin = await fetch(`${BASE}/api/v1/auth/signin`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: BASE },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    const cookie = signin.headers.get("set-cookie")!.split(";")[0]!;
    const asMember = (path: string) =>
      fetch(BASE + path, { headers: { Cookie: cookie, Origin: BASE } }).then(async (r) => ({
        status: r.status,
        body: r.status === 200 ? (await r.json()).data : null,
        meta: r.status === 200 ? (await Promise.resolve(null)) : null,
      }));

    // Somebody else's id, taken from the seeded roster.
    const roster = (await asMember("/api/v1/users")).body as { id: string; email: string }[];
    const other = roster.find((u) => u.id !== id)!;

    /* ------------------------------------------------------------ rates */
    const rated = roster.filter((u) => u.id !== id) as Record<string, unknown>[];
    check(
      "a Member sees no billable rate for anybody else",
      rated.every((u) => u.billableRateCents === undefined),
      `${rated.filter((u) => u.billableRateCents !== undefined).length} exposed`
    );
    check(
      "a Member sees no cost rate at all",
      (roster as Record<string, unknown>[]).every((u) => u.costRateCents === undefined)
    );

    /* ------------------------------------------------------- time entries */
    const mine = (await asMember("/api/v1/time-entries?from=2020-01-01&to=2030-01-01")).body as { userId: string }[];
    check(
      "a Member's time list contains only their own entries",
      mine.every((e) => e.userId === id),
      `${mine.length} rows`
    );

    const theirs = await asMember(`/api/v1/time-entries?from=2020-01-01&to=2030-01-01&user_id=${other.id}`);
    check(
      "asking for somebody else's time returns nothing or refuses",
      theirs.status !== 200 || (theirs.body as unknown[]).length === 0,
      `status ${theirs.status}, ${Array.isArray(theirs.body) ? theirs.body.length : "-"} rows`
    );

    /* ---------------------------------------------------------- expenses */
    const expenses = (await asMember("/api/v1/expenses")).body as { userId: string }[];
    check(
      "a Member's expense list contains only their own",
      expenses.every((e) => e.userId === id),
      `${expenses.length} rows`
    );

    /* --------------------------------------------------------- approvals */
    const approvals = (await asMember("/api/v1/approvals")).body as { userId: string }[];
    check(
      "a Member's approval queue contains only their own submissions",
      approvals.every((a) => a.userId === id),
      `${approvals.length} rows`
    );

    /* ----------------------------------------------------------- reports */
    const report = await fetch(`${BASE}/api/v1/reports/time?from=2020-01-01&to=2030-01-01`, {
      headers: { Cookie: cookie, Origin: BASE },
    }).then((r) => r.json());
    check(
      "the time report shows a Member no money",
      report.meta?.totals?.billableCents === 0,
      `billableCents ${report.meta?.totals?.billableCents}`
    );

    /* --------------------------------------------------------- 404 not 403 */
    const someoneElsesEntry = await db
      .select({ id: s.timeEntries.id })
      .from(s.timeEntries)
      .limit(1);
    if (someoneElsesEntry.length) {
      const res = await asMember(`/api/v1/time-entries/${someoneElsesEntry[0]!.id}`);
      check(
        "a record outside scope is 404, not 403",
        res.status === 404,
        `status ${res.status}`
      );
    }

    /* ------------------------------------------------------------ writes */
    const write = await fetch(`${BASE}/api/v1/settings`, {
      method: "PATCH",
      headers: { Cookie: cookie, "Content-Type": "application/json", Origin: BASE },
      body: JSON.stringify({ companyName: "Owned" }),
    });
    check("a Member cannot change account settings", write.status === 403, `status ${write.status}`);

    const escalate = await fetch(`${BASE}/api/v1/users/${id}`, {
      method: "PATCH",
      headers: { Cookie: cookie, "Content-Type": "application/json", Origin: BASE },
      body: JSON.stringify({ firstName: "Escalated" }),
    });
    check("a Member cannot edit a user record, including their own", escalate.status === 403, `status ${escalate.status}`);
  } finally {
    await db.delete(s.sessions).where(inArray(s.sessions.userId, created));
    await db.delete(s.auditLog).where(inArray(s.auditLog.actorId, created));
    await db.delete(s.users).where(inArray(s.users.id, created));
    console.log("\ncleaned up the probe account");
  }

  console.log(failures ? `\n${failures} LEAKS` : "\nno leaks");
  process.exitCode = failures ? 1 : 0;
}

await main();
process.exit(process.exitCode ?? 0);
