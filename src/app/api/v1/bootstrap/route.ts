import { route } from "@/server/http";
import { bootstrap } from "@/server/services/bootstrap";

export const GET = route(async (ctx) => bootstrap(ctx), { rateLimit: "read" });
