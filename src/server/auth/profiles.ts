/**
 * Keeping stored profiles in step with the code.
 *
 * `permission_profiles.capabilities` is a snapshot of a code constant. Without
 * reconciliation, adding a capability to `administrator` in a release leaves
 * every existing administrator row holding the old array, and the symptom is a
 * 403 on a button that obviously should work, fixable only by hand-editing SQL.
 *
 * So the base profiles are reconciled on every migration and every seed:
 * capabilities and names are rewritten from the code, custom profiles are left
 * alone, and a base profile that has been deleted is recreated.
 */

import { eq } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import * as s from "@/server/db/schema";
import { newId } from "@/server/db/ids";
import { BASE_PROFILES, isCapability, type BaseProfileKey } from "./capabilities";

export interface ProfileSyncResult {
  created: string[];
  updated: string[];
  ids: Record<BaseProfileKey, string>;
}

export async function syncBaseProfiles(db: Db): Promise<ProfileSyncResult> {
  const existing = await db
    .select({
      id: s.permissionProfiles.id,
      baseKey: s.permissionProfiles.baseKey,
      name: s.permissionProfiles.name,
      capabilities: s.permissionProfiles.capabilities,
    })
    .from(s.permissionProfiles);

  const byKey = new Map(existing.filter((p) => p.baseKey).map((p) => [p.baseKey!, p]));
  const result: ProfileSyncResult = { created: [], updated: [], ids: {} as Record<BaseProfileKey, string> };

  for (const [key, definition] of Object.entries(BASE_PROFILES) as [BaseProfileKey, (typeof BASE_PROFILES)[BaseProfileKey]][]) {
    // Guards against a typo in the constant reaching the database, where it
    // would sit as a capability nothing ever grants.
    const unknown = definition.capabilities.filter((c) => !isCapability(c));
    if (unknown.length) {
      throw new Error(`Profile "${key}" declares capabilities that do not exist: ${unknown.join(", ")}`);
    }

    const capabilities = [...new Set(definition.capabilities)].sort();
    const current = byKey.get(key);

    if (!current) {
      const id = newId();
      await db.insert(s.permissionProfiles).values({
        id,
        name: definition.name,
        isBase: true,
        baseKey: key,
        capabilities,
      });
      result.created.push(key);
      result.ids[key] = id;
      continue;
    }

    result.ids[key] = current.id;

    const same =
      current.name === definition.name &&
      current.capabilities.length === capabilities.length &&
      [...current.capabilities].sort().every((c, i) => c === capabilities[i]);

    if (!same) {
      await db
        .update(s.permissionProfiles)
        .set({ name: definition.name, capabilities, isBase: true })
        .where(eq(s.permissionProfiles.id, current.id));
      result.updated.push(key);
    }
  }

  return result;
}

/** The id of a base profile, for seeds and invites. */
export async function baseProfileId(db: Db, key: BaseProfileKey): Promise<string> {
  const [row] = await db
    .select({ id: s.permissionProfiles.id })
    .from(s.permissionProfiles)
    .where(eq(s.permissionProfiles.baseKey, key))
    .limit(1);
  if (!row) throw new Error(`Base profile "${key}" is missing. Run pnpm db:migrate.`);
  return row.id;
}
