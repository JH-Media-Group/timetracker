import { route } from "@/server/http";
import { startTimerFrom } from "@/server/services/time";

/**
 * Starts a NEW entry from this one, taking its project, task, and notes.
 *
 * Returns both the started entry and whatever was stopped to make room, so the
 * client can show one combined toast rather than two.
 */
export const POST = route(async (ctx, _req, params) => startTimerFrom(ctx, params.id!), { rateLimit: "write", capability: "time:create_own" });
