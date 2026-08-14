import { z } from "zod";
import { body, route } from "@/server/http";
import { isoDate } from "@/server/schemas";
import { duplicateTimeEntry } from "@/server/services/time";

const schema = z.object({ spentOn: isoDate.optional() });

export const POST = route(async (ctx, req, params) => {
  const parsed = await body(req, schema).catch(() => ({ spentOn: undefined }));
  return duplicateTimeEntry(ctx, params.id!, parsed.spentOn);
}, { rateLimit: "write", capability: "time:create_own" });
