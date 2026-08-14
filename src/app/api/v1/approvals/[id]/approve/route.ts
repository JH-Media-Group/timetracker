import { body, route } from "@/server/http";
import { reviewSchema } from "@/server/schemas";
import { approveSubmission } from "@/server/services/approvals";

export const POST = route(
  async (ctx, req, params) => {
    const parsed = await body(req, reviewSchema).catch(() => ({ note: undefined }));
    return approveSubmission(ctx, params.id!, parsed.note);
  },
  { rateLimit: "write", capability: "approval:review" }
);
