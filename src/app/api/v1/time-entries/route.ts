import { z } from "zod";
import { body, query, route } from "@/server/http";
import { isoDate, queryBool, timeEntrySchema } from "@/server/schemas";
import { createTimeEntry, listTimeEntries } from "@/server/services/time";

const listSchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  user_id: z.string().uuid().optional(),
  project_id: z.string().uuid().optional(),
  client_id: z.string().uuid().optional(),
  task_id: z.string().uuid().optional(),
  is_billable: queryBool,
  invoiced: queryBool,
  limit: z.coerce.number().int().min(1).max(10000).optional(),
  cursor: z.string().max(100).optional(),
});

export const GET = route(async (ctx, req) => {
  const q = query(req, listSchema);
  let offset = 0;
  if (q.cursor) {
    const decoded = Buffer.from(q.cursor, "base64url").toString("utf8");
    if (!/^\d+$/.test(decoded)) throw new z.ZodError([{ code: "custom", path: ["cursor"], message: "Invalid cursor", input: q.cursor }]);
    offset = Number(decoded);
  }
  const requested = q.limit ?? 5000;
  const rows = await listTimeEntries(ctx, {
    from: q.from,
    to: q.to,
    userId: q.user_id,
    projectId: q.project_id,
    clientId: q.client_id,
    taskId: q.task_id,
    isBillable: q.is_billable,
    invoiced: q.invoiced,
    limit: requested + 1,
    offset,
  });
  const hasMore = rows.length > requested;
  return { data: rows.slice(0, requested), meta: { count: Math.min(rows.length, requested), hasMore, nextCursor: hasMore ? Buffer.from(String(offset + requested)).toString("base64url") : null } };
}, { rateLimit: "read" });

export const POST = route(async (ctx, req) => createTimeEntry(ctx, await body(req, timeEntrySchema)), { rateLimit: "write", capability: "time:create_own" });
