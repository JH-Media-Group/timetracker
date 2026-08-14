import { route } from "@/server/http";
import { listUninvoiced } from "@/server/services/invoices";

/**
 * Every client with work done and not billed.
 *
 * `invoice:view`, not `invoice:manage`: this answers "what is owed to us",
 * which is the same question the invoices list answers, and somebody who may
 * read the invoices may read this. Turning it into an invoice still needs
 * `invoice:manage`, and `preview-lines` enforces that.
 */
export const GET = route(async (ctx) => listUninvoiced(ctx), {
  rateLimit: "report",
  capability: "invoice:view",
});
