import { route } from "@/server/http";
import { listRetainers } from "@/server/services/invoices";

export const GET = route(async (ctx) => listRetainers(ctx), {
  rateLimit: "read",
  capability: "invoice:view",
});
