import { route } from "@/server/http";
import { listRecurring } from "@/server/services/invoices";

export const GET = route(async (ctx) => listRecurring(ctx), {
  rateLimit: "read",
  capability: "invoice:view",
});
