import { body, route } from "@/server/http";
import { recurringSchema } from "@/server/schemas";
import { deleteRecurring, getRecurring, updateRecurring } from "@/server/services/recurring";

export const GET = route(
  async (ctx, _req, params) => getRecurring(ctx, params.id!),
  { rateLimit: "read", capability: "invoice:view" }
);

export const PATCH = route(
  async (ctx, req, params) => updateRecurring(ctx, params.id!, await body(req, recurringSchema)),
  { rateLimit: "write", capability: "invoice:manage" }
);

/**
 * Deleting a schedule leaves the invoices it raised alone. They are documents a
 * client already has, and `invoices.recurring_invoice_id` is `on delete set
 * null` for exactly that reason.
 */
export const DELETE = route(
  async (ctx, _req, params) => {
    await deleteRecurring(ctx, params.id!);
    return { ok: true };
  },
  { rateLimit: "write", capability: "invoice:manage" }
);
