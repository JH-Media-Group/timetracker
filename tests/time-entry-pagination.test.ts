import { afterEach, describe, expect, it, vi } from "vitest";
import { listAllTimeEntries, listTimeEntries } from "@/lib/api";

afterEach(() => vi.unstubAllGlobals());

const entry = (id: string) => ({
  id, userId: "person", projectId: "project", taskId: "task", spentOn: "2026-10-01",
  durationSeconds: 60, isBillable: true, billableRateCents: 10500,
});
const response = (data: ReturnType<typeof entry>[], meta: Record<string, unknown>) =>
  new Response(JSON.stringify({ data, meta }), { headers: { "Content-Type": "application/json" } });

describe("complete time entry lists", () => {
  it("includes entries beyond 5,000 and keeps every filter on the next page", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(Array.from({ length: 5000 }, (_, i) => entry(String(i))), { hasMore: true, nextCursor: "NTAwMA" }))
      .mockResolvedValueOnce(response([entry("5000")], { hasMore: false, nextCursor: null }));
    vi.stubGlobal("fetch", fetch);
    const rows = await listAllTimeEntries({ from: "2026-09-14", to: "2026-10-03", taskId: "task", userId: "person", projectId: "project", clientId: "client" });
    expect(rows).toHaveLength(5001);
    expect(rows.reduce((sum, row) => sum + row.durationSeconds, 0)).toBe(5001 * 60);
    const first = new URL(fetch.mock.calls[0]![0], "http://localhost");
    const second = new URL(fetch.mock.calls[1]![0], "http://localhost");
    expect(second.searchParams.get("cursor")).toBe("NTAwMA");
    second.searchParams.delete("cursor");
    expect(second.searchParams.toString()).toBe(first.searchParams.toString());
  });

  it("rejects a later failed page instead of returning a partial success", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(response([entry("1")], { hasMore: true, nextCursor: "MQ" }))
      .mockRejectedValueOnce(new Error("offline")));
    await expect(listAllTimeEntries()).rejects.toThrow(/Could not reach the server/);
  });

  it.each([null, "", "MQ"])("refuses a missing or repeated pagination cursor: %s", async (nextCursor) => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(response([entry("1")], { hasMore: true, nextCursor: "MQ" }))
      .mockResolvedValueOnce(response([entry("2")], { hasMore: true, nextCursor })));
    await expect(listAllTimeEntries()).rejects.toThrow(/every time entry/);
  });

  it("rejects duplicated entries if concurrent changes shift a page", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(response([entry("1")], { hasMore: true, nextCursor: "MQ" }))
      .mockResolvedValueOnce(response([entry("1")], { hasMore: false })));
    await expect(listAllTimeEntries()).rejects.toThrow(/changed while loading/);
  });

  it("does not make unrelated list pages fetch the full history", async () => {
    const fetch = vi.fn().mockResolvedValue(response([entry("1")], { hasMore: true, nextCursor: "MQ" }));
    vi.stubGlobal("fetch", fetch);
    await listTimeEntries();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
