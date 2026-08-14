import { z } from "zod";
import { body, route } from "@/server/http";
import { approveMany } from "@/server/services/approvals";

const schema = z.object({ ids: z.array(z.string().uuid()).min(1).max(200) });

export const POST = route(
  async (ctx, req) => {
    const { ids } = await body(req, schema);
    return { approved: await approveMany(ctx, ids) };
  },
  { rateLimit: "write", capability: "approval:review" }
);
