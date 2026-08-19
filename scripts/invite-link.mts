/**
 * Create somebody an account and print their one-time set-password link.
 *
 * `bootstrap-owner` does this for the first owner and refuses everybody else,
 * deliberately: it is the one account that exists before anybody can sign in.
 * This is the same idea for the people who come after, and it exists because a
 * queued invite is not a delivered invite. Until a timer drains
 * `outbound_messages` on the host, pressing "Send invite" in the UI writes a
 * row that nothing sends, and the person waits for an email that will never
 * arrive. Printing the link lets you hand it over yourself.
 *
 * It does **not** mint the token by hand. It calls the same `inviteUser` the
 * button calls, then reads the link out of the message that was queued, so
 * there is one implementation of "what is a valid invite" and the audit row and
 * the outbox event are written exactly as they would be from a request. The
 * queued message is left alone: if mail starts working later, the same link is
 * delivered, and it is the same token rather than a second one.
 *
 *   pnpm invite:link --email a@b.com
 *   pnpm invite:link --email a@b.com --first Ada --last Lovelace --profile Administrator
 *
 * On the droplet, inside the running container:
 *
 *   node ops/invite-link.mjs --email a@b.com --first Ada --last Lovelace
 *
 * The link is a credential for as long as it is unused. Treat the terminal
 * output as one, send it over something private, and close the scrollback.
 */

import { desc, eq } from "drizzle-orm";
import { db } from "../src/server/db/client";
import * as s from "../src/server/db/schema";
import { withTransaction } from "../src/server/ctx";
import { systemCtx } from "../src/server/jobs/context";
import { createUser } from "../src/server/services/people";
import { inviteUser } from "../src/server/services/auth-tokens";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const email = arg("email")?.trim().toLowerCase();
const first = arg("first")?.trim();
const last = arg("last")?.trim();
const profileName = arg("profile")?.trim() ?? "Member";
const timezone = arg("timezone")?.trim();

async function main() {
  if (!email) throw new Error("--email is required.");

  const ctx = await systemCtx();

  const [existing] = await db
    .select({ id: s.users.id, firstName: s.users.firstName, lastName: s.users.lastName })
    .from(s.users)
    .where(eq(s.users.email, email))
    .limit(1);

  if (!existing && !(first && last)) {
    throw new Error(
      `No account for ${email}. To create one, pass --first and --last (and --profile if it is not Member).`
    );
  }

  const userId = await withTransaction(ctx, async (tx) => {
    if (existing) return existing.id;

    const [profile] = await tx.db
      .select({ id: s.permissionProfiles.id })
      .from(s.permissionProfiles)
      .where(eq(s.permissionProfiles.name, profileName))
      .limit(1);

    if (!profile) {
      const all = await tx.db.select({ name: s.permissionProfiles.name }).from(s.permissionProfiles);
      throw new Error(
        `No permission profile named "${profileName}". Available: ${all.map((p) => p.name).join(", ")}.`
      );
    }

    // The account timezone, not this machine's. A person's calendar days are
    // resolved in their own zone, and getting it wrong moves their entries.
    const [settings] = await tx.db.select({ timezone: s.settings.timezone }).from(s.settings).limit(1);

    const created = await createUser(tx, {
      firstName: first!,
      lastName: last!,
      email,
      timezone: timezone ?? settings?.timezone ?? "America/New_York",
      weeklyCapacitySeconds: 144_000,
      employmentType: "employee",
      profileId: profile.id,
    });
    return created.id;
  });

  // Separate transaction, so a failure here cannot roll back the account. The
  // link can always be reissued; a half-created person is more annoying.
  await withTransaction(ctx, async (tx) => {
    await inviteUser(tx, userId);
  });

  const [message] = await db
    .select({ body: s.outboundMessages.bodyText, to: s.outboundMessages.toAddress })
    .from(s.outboundMessages)
    .where(eq(s.outboundMessages.userId, userId))
    /*
      Newest first. Ordering ascending and taking the first row printed the
      *oldest* invite, which `issue()` has just superseded, so a second run
      handed over a link that was already dead. Caught by running it twice.
    */
    .orderBy(desc(s.outboundMessages.createdAt))
    .limit(1);

  const link = /https?:\/\/\S*\/set-password\?token=[A-Za-z0-9_-]+/.exec(message?.body ?? "")?.[0];
  if (!link) {
    throw new Error(
      "The invite was recorded but no link was found in the queued message. Look at outbound_messages."
    );
  }

  const [row] = await db
    .select({ first: s.users.firstName, last: s.users.lastName })
    .from(s.users)
    .where(eq(s.users.id, userId))
    .limit(1);

  console.log("");
  console.log(`  ${row!.first} ${row!.last}  <${message!.to}>`);
  console.log(`  ${existing ? "existing account" : `created, ${profileName}`}`);
  console.log("");
  console.log(`  ${link}`);
  console.log("");
  console.log("  Works once, expires in seven days, and replaces any earlier link.");
  console.log("  Send it privately. Anybody holding it can set this person's password.");
  console.log("");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => db.$client.end());
