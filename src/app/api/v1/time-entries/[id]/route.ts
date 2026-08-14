import { body, route } from "@/server/http";
import { timeEntryPatchSchema } from "@/server/schemas";
import { deleteTimeEntry, getTimeEntry, updateTimeEntry } from "@/server/services/time";

export const GET = route(async (ctx, _req, params) => getTimeEntry(ctx, params.id!), { rateLimit: "read" });

export const PATCH = route(async (ctx, req, params) =>
  updateTimeEntry(ctx, params.id!, await body(req, timeEntryPatchSchema))
, { rateLimit: "write" });

/** Soft delete, with a ten-second Undo window on the client. */
export const DELETE = route(async (ctx, _req, params) => {
  await deleteTimeEntry(ctx, params.id!);
  return { deleted: true };
}, { rateLimit: "write" });
