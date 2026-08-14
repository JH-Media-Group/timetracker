import { body, route } from "@/server/http";
import { submitSchema } from "@/server/schemas";
import { submitTimesheet } from "@/server/services/approvals";

export const POST = route(
  async (ctx, req) => submitTimesheet(ctx, await body(req, submitSchema)),
  { rateLimit: "write", capability: "approval:submit" }
);
