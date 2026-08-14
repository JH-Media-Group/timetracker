import { route } from "@/server/http";
import { mySubmissions } from "@/server/services/approvals";

/** The caller's own submissions, whatever their review capability. */
export const GET = route(async (ctx) => mySubmissions(ctx), { rateLimit: "read" });
