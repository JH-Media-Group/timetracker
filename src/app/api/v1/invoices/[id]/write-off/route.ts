import { route } from "@/server/http";
import { writeOff } from "@/server/services/invoices";

/**
 * Entries stay attached and locked, so the work is not accidentally billed a
 * second time. Any retainer draw is reversed with a compensating transaction.
 */
export const POST = route(
  async (ctx, _req, params) => writeOff(ctx, params.id!),
  { rateLimit: "write", capability: "invoice:manage" }
);
