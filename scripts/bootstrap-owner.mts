/** Mint the first owner's one-time set-password link on a new deployment. */
import { createHash, randomBytes } from "node:crypto";
import { and, count, eq, isNull } from "drizzle-orm";
import { db } from "../src/server/db/client";
import * as s from "../src/server/db/schema";
import { newId } from "../src/server/db/ids";
import { env } from "../src/server/env";

const digest = (token: string) => createHash("sha256").update(token).digest("hex");

async function main() {
  const owners = await db
    .select({ id: s.users.id, email: s.users.email, passwordHash: s.users.passwordHash })
    .from(s.users)
    .where(and(eq(s.users.isOwner, true), isNull(s.users.archivedAt)));

  if (owners.length !== 1) {
    throw new Error(`Owner bootstrap requires exactly one active owner; found ${owners.length}.`);
  }
  const owner = owners[0]!;
  if (owner.passwordHash) throw new Error("Owner bootstrap refused: the owner already has a password.");

  const [{ value: sessionCount }] = await db
    .select({ value: count() })
    .from(s.sessions)
    .where(eq(s.sessions.userId, owner.id));
  if (sessionCount !== 0) throw new Error("Owner bootstrap refused: the owner already has a session.");

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  await db.transaction(async (tx) => {
    await tx
      .update(s.authTokens)
      .set({ usedAt: new Date() })
      .where(and(eq(s.authTokens.userId, owner.id), eq(s.authTokens.purpose, "password_reset"), isNull(s.authTokens.usedAt)));
    await tx.insert(s.authTokens).values({
      id: newId(), userId: owner.id, purpose: "password_reset",
      tokenHash: digest(token), expiresAt, createdBy: null,
    });
  });

  console.log(`Owner: ${owner.email}`);
  console.log(`Expires: ${expiresAt.toISOString()}`);
  console.log(`${env.APP_URL.replace(/\/$/, "")}/set-password?token=${token}`);
  console.log("This link works once. Close the terminal after using it.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}).finally(() => db.$client.end());
