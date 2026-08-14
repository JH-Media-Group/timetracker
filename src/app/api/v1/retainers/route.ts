import { z } from "zod";
import { body, route } from "@/server/http";
import { createRetainer, listRetainers } from "@/server/services/retainers";

export const GET = route(async (ctx) => listRetainers(ctx), {
  rateLimit: "read",
  capability: "invoice:view",
});

const createSchema = z.object({
  clientId: z.string().uuid("Choose a client."),
  projectId: z.string().uuid().nullable().optional(),
  openingCents: z.number().int().min(0).optional(),
  note: z.string().max(500).nullable().optional(),
});

/**
 * Opening a retainer records money a client has handed over, so a retried
 * request must not open two of them and credit the funds twice.
 */
export const POST = route(
  async (ctx, req) => createRetainer(ctx, await body(req, createSchema)),
  { rateLimit: "write", capability: "invoice:manage", requireIdempotencyKey: true }
);
