import { route } from "@/server/http";
import { markSent } from "@/server/services/invoices";

export const POST = route(
  async (ctx, _req, params) => markSent(ctx, params.id!),
  { rateLimit: "write", capability: "invoice:send" }
);
