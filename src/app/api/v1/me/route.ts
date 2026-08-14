/**
 * GET /api/v1/me      the signed-in person
 * PATCH /api/v1/me    their own preferences
 */

import { eq } from "drizzle-orm";
import { z } from "zod";
import * as s from "@/server/db/schema";
import { body, route } from "@/server/http";
import { notFound } from "@/server/errors";
import { serializeUser } from "@/server/serialize";
import { rateFor } from "@/server/services/rates";

export const GET = route(async (ctx) => {
  const [user] = await ctx.db.select().from(s.users).where(eq(s.users.id, ctx.actor.userId)).limit(1);
  if (!user) throw notFound("Your account");

  const [billable, cost] = await Promise.all([
    rateFor(ctx, user.id, "billable"),
    rateFor(ctx, user.id, "cost"),
  ]);

  return serializeUser(ctx, user, {
    billableRateCents: billable ?? undefined,
    costRateCents: cost ?? undefined,
  });
}, { rateLimit: "read" });

/**
 * A timezone the platform actually knows.
 *
 * `min(1)` accepted anything, and every calendar-day resolution afterwards
 * throws `RangeError: Invalid time zone specified`, so one bad preference
 * turned every later time-entry write into a 500 for that person and for
 * anybody logging time on their behalf.
 */
const timezone = z.string().refine(
  (v) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: v });
      return true;
    } catch {
      return false;
    }
  },
  { message: "That is not a timezone this system knows." }
);

const patchSchema = z.object({
  theme: z.enum(["system", "light", "dark"]).optional(),
  timezone: timezone.optional(),
  notificationPrefs: z.record(z.string(), z.unknown()).optional(),
});

export const PATCH = route(async (ctx, req) => {
  const input = await body(req, patchSchema);

  const [updated] = await ctx.db
    .update(s.users)
    .set({
      ...(input.theme ? { theme: input.theme } : {}),
      ...(input.timezone ? { timezone: input.timezone } : {}),
      ...(input.notificationPrefs ? { notificationPrefs: input.notificationPrefs } : {}),
      updatedAt: ctx.now(),
    })
    .where(eq(s.users.id, ctx.actor.userId))
    .returning();

  if (!updated) throw notFound("Your account");
  return serializeUser(ctx, updated);
}, { rateLimit: "write" });
