import { z } from "zod";
import { body, route } from "@/server/http";
import { requestChanges } from "@/server/services/approvals";

/** The note is required: a rejection without a reason is one somebody chases. */
const schema = z.object({ note: z.string().trim().min(1, "Say what needs to change.").max(2000) });

export const POST = route(
  async (ctx, req, params) => {
    const { note } = await body(req, schema);
    return requestChanges(ctx, params.id!, note);
  },
  { rateLimit: "write", capability: "approval:review" }
);
