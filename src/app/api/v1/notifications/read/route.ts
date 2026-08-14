import { z } from "zod";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { body, route } from "@/server/http";
import * as s from "@/server/db/schema";

const schema = z.object({ ids: z.array(z.string().uuid()).optional() });

/** Marks the named notifications read, or all of them. Always scoped to the actor. */
export const POST = route(
  async (ctx, req) => {
    const { ids } = await body(req, schema).catch(() => ({ ids: undefined }));

    const rows = await ctx.db
      .update(s.notifications)
      .set({ readAt: ctx.now() })
      .where(
        and(
          eq(s.notifications.userId, ctx.actor.userId),
          isNull(s.notifications.readAt),
          ids?.length ? inArray(s.notifications.id, ids) : undefined
        )
      )
      .returning({ id: s.notifications.id });

    return { read: rows.length };
  },
  { rateLimit: "write" }
);
