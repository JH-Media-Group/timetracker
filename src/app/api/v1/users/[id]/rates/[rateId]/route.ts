import { route } from "@/server/http";
import { deleteRate } from "@/server/services/rates";

/** The user id is part of the lookup, not decoration: see deleteRate. */
export const DELETE = route(async (ctx, _req, params) => {
  await deleteRate(ctx, params.id!, params.rateId!);
  return { deleted: true };
}, { rateLimit: "write", capability: "rates:manage" });
