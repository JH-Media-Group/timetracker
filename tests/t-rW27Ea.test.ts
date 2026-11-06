import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, s, closeDb } from "./helpers";
import { timeEditFixture } from "./support/time-edit-fixture";
import { editedTimeEntryNotes } from "@/lib/time-entry-notes";
import { getTimeEntry, updateTimeEntry } from "@/server/services/time";
import { invalidateSettings } from "@/server/services/settings";
import * as api from "@/lib/api";
import { mcpTimeEdit, mcpUndo } from "@/server/services/mcp-actions";
import { createCtx } from "@/server/ctx";

let f: Awaited<ReturnType<typeof timeEditFixture>>;
beforeEach(async () => { f = await timeEditFixture(); });
afterAll(closeDb);
afterEach(() => vi.unstubAllGlobals());

describe("t-rW27Ea note clearing", () => {
  it("sends an explicit clear through JSON and reloads the cleared note without changing historical rates", async () => {
    const existing = await getTimeEntry(f.member, f.id);
    const transport = vi.fn(async (_url: unknown, init: RequestInit) => {
      const patch = JSON.parse(String(init.body));
      expect(patch).toEqual({ notes: "" });
      return Response.json({ data: await updateTimeEntry(f.member, f.id, patch) });
    });
    vi.stubGlobal("fetch", transport);
    await api.updateTimeEntry(f.id, { notes: editedTimeEntryNotes("  ", existing) });
    expect(transport).toHaveBeenCalledOnce();
    expect(await getTimeEntry(f.member, f.id)).toMatchObject({ notes: null, billableRateCents: 12000 });
    expect(editedTimeEntryNotes("Original note ", existing)).toBeUndefined();
  });

  it.each([null, "", "  "])("undoes an MCP duration edit with legacy blank note %s under a newer note policy", async (notes) => {
    await db.update(s.timeEntries).set({ notes }).where(eq(s.timeEntries.id, f.id));
    await db.update(s.settings).set({ requireNotes: "always" }); invalidateSettings();
    const ctx = createCtx({ actor: { ...f.member.actor, kind: "api" }, now: () => new Date() });
    const edited = await mcpTimeEdit(ctx, f.id, { durationSeconds: 7200 });
    expect(edited).toHaveProperty("undoToken");
    await mcpUndo(createCtx({ actor: ctx.actor }), (edited as { undoToken: string }).undoToken);
    expect(await getTimeEntry(f.member, f.id)).toMatchObject({ notes: null, durationSeconds: 3600 });
  });

  it.each(["always", "non_billable"] as const)("preserves %s note requirements and rolls back the entire edit", async (requireNotes) => {
    await db.update(s.settings).set({ requireNotes }); invalidateSettings();
    await expect(updateTimeEntry(f.member, f.id, { notes: "", isBillable: false, durationSeconds: 7200 })).rejects.toMatchObject({ code: "validation_failed" });
    expect(await getTimeEntry(f.member, f.id)).toMatchObject({ notes: "Original note", durationSeconds: 3600, isBillable: true, billableRateCents: 12000 });
  });

  it("allows clearing billable notes when only non-billable notes are required", async () => {
    await db.update(s.settings).set({ requireNotes: "non_billable" }); invalidateSettings();
    await updateTimeEntry(f.member, f.id, { notes: "" });
    expect((await getTimeEntry(f.member, f.id)).notes).toBeNull();
  });
});
