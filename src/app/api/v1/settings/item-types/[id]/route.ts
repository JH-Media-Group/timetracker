import { z } from "zod";
import { body, route } from "@/server/http";
import { removeItemType, updateItemType } from "@/server/services/item-types";

const patchSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  isDefaultForExpenses: z.boolean().optional(),
  isDefaultForServices: z.boolean().optional(),
});

export const PATCH = route(
  async (ctx, req, params) => updateItemType(ctx, params.id!, await body(req, patchSchema)),
  { rateLimit: "write", capability: "settings:manage" }
);

/**
 * Archives when the type is in use, deletes when it never was.
 *
 * A type behind a line on a sent invoice cannot be deleted: that invoice is a
 * document somebody else is holding, and it has to keep rendering.
 */
export const DELETE = route(
  async (ctx, _req, params) => removeItemType(ctx, params.id!),
  { rateLimit: "write", capability: "settings:manage" }
);
