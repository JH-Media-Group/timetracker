import { body, route } from "@/server/http";
import { rateSchema, rateSetSchema } from "@/server/schemas";
import { createRate, listRates, setRate } from "@/server/services/rates";

export const GET = route(async (ctx, _req, params) => listRates(ctx, params.id!), { rateLimit: "read" });

export const POST = route(async (ctx, req, params) => createRate(ctx, params.id!, await body(req, rateSchema)), { rateLimit: "write", capability: "rates:manage" });

/**
 * Change the rate from a date, closing whatever was in force.
 *
 * Separate from POST because they are different operations: POST adds an
 * explicit dated range and fails if it overlaps, which is right for correcting
 * history. This is the one a screen calls, and the one that does not make
 * somebody compute an end date by hand.
 */
export const PUT = route(
  async (ctx, req, params) => setRate(ctx, params.id!, await body(req, rateSetSchema)),
  { rateLimit: "write", capability: "rates:manage" }
);
