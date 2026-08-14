import { z } from "zod";
import { body, route } from "@/server/http";
import { recordMessage } from "@/server/services/invoices";

const schema = z.object({
  to: z.array(z.string().email()).min(1),
  subject: z.string().max(300).optional(),
  body: z.string().max(20000).optional(),
});

export const POST = route(
  async (ctx, req, params) => {
    const input = await body(req, schema);
    return recordMessage(ctx, params.id!, "reminder", { to: input.to }, input.subject, input.body);
  },
  { rateLimit: "email", capability: "invoice:send" }
);
