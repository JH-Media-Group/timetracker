import { body, route } from "@/server/http";
import { invoiceConfigSchema } from "@/server/schemas";
import { getInvoiceConfig, updateInvoiceConfig } from "@/server/services/invoice-config";

/**
 * Reading has no capability, matching `GET /settings`.
 *
 * The invoice document needs the field labels to render its column headings, so
 * anybody who may see an invoice needs this. There is nothing here worth
 * hiding: it is what the columns are called and what the company's address is,
 * both of which are printed on the invoice itself.
 */
export const GET = route(async (ctx) => getInvoiceConfig(ctx), { rateLimit: "read" });

export const PATCH = route(
  async (ctx, req) => updateInvoiceConfig(ctx, await body(req, invoiceConfigSchema)),
  { rateLimit: "write", capability: "settings:manage" }
);
