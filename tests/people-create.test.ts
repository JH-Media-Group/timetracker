import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { BASE_PROFILES } from "@/server/auth/capabilities";
import { createCtx } from "@/server/ctx";
import * as s from "@/server/db/schema";
import { createUser } from "@/server/services/people";
import { closeDb, db, resetDb, seedProfiles } from "./helpers";

beforeEach(resetDb);
afterAll(closeDb);

describe("createUser", () => {
  it("creates an account without a password", async () => {
    const profiles = await seedProfiles();
    const actorId = crypto.randomUUID();
    await db.insert(s.users).values({ id: actorId, email: "creator@example.com", firstName: "A", lastName: "Admin", profileId: profiles.administrator });
    const user = await createUser(createCtx({ actor: {
      userId: actorId,
      profileId: profiles.administrator!,
      baseKey: "administrator",
      capabilities: new Set(BASE_PROFILES.administrator.capabilities),
      kind: "user",
      timezone: "America/New_York",
      isOwner: false,
    } }), {
      firstName: "Sample colleague", lastName: "Moncada", email: "sample.person@example.com",
      timezone: "America/New_York", weeklyCapacitySeconds: 72000,
      employmentType: "contractor", profileId: profiles.administrator,
    });
    expect(user.email).toBe("sample.person@example.com");
    const [stored] = await db.select().from(s.users).where(eq(s.users.id, user.id));
    expect(stored!.passwordHash).toBeNull();
  });
});
