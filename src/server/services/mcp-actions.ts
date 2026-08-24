import { eq } from "drizzle-orm";
import type { Ctx } from "@/server/ctx";
import * as s from "@/server/db/schema";
import { notFound, validationFailed } from "@/server/errors";
import { instantAt, nextIsoDay, crossesMidnight, resolveClockTime } from "@/lib/format";
import { createTimeEntry, deleteTimeEntry, getTimeEntry, restoreTimeEntry, stopTimer, updateTimeEntry } from "./time";
import { submitTimesheet, approveSubmission, requestChanges } from "./approvals";
import { createClient, updateClient, archiveClient } from "./clients";
import { createProject, updateProject, archiveProject } from "./projects";
import { createTask, updateTask } from "./tasks";
import { createUser, updateUser, archiveUser } from "./people";
import { createExpenseCategory, updateExpenseCategory } from "./expenses";
import { updateInvoiceConfig } from "./invoice-config";
import { auditForUndo, checkpointDiff, confirmation, undoToken, type ConfirmationPlan } from "./mcp-safety";

type Input = Record<string, any>;
const plan = (action: string, type: string, input: Input, id?: string): ConfirmationPlan => ({ action, records: [{ type, id, label: String(input.name ?? input.email ?? id ?? "new record") }], changes: Object.fromEntries(Object.entries(input).filter(([key]) => key !== "confirmationToken")) });
function confirmed(ctx: Ctx, action: string, type: string, input: Input, id?: string) { return confirmation(ctx, action, { ...input, confirmationToken: undefined }, plan(action, type, input, id), input.confirmationToken); }

export async function mcpTimeLog(ctx: Ctx, input: Input) {
  if (input.userId && input.userId !== ctx.actor.userId) { const check = await confirmed(ctx, "time.log.other", "time_entry", input, input.userId); if (!check.confirmed) return check; }
  const targetId = input.userId ?? ctx.actor.userId;
  let startedAt: string | undefined, endedAt: string | undefined;
  if (input.startedAt || input.endedAt) {
    if (!input.startedAt || !input.endedAt) throw validationFailed({ startedAt: ["Start and end are required together."] });
    const [owner] = await ctx.db.select({ timezone: s.users.timezone }).from(s.users).where(eq(s.users.id, targetId)).limit(1);
    if (!owner) throw notFound("That person");
    const start = resolveClockTime(input.startedAt), end = resolveClockTime(input.endedAt, { after: start });
    if (start == null || end == null) throw validationFailed({ startedAt: ["Use a clock time such as 9:00am or 17:30."] });
    const spentOn = input.spentOn ?? new Intl.DateTimeFormat("en-CA", { timeZone: owner.timezone }).format(ctx.now());
    startedAt = instantAt(spentOn, start, owner.timezone);
    endedAt = instantAt(crossesMidnight(start, end) ? nextIsoDay(spentOn) : spentOn, end, owner.timezone);
  }
  const result = await createTimeEntry(ctx, { userId: input.userId, projectId: input.projectId, taskId: input.taskId, spentOn: input.spentOn, durationSeconds: input.durationSeconds, startedAt, endedAt, notes: input.notes, isBillable: input.isBillable, source: "mcp" });
  return { data: result };
}

export async function mcpTimeEdit(ctx: Ctx, id: string, input: Input) {
  const before = await getTimeEntry(ctx, id);
  if (before.userId !== ctx.actor.userId) { const check = await confirmed(ctx, "time.edit.other", "time_entry", input, id); if (!check.confirmed) return check; }
  let startedAt: string | null | undefined, endedAt: string | null | undefined;
  if (input.startedAt !== undefined || input.endedAt !== undefined) {
    if (!input.startedAt || !input.endedAt) throw validationFailed({ startedAt: ["Start and end are required together."] });
    const [owner] = await ctx.db.select({ timezone: s.users.timezone }).from(s.users).where(eq(s.users.id, before.userId)).limit(1);
    if (!owner) throw notFound("That person");
    const start = resolveClockTime(input.startedAt), end = resolveClockTime(input.endedAt, { after: start });
    if (start == null || end == null) throw validationFailed({ startedAt: ["Use a clock time such as 9:00am or 17:30."] });
    const spentOn = input.spentOn ?? before.spentOn;
    startedAt = instantAt(spentOn, start, owner.timezone);
    endedAt = instantAt(crossesMidnight(start, end) ? nextIsoDay(spentOn) : spentOn, end, owner.timezone);
  }
  const data = await updateTimeEntry(ctx, id, { ...input, startedAt, endedAt });
  return { data, undoToken: undoToken(ctx) };
}
export async function mcpTimeDelete(ctx: Ctx, id: string, input: Input = {}) {
  const before = await getTimeEntry(ctx, id);
  if (before.userId !== ctx.actor.userId) { const check = await confirmed(ctx, "time.delete.other", "time_entry", input, id); if (!check.confirmed) return check; }
  await deleteTimeEntry(ctx, id);
  return { data: { deleted: true }, undoToken: undoToken(ctx) };
}
export async function mcpTimerStop(ctx: Ctx) { return { data: await stopTimer(ctx) }; }
export async function mcpWeekSubmit(ctx: Ctx, input: Input) { if (input.userId && input.userId !== ctx.actor.userId) { const check = await confirmed(ctx, "week.submit.other", "timesheet_submission", input, input.userId); if (!check.confirmed) return check; } return { data: await submitTimesheet(ctx, { periodStart: input.periodStart, userId: input.userId }) }; }
export async function mcpApprovalDecision(ctx: Ctx, input: Input) { const check = await confirmed(ctx, "approval.decide", "timesheet_submission", input, input.submission_id); if (!check.confirmed) return check; const data = input.decision === "approve" ? await approveSubmission(ctx, input.submission_id, input.note) : await requestChanges(ctx, input.submission_id, input.note ?? "Changes requested through Tally MCP."); return { data }; }

