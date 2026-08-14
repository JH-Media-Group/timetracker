import { route } from "@/server/http";
import { stopTimer } from "@/server/services/time";

export const POST = route(async (ctx) => stopTimer(ctx), { rateLimit: "write" });
