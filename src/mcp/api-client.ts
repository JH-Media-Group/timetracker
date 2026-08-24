import { createHash } from "node:crypto";

export interface ApiProblem { title?: string; status?: number; detail?: string; code?: string; fieldErrors?: Record<string, string[]>; retryAfter?: number; }
export class TallyApiError extends Error {
  constructor(readonly status: number, readonly problem: ApiProblem) { super(problem.detail ?? problem.title ?? `Tally API returned ${status}`); }
}
type QueryValue = string | number | boolean | null | undefined;
const MAX_CACHE_ENTRIES = 1024, CACHE_TTL_MS = 60_000, MAX_CACHE_BODY_BYTES = 256_000;
const etags = new Map<string, { etag: string; value: unknown; expiresAt: number }>();
function cached(key: string) {
  const value = etags.get(key);
  if (!value || value.expiresAt <= Date.now()) { etags.delete(key); return undefined; }
  etags.delete(key); etags.set(key, value);
  return value;
}
function remember(key: string, etag: string, value: unknown) {
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_CACHE_BODY_BYTES) return;
  etags.set(key, { etag, value, expiresAt: Date.now() + CACHE_TTL_MS });
  while (etags.size > MAX_CACHE_ENTRIES) etags.delete(etags.keys().next().value!);
}
export function mcpCacheSize() { return etags.size; }

export class TallyApi {
  private readonly fingerprint: string;
  constructor(private readonly baseUrl: string, private readonly bearer: string) {
    this.fingerprint = createHash("sha256").update(bearer).digest("hex");
  }
  async get<T>(path: string, query: Record<string, QueryValue> = {}): Promise<{ data: T; meta?: Record<string, unknown> }> {
    const url = this.url(path, query), cacheKey = `${this.fingerprint}:${url}`, prior = cached(cacheKey);
    const response = await fetch(url, { headers: this.headers(prior?.etag) });
    if (response.status === 304 && prior) return prior.value as { data: T; meta?: Record<string, unknown> };
    const value = await this.read<T>(response), etag = response.headers.get("etag");
    if (etag) remember(cacheKey, etag, value);
    return value;
  }
  post<T>(path: string, body?: unknown, key?: string) { return this.write<T>("POST", path, body, key); }
  patch<T>(path: string, body?: unknown, key?: string) { return this.write<T>("PATCH", path, body, key); }
  delete<T>(path: string, key?: string) { return this.write<T>("DELETE", path, undefined, key); }
  private async write<T>(method: string, path: string, body?: unknown, key?: string) {
    const headers = this.headers(); headers.set("content-type", "application/json"); if (key) headers.set("idempotency-key", key);
    return this.read<T>(await fetch(this.url(path), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
  }
  private headers(etag?: string) { const h = new Headers({ authorization: `Bearer ${this.bearer}`, accept: "application/json" }); if (etag) h.set("if-none-match", etag); return h; }
  private url(path: string, query: Record<string, QueryValue> = {}) { const u = new URL(`/api/v1${path.startsWith("/") ? path : `/${path}`}`, this.baseUrl); for (const [k,v] of Object.entries(query)) if (v !== undefined && v !== null) u.searchParams.set(k, String(v)); return u.toString(); }
  private async read<T>(response: Response): Promise<{ data: T; meta?: Record<string, unknown> }> { const payload = await response.json().catch(() => ({})); if (!response.ok) { const retry = response.headers.get("retry-after"); throw new TallyApiError(response.status, { ...(payload as ApiProblem), retryAfter: retry ? Number(retry) : undefined }); } return payload as { data: T; meta?: Record<string, unknown> }; }
}
