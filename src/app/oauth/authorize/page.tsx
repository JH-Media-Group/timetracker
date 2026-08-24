"use client";
import * as React from "react";
import { useSearchParams } from "next/navigation";
import { Button, Card, Spinner } from "@/components/ui/primitives";
import { SCOPE_LABELS } from "@/lib/api-token-scopes";

const labels = Object.fromEntries(Object.entries(SCOPE_LABELS).map(([scope, value]) => [scope, value.description])) as Record<string, string>;
export default function OAuthAuthorizePage() {
  const params = useSearchParams(); const [request, setRequest] = React.useState<{ clientName: string; scopes: string[] } | null>(null); const [error, setError] = React.useState<string | null>(null); const [busy, setBusy] = React.useState(false);
  const q = { client_id: params.get("client_id") ?? "", redirect_uri: params.get("redirect_uri") ?? "", scope: params.get("scope") ?? "", code_challenge: params.get("code_challenge") ?? "", code_challenge_method: params.get("code_challenge_method") ?? "", state: params.get("state") ?? undefined };
  React.useEffect(() => { const search = new URLSearchParams(Object.entries(q).filter(([,v]) => v != null) as [string,string][]); fetch(`/api/v1/oauth/request?${search}`).then(async (r) => { const value = await r.json(); if (!r.ok) throw new Error(value.detail ?? "Invalid authorization request"); setRequest(value.data); }).catch((e) => setError(e.message)); }, []);
  const decide = async (approved: boolean) => { setBusy(true); try { const response = await fetch("/api/v1/oauth/authorize", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: q.client_id, redirectUri: q.redirect_uri, scope: q.scope, codeChallenge: q.code_challenge, state: q.state, approved }) }); const value = await response.json(); if (!response.ok) throw new Error(value.detail ?? "Authorization failed"); window.location.assign(value.data.redirectTo); } catch (e) { setError(e instanceof Error ? e.message : "Authorization failed"); setBusy(false); } };
  return <main className="mx-auto flex min-h-screen max-w-[560px] items-center p-5"><Card className="w-full"><h1 className="text-xl font-semibold text-ink-primary">Connect to Tally</h1>{error && <p className="mt-3 text-sm text-danger">{error}</p>}{!request && !error && <Spinner className="mt-4 size-4" />}{request && <><p className="mt-2 text-ink-secondary"><strong>{request.clientName}</strong> is asking to:</p><ul className="my-4 list-disc space-y-2 pl-5 text-sm text-ink-secondary">{request.scopes.map((scope) => <li key={scope}>{labels[scope]}</li>)}</ul><div className="flex justify-end gap-2"><Button variant="ghost" disabled={busy} onClick={() => decide(false)}>Decline</Button><Button loading={busy} onClick={() => decide(true)}>Allow</Button></div></>}</Card></main>;
}
