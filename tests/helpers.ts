/**
 * Integration-test helpers.
 *
 * `resetDb` truncates rather than dropping: a truncate of 43 tables takes
 * milliseconds, a re-migration takes seconds, and the suite runs it between
 * every file.
 */

import { sql as raw } from "drizzle-orm";
import { closePool, db, sql } from "@/server/db/client";
import * as s from "@/server/db/schema";
import { newId } from "@/server/db/ids";
import { invalidateSettings } from "@/server/services/settings";
import { BASE_PROFILES } from "@/server/auth/capabilities";

/**
 * Truncates every table in `public`.
 *
 * Both migration ledgers live in the `drizzle` schema precisely so this cannot
 * wipe them: truncating the ledger would make the next `db:migrate` re-run
 * every manual file, which is the sort of thing that looks fine until a file
 * stops being idempotent.
 */
export async function resetDb() {
  const rows = await sql<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  `;
  if (!rows.length) return;
  const names = rows.map((r) => `"${r.tablename}"`).join(", ");
  await sql.unsafe(`TRUNCATE ${names} RESTART IDENTITY CASCADE`);
}

export async function seedProfiles() {
  const values = Object.entries(BASE_PROFILES).map(([baseKey, def]) => ({
    id: newId(),
    name: def.name,
    isBase: true,
    baseKey,
    capabilities: [...def.capabilities],
  }));
  await db.insert(s.permissionProfiles).values(values);
  return Object.fromEntries(values.map((v) => [v.baseKey!, v.id])) as Record<string, string>;
}

export async function seedSettings(over: Partial<typeof s.settings.$inferInsert> = {}) {
  await db.insert(s.settings).values({
    id: 1,
    companyName: "JH Media Group",
    companyAddress: "245 N. Highland Ave\nSuite 230-185\nAtlanta GA 30307",
    timezone: "America/New_York",
    ...over,
  });
  // The service caches the row for a few seconds, so a test that seeds a
  // different account would otherwise read the previous one.
  invalidateSettings();
}

export async function makeUser(opts: {
  profileId: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  isOwner?: boolean;
  billableCents?: number;
  costCents?: number;
}) {
  const id = newId();
  await db.insert(s.users).values({
    id,
    email: opts.email ?? `${id.slice(0, 8)}@jhmediagroup.com`,
    firstName: opts.firstName ?? "Test",
    lastName: opts.lastName ?? "User",
    profileId: opts.profileId,
    isOwner: opts.isOwner ?? false,
  });
  if (opts.billableCents != null) {
    await db.insert(s.userRates).values({ id: newId(), userId: id, kind: "billable", amountCents: opts.billableCents });
  }
  if (opts.costCents != null) {
    await db.insert(s.userRates).values({ id: newId(), userId: id, kind: "cost", amountCents: opts.costCents });
  }
  return id;
}

export async function makeClient(name = "Test Client") {
  const id = newId();
  await db.insert(s.clients).values({ id, name });
  return id;
}

export async function makeProject(clientId: string, over: Partial<typeof s.projects.$inferInsert> = {}) {
  const id = newId();
  await db.insert(s.projects).values({
    id,
    clientId,
    name: over.name ?? "Test Project",
    billingType: over.billingType ?? "time_and_materials",
    billBy: over.billBy ?? "people",
    ...over,
  });
  return id;
}

export async function makeTask(name = "Design") {
  const id = newId();
  await db.insert(s.tasks).values({ id, name });
  return id;
}

export async function makeProjectTask(projectId: string, taskId: string, over: Partial<typeof s.projectTasks.$inferInsert> = {}) {
  const id = newId();
  await db.insert(s.projectTasks).values({ id, projectId, taskId, ...over });
  return id;
}

export async function closeDb() {
  await closePool();
}

export { db, sql, s, raw };

/**
 * Assert that a query was rejected by a specific database constraint.
 *
 * Drizzle wraps driver errors, so the constraint name lives on `cause`, not in
 * the message. Matching on the name rather than the text is what makes these
 * assertions mean "the database refused this", not "some error happened".
 */
export async function expectConstraintViolation(promise: Promise<unknown>, constraint: string) {
  try {
    await promise;
  } catch (e) {
    const chain: unknown[] = [];
    let cur: unknown = e;
    while (cur && chain.length < 5) {
      chain.push(cur);
      cur = (cur as { cause?: unknown }).cause;
    }
    const names = chain.map((c) => (c as { constraint_name?: string }).constraint_name).filter(Boolean);
    if (names.includes(constraint)) return;

    // Deliberately NOT a substring match on the message. The chain includes the
    // failing SQL, which quotes the constraint name, so a text match would pass
    // for any unrelated failure that happened to mention it.
    const text = chain.map((c) => String((c as Error).message ?? "")).join(" | ");
    throw new Error(`Expected constraint "${constraint}". Got constraints [${names.join(", ")}] and message: ${text}`);
  }
  throw new Error(`Expected constraint "${constraint}" to reject the query, but it succeeded.`);
}