export async function mcpAdminAction(ctx: Ctx, entity: string, operation: "create" | "update" | "members", id: string | undefined, input: Input) {
  const action = `${entity}.${operation}`; const check = await confirmed(ctx, action, entity, input, id); if (!check.confirmed) return check;
  let data: unknown;
  const archiveOnly = operation === "update" && input.archived !== undefined;
  if (archiveOnly && Object.keys(input).some((key) => !["archived", "confirmationToken"].includes(key))) throw validationFailed({ archived: ["Archive or restore must be confirmed as its own operation."] });
  if (entity === "client") data = operation === "create" ? await createClient(ctx, input as any) : archiveOnly ? await archiveClient(ctx, id!, input.archived) : await updateClient(ctx, id!, input);
  else if (entity === "project") data = operation === "create" ? await createProject(ctx, input as any) : archiveOnly ? await archiveProject(ctx, id!, input.archived) : await updateProject(ctx, id!, input);
  else if (entity === "task") data = operation === "create" ? await createTask(ctx, input as any) : await updateTask(ctx, id!, input);
  else if (entity === "person") data = operation === "create" ? await createUser(ctx, input as any) : archiveOnly ? await archiveUser(ctx, id!, input.archived) : await updateUser(ctx, id!, input);
  else if (entity === "expense_category") data = await createExpenseCategory(ctx, input as any);
  else if (entity === "invoice_config") data = await updateInvoiceConfig(ctx, { section: input.section, value: input.values } as any);
  else throw validationFailed({ entity: ["Unsupported MCP administrative entity."] });
  return { data, undoToken: undoToken(ctx) };
}

export async function mcpUndo(ctx: Ctx, token: string) {
  const audit = await auditForUndo(ctx, token); const before = audit.before as any; const id = audit.entityId!;
  if (audit.action === "time_entry.update") return { data: await updateTimeEntry(ctx, id, { projectId: before.projectId, taskId: before.taskId, spentOn: before.spentOn, durationSeconds: before.durationSeconds, startedAt: before.startedAt, endedAt: before.endedAt, notes: before.notes, isBillable: before.isBillable }) };
  if (audit.action === "time_entry.delete") return { data: await restoreTimeEntry(ctx, id) };
  if (audit.action === "client.create") return { data: await archiveClient(ctx, id, true) };
  if (audit.action === "client.update") return { data: await updateClient(ctx, id, before) };
  if (audit.action === "client.archive") return { data: await archiveClient(ctx, id, false) };
  if (audit.action === "client.restore") return { data: await archiveClient(ctx, id, true) };
  if (audit.action === "project.create") return { data: await archiveProject(ctx, id, true) };
  if (audit.action === "project.update") return { data: await updateProject(ctx, id, before) };
  if (audit.action === "project.archive") return { data: await archiveProject(ctx, id, false) };
  if (audit.action === "project.restore") return { data: await archiveProject(ctx, id, true) };
  if (audit.action === "user.create") return { data: await archiveUser(ctx, id, true) };
  if (audit.action === "user.update") return { data: await updateUser(ctx, id, before) };
  if (audit.action === "user.archive") return { data: await archiveUser(ctx, id, false) };
  if (audit.action === "user.restore") return { data: await archiveUser(ctx, id, true) };
  if (audit.action === "task.create") return { data: await updateTask(ctx, id, { archived: true }) };
  if (audit.action === "task.update") return { data: await updateTask(ctx, id, { name: before.name, defaultBillable: before.isDefaultBillable, isCommon: before.isCommon, defaultHourlyRateCents: before.defaultHourlyRateCents }) };
  if (audit.action === "task.archive") return { data: await updateTask(ctx, id, { archived: false }) };
  if (audit.action === "task.restore") return { data: await updateTask(ctx, id, { archived: true }) };
  if (audit.action === "expense_category.create") return { data: await updateExpenseCategory(ctx, id, { archived: true }) };
  if (audit.action.startsWith("settings.invoice_") && audit.action.endsWith(".update")) { const section = audit.action.slice("settings.invoice_".length, -".update".length); return { data: await updateInvoiceConfig(ctx, { section, value: before[section] } as any) }; }
  throw validationFailed({ undoToken: ["That kind of change does not have an undo operation."] });
}
export async function mcpCheckpointDiff(ctx: Ctx, since: string, limit = 50) { return { data: await checkpointDiff(ctx, new Date(since), limit) }; }
