import { route } from "@/server/http";
import { voidPayment } from "@/server/services/invoices";

/** Voiding can move an invoice back from paid to open. */
export const POST = route(
  async (ctx, _req, params) => voidPayment(ctx, params.id!, params.paymentId!),
  { rateLimit: "write", capability: "invoice:manage" }
);
