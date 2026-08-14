import { body, route } from "@/server/http";
import { invoicePatchSchema } from "@/server/schemas";
import { deleteInvoice, getInvoice, updateInvoice } from "@/server/services/invoices";

export const GET = route(
  async (ctx, _req, params) => getInvoice(ctx, params.id!),
  { rateLimit: "read", capability: "invoice:view" }
);

export const PATCH = route(
  async (ctx, req, params) => updateInvoice(ctx, params.id!, await body(req, invoicePatchSchema)),
  { rateLimit: "write", capability: "invoice:manage" }
);

/** Draft-only, unless the actor is an Administrator. Write-off is the alternative. */
export const DELETE = route(
  async (ctx, _req, params) => {
    await deleteInvoice(ctx, params.id!);
    return { deleted: true };
  },
  { rateLimit: "write", capability: "invoice:delete" }
);
