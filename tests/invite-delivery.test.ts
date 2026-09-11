/**
 * What an invitation reports when nothing can deliver it.
 *
 * The rest of the invite suite mocks the transport as configured, which is the
 * right default for testing the credential rules and the wrong one for this:
 * the deployed state today is a queue with no transport behind it, and that is
 * exactly where the screen said "Invitation queued" for a message that cannot
 * be sent. `queueMail` has always written the row `not_configured` and returned
 * `queued: false`; `issue` threw the answer away and the caller reported the
 * flag the request had set.
 *
 * The cost is not cosmetic. Issuing supersedes whatever invitation the person
 * was holding, so the button spent a live credential, delivered nothing, and
 * said it had worked.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/mail/transport", async () => {
  const actual = await vi.importActual<typeof import("@/server/mail/transport")>("@/server/mail/transport");
  return { ...actual, canSend: () => false, send: vi.fn(async () => ({ messageId: null })) };
});

import { eq } from "drizzle-orm";
import { db } from "@/server/db/client";
import * as s from "@/server/db/schema";
import { newId } from "@/server/db/ids";
import { inviteUser } from "@/server/services/auth-tokens";
import { closeDb, makeUser, resetDb, seedProfiles } from "./helpers";

let profiles: Record<string, string>;
let plain: string;

/** A profile holding nothing, so the rank check is not what these test. */
async function emptyProfile(): Promise<string> {
  const id = newId();
  await db.insert(s.permissionProfiles).values({ id, name: `no-caps-${id}`, capabilities: [] });
  return id;
}

const session = (userId: string) =>
  ({
    db,
    audit: () => {},
    now: () => new Date(),
    actor: { userId, kind: "user", capabilities: new Set(["people:manage", "people:view"]) },
  }) as never;

beforeEach(async () => {
  await resetDb();
  profiles = await seedProfiles();
  plain = await emptyProfile();
});

afterAll(closeDb);

describe("an invitation with no transport behind the queue", () => {
  it("reports that it was not queued", async () => {
    const target = await makeUser({ profileId: plain, email: `nodeliver-${newId()}@example.test` });
    const caller = await makeUser({ profileId: profiles.administrator!, email: `admin-${newId()}@example.test` });

    const result = await inviteUser(session(caller), target, { email: true, link: false });
    expect(result.queued, "the queue could not take it, so say so").toBe(false);
  });

  it("writes the message as unsendable rather than as waiting", async () => {
    const target = await makeUser({ profileId: plain, email: `state-${newId()}@example.test` });
    const caller = await makeUser({ profileId: profiles.administrator!, email: `admin-${newId()}@example.test` });

    await inviteUser(session(caller), target, { email: true, link: false });
    const [row] = await db.select().from(s.outboundMessages).where(eq(s.outboundMessages.userId, target));
    expect(row!.state).toBe("not_configured");
  });

  it("still hands over a link, which is the way out", async () => {
    // The whole point of reporting it honestly is that there is something to
    // do about it, and it is one checkbox.
    const target = await makeUser({ profileId: plain, email: `link-${newId()}@example.test` });
    const caller = await makeUser({ profileId: profiles.administrator!, email: `admin-${newId()}@example.test` });

    const result = await inviteUser(session(caller), target, { email: true, link: true });
    expect(result.link).toMatch(/set-password\?token=/);
    expect(result.queued).toBe(false);
  });
});
