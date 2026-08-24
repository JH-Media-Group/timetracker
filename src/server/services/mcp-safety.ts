import { createHmac, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gte } from "drizzle-orm";
import type { Ctx } from "@/server/ctx";
import { env } from "@/server/env";
import { validationFailed } from "@/server/errors";
import * as s from "@/server/db/schema";
import { newId } from "@/server/db/ids";

const CONFIRM_MINUTES = 10;
const UNDO_HOURS = 24;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
function sign(payload: object) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", env.SESSION_SECRET).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}
function verify<T extends { exp: number }>(token: string): T | null {
  const [encoded, supplied] = token.split(".");
  if (!encoded || !supplied) return null;
  const expected = createHmac("sha256", env.SESSION_SECRET).update(encoded).digest();
  const actual = Buffer.from(supplied, "base64url");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as T;
  return payload.exp >= Date.now() ? payload : null;
}

export interface ConfirmationPlan { action: string; records: Array<{ type: string; id?: string; label: string }>; changes: Record<string, unknown>; }
export async function confirmation(ctx: Ctx, action: string, input: unknown, plan: ConfirmationPlan, token?: string): Promise<{ confirmed: true } | { confirmed: false; plan: ConfirmationPlan; confirmationToken: string }> {
  const digest = createHmac("sha256", env.SESSION_SECRET).update(canonical(input)).digest("base64url");
  if (!token) return { confirmed: false, plan, confirmationToken: sign({ kind: "confirm", jti: newId(), actor: ctx.actor.userId, action, digest, exp: Date.now() + CONFIRM_MINUTES * 60_000 }) };
  const value = verify<{ kind: string; jti: string; actor: string; action: string; digest: string; exp: number }>(token);
  if (!value || value.kind !== "confirm" || value.actor !== ctx.actor.userId || value.action !== action || value.digest !== digest) {
    throw validationFailed({ confirmationToken: ["The confirmation is invalid, expired, or belongs to a different plan."] });
  }
  const [claimed] = await ctx.db.insert(s.mcpConfirmationClaims).values({ id: value.jti, actorId: ctx.actor.userId }).onConflictDoNothing().returning({ id: s.mcpConfirmationClaims.id });
  if (!claimed) throw validationFailed({ confirmationToken: ["That confirmation has already been used."] });
  return { confirmed: true };
}

export function undoToken(ctx: Ctx) {
  return sign({ kind: "undo", actor: ctx.actor.userId, requestId: ctx.request.requestId, exp: Date.now() + UNDO_HOURS * 3_600_000 });
}

export async function auditForUndo(ctx: Ctx, token: string) {
  const value = verify<{ kind: string; actor: string; requestId: string; exp: number }>(token);
  if (!value || value.kind !== "undo" || value.actor !== ctx.actor.userId) throw validationFailed({ undoToken: ["That undo token is invalid or expired."] });
  const rows = await ctx.db.select().from(s.auditLog).where(and(eq(s.auditLog.actorId, ctx.actor.userId), eq(s.auditLog.actorKind, "api"), eq(s.auditLog.requestId, value.requestId), gte(s.auditLog.createdAt, new Date(Date.now() - UNDO_HOURS * 3_600_000)))).orderBy(desc(s.auditLog.id)).limit(2);
  if (rows.length > 1) throw validationFailed({ undoToken: ["That request changed multiple records and cannot be safely undone automatically."] });
  const [row] = rows;
  if (!row) throw validationFailed({ undoToken: ["That change is no longer eligible for undo."] });
  if (row.entityId) {
    const tables: Record<string, { id: any; updatedAt: any }> = {
      time_entry: s.timeEntries, client: s.clients, project: s.projects, user: s.users,
      task: s.tasks, expense_category: s.expenseCategories,
    };
    const table = tables[row.entityType];
    if (table) {
      const [current] = await ctx.db.select({ updatedAt: table.updatedAt }).from(table as any).where(eq(table.id, row.entityId)).limit(1);
      if (current?.updatedAt && current.updatedAt.getTime() > row.createdAt.getTime()) {
        throw validationFailed({ undoToken: ["That record changed after this operation. Re-read it before making another change."] });
      }
    }
  }
  return row;
}

export async function checkpointDiff(ctx: Ctx, since: Date, limit: number) {
  return ctx.db.select({ action: s.auditLog.action, entityType: s.auditLog.entityType, entityId: s.auditLog.entityId, entityLabel: s.auditLog.entityLabel, before: s.auditLog.before, after: s.auditLog.after, createdAt: s.auditLog.createdAt, tokenPrefix: s.auditLog.tokenPrefix }).from(s.auditLog).where(and(eq(s.auditLog.actorId, ctx.actor.userId), eq(s.auditLog.actorKind, "api"), gte(s.auditLog.createdAt, since))).orderBy(desc(s.auditLog.createdAt)).limit(Math.min(limit, 200));
}
