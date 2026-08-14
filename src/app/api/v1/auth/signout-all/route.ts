/**
 * POST /api/v1/auth/signout-all
 *
 * Ends every session in the account, including the caller's own. This is the
 * button you press after a laptop goes missing, so it does not exempt the
 * person pressing it: an exemption is a session left alive on the device you
 * are least sure about.
 */

import { sql } from "drizzle-orm";
import { route } from "@/server/http";
import * as s from "@/server/db/schema";
import { clearedCookieOptions } from "@/server/auth/session";

export const POST = route(
  async (ctx) => {
    const rows = await ctx.db
      .update(s.sessions)
      .set({ revokedAt: ctx.now() })
      .where(sql`${s.sessions.revokedAt} IS NULL`)
      .returning({ id: s.sessions.id });

    ctx.audit({
      action: "session.revoke_all",
      entityType: "session",
      after: { revoked: rows.length },
    });

    return { revoked: rows.length };
  },
  {
    rateLimit: "write",
    capability: "settings:manage",
    // The caller's own session is among the revoked ones, so the cookie it
    // just presented is dead. Leaving it in the browser means every later
    // request carries a credential that no longer works, and the middleware,
    // which only checks that a cookie exists, keeps letting the shell render.
    clearSessionCookie: true,
  }
);
