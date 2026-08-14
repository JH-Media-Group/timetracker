import { route } from "@/server/http";
import { closeInvoice } from "@/server/services/invoices";

export const POST = route(
  async (ctx, _req, params) => closeInvoice(ctx, params.id!),
  { rateLimit: "write", capability: "invoice:manage" }
);
