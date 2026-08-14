import { z } from "zod";
import { body, route } from "@/server/http";
import { getSettings, updateSettings } from "@/server/services/settings";
import { serializeSettings } from "@/server/serialize";

export const GET = route(async (ctx) => serializeSettings(await getSettings(ctx)), { rateLimit: "read" });

const patchSchema = z.object({
  companyName: z.string().trim().min(1).optional(),
  companyAddress: z.string().nullable().optional(),
  baseCurrency: z.string().length(3).optional(),
  timezone: z.string().min(1).optional(),
  weekStartsOn: z.number().int().min(0).max(7).optional(),
  fiscalYearStartMonth: z.number().int().min(1).max(12).optional(),
  timerMode: z.enum(["duration", "start_end"]).optional(),
  timeDisplay: z.enum(["decimal", "hours_minutes"]).optional(),
  roundingMinutes: z.number().int().min(0).max(60).optional(),
  roundingMode: z.enum(["nearest", "up", "down"]).optional(),
  requireNotes: z.enum(["never", "always", "non_billable"]).optional(),
  allowFutureDates: z.boolean().optional(),
  flagMissingBelowSeconds: z.number().int().min(0).nullable().optional(),
  lockTimesheetsAfterDays: z.number().int().min(0).nullable().optional(),
  projectNotesVisibility: z.enum(["managers", "everyone"]).optional(),
  modules: z.record(z.string(), z.boolean()).optional(),
  invoiceNumberPattern: z.string().min(1).optional(),
});

export const PATCH = route(async (ctx, req) => {
  const input = await body(req, patchSchema);
  return serializeSettings(await updateSettings(ctx, input as never));
}, { rateLimit: "write", capability: "settings:manage" });
