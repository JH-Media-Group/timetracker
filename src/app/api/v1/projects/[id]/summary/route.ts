import { route } from "@/server/http";
import { projectSummary } from "@/server/services/reports";
import { notFound } from "@/server/errors";

/** Everything the five KPI cards need, in one request. */
export const GET = route(
  async (ctx, _req, params) => {
    try {
      return await projectSummary(ctx, params.id!);
    } catch (e) {
      if (e instanceof Error && e.message === "not_found") throw notFound("That project");
      throw e;
    }
  },
  { rateLimit: "report", capability: "report:view_own", transactional: false }
);
