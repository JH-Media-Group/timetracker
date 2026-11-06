import { z } from "zod";
import { query, route } from "@/server/http";
import { timeRollups } from "@/server/services/time-rollups";

const schema = z.object({ group_by: z.enum(["project", "client", "task"]) });
export const GET = route((ctx, req) => timeRollups(ctx, query(req, schema).group_by), { rateLimit: "report" });
