import { z } from "zod";
import { body, route } from "@/server/http";
import { createItemType, listItemTypes } from "@/server/services/item-types";

/**
 * Reading needs no capability, matching the rest of the settings reads: the
 * invoice document prints the type name on every line, so anybody who may see
 * an invoice needs the list.
 */
export const GET = route(async (ctx) => listItemTypes(ctx), { rateLimit: "read" });

const createSchema = z.object({
  name: z.string().trim().min(1).max(60),
  isDefaultForExpenses: z.boolean().optional(),
  isDefaultForServices: z.boolean().optional(),
});

export const POST = route(
  async (ctx, req) => createItemType(ctx, await body(req, createSchema)),
  { rateLimit: "write", capability: "settings:manage" }
);
