import { z } from "zod";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { body, route } from "@/server/http";
import * as s from "@/server/db/schema";

// An explicit empty list means "these ones", of which there are none. Only an
// absent key means "all of them", and `[]` used to be read as the second.
const schema = z.object({ ids: z.array(z.string().uuid()).optional() });

/** No id can be this, so an empty selection matches nothing rather than everything. */
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

/** Marks the named notifications read, or all of them. Always scoped to the actor. */
export const POST = route(
  async (ctx, req) => {
    // Not caught. A malformed `ids` used to fall back to "mark everything
    // read", which is a silent, unrecoverable action taken because the request
    // was wrong.
    const { ids } = await body(req, schema);

    const rows = await ctx.db
      .update(s.notifications)
      .set({ readAt: ctx.now() })
      .where(
        and(
          eq(s.notifications.userId, ctx.actor.userId),
          isNull(s.notifications.readAt),
          ids === undefined ? undefined : inArray(s.notifications.id, ids.length ? ids : [ZERO_UUID])
        )
      )
      .returning({ id: s.notifications.id });

    return { read: rows.length };
  },
  { rateLimit: "write" }
);
