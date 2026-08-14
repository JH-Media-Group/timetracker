import { body, route } from "@/server/http";
import { previewLinesSchema } from "@/server/schemas";
import { previewLines } from "@/server/services/invoices";

/**
 * What could go on an invoice for this client. Writes nothing: the draft claims
 * the work, and until then it stays available to any other invoice.
 */
export const POST = route(
  async (ctx, req) => previewLines(ctx, await body(req, previewLinesSchema)),
  { rateLimit: "report", capability: "invoice:manage", transactional: false }
);
