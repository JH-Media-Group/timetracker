import { z } from "zod";
import { body, route } from "@/server/http";
import { markSent, recordMessage } from "@/server/services/invoices";

const schema = z.object({
  to: z.array(z.string().email()).min(1, "Who should receive it?"),
  cc: z.array(z.string().email()).optional(),
  bcc: z.array(z.string().email()).optional(),
  subject: z.string().max(300).optional(),
  body: z.string().max(20000).optional(),
});

/**
 * Marks the invoice sent and records the message.
 *
 * If the invoice cannot actually be emailed (no SMTP transport configured), the
 * state change still happens and the message row says so, rather than the
 * timeline implying a delivery that never occurred.
 */
export const POST = route(
  async (ctx, req, params) => {
    const input = await body(req, schema);
    const invoice = await markSent(ctx, params.id!);
    const delivery = await recordMessage(
      ctx,
      params.id!,
      "invoice",
      { to: input.to, cc: input.cc, bcc: input.bcc },
      input.subject,
      input.body
    );
    return { ...invoice, delivered: delivery.delivered };
  },
  { rateLimit: "email", capability: "invoice:send" }
);
