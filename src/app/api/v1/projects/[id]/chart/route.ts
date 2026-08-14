import { z } from "zod";
import { query, route } from "@/server/http";
import { projectChart } from "@/server/services/reports";
import { notFound } from "@/server/errors";

const schema = z.object({ metric: z.enum(["progress", "hours"]).default("progress") });

export const GET = route(
  async (ctx, req, params) => {
    const { metric } = query(req, schema);
    try {
      return await projectChart(ctx, params.id!, metric);
    } catch (e) {
      if (e instanceof Error && e.message === "not_found") throw notFound("That project");
      throw e;
    }
  },
  { rateLimit: "report", capability: "report:view_own", transactional: false }
);
