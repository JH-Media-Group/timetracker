import { z } from "zod";
import { body, route } from "@/server/http";
import { isoDate } from "@/server/schemas";
import { remindToSubmit } from "@/server/services/approvals";

const schema = z.object({
  periodStart: isoDate,
  userIds: z.array(z.string().uuid()).optional(),
});

export const POST = route(
  async (ctx, req) => {
    const input = await body(req, schema);
    return { reminded: await remindToSubmit(ctx, input) };
  },
  { rateLimit: "email", capability: "approval:review" }
);
