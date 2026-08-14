import { route } from "@/server/http";
import { archiveRetainer } from "@/server/services/retainers";

/**
 * Archives, never deletes. The transactions are how past invoices explain where
 * their money came from, and a retainer still holding funds is refused: money
 * must not leave the totals without a ledger row saying where it went.
 */
export const DELETE = route(
  async (ctx, _req, params) => archiveRetainer(ctx, params.id!),
  { rateLimit: "write", capability: "invoice:manage" }
);
