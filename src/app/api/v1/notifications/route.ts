import { and, desc, eq, isNull } from "drizzle-orm";
import { route } from "@/server/http";
import * as s from "@/server/db/schema";

/** The caller's unread notifications. Scoped by construction: user_id is the actor. */
export const GET = route(
  async (ctx) => {
    const rows = await ctx.db
      .select()
      .from(s.notifications)
      .where(and(eq(s.notifications.userId, ctx.actor.userId), isNull(s.notifications.readAt)))
      .orderBy(desc(s.notifications.createdAt))
      .limit(50);

    return rows.map((n) => ({
      id: n.id,
      kind: n.kind,
      title: n.title,
      body: n.body,
      url: n.url,
      createdAt: n.createdAt.toISOString(),
    }));
  },
  { rateLimit: "read" }
);
