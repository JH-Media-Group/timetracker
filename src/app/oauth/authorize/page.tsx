"use client";
import * as React from "react";
import { useSearchParams } from "next/navigation";
import { Button, Card, Checkbox, Spinner } from "@/components/ui/primitives";
import { SCOPE_LABELS, TOKEN_SCOPES } from "@/lib/api-token-scopes";

type ConsentRequest = { clientName: string; redirectUri: string; scopes: string[]; userId: string; email: string; search: string };
const labels = Object.fromEntries(Object.entries(SCOPE_LABELS).map(([scope, value]) => [scope, value.description]));

export default function OAuthAuthorizePage() {
  const params = useSearchParams();
  const search = params.toString();
  const [request, setRequest] = React.useState<ConsentRequest | null>(null);
  const [selectedScopes, setSelectedScopes] = React.useState<string[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const returnTo = `/oauth/authorize?${search}`;
  const signin = () => window.location.assign(`/signin?next=${encodeURIComponent(returnTo)}`);

  React.useEffect(() => {
    const controller = new AbortController();
    setRequest(null); setError(null);
    fetch(`/api/v1/oauth/request?${search}`, { signal: controller.signal }).then(async (response) => {
      if (response.status === 401) {
        window.location.assign(`/signin?next=${encodeURIComponent(`/oauth/authorize?${search}`)}`);
        return;
      }
      const value = await response.json();
      if (!response.ok) throw new Error(value.detail ?? value.error_description ?? "Invalid authorization request. Restart the connection in your client.");
      if (controller.signal.aborted) return;
      setRequest({ ...value.data, search });
      setSelectedScopes(value.data.scopes.filter((scope: string) => scope === "tally.read"));
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Could not load this request.");
    });
    return () => controller.abort();
  }, [search]);

  const decide = async (approved: boolean) => {
    if (!request || request.search !== search) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/v1/oauth/authorize", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientId: params.get("client_id"), redirectUri: params.get("redirect_uri"),
          scope: params.get("scope") ?? "tally.read", codeChallenge: params.get("code_challenge"),
          codeChallengeMethod: params.get("code_challenge_method"), responseType: params.get("response_type"),
          resource: params.get("resource") ?? undefined, state: params.get("state") ?? undefined,
          expectedUserId: request.userId, approved, selectedScopes,
        }),
      });
      if (response.status === 401) { signin(); return; }
      const value = await response.json();
      if (!response.ok) throw new Error(value.detail ?? value.error_description ?? "Authorization failed. Restart the connection in your client.");
      window.location.assign(value.data.redirectTo);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Authorization failed.");
      setBusy(false);
    }
  };

  return <main className="mx-auto flex min-h-screen max-w-xl items-center p-5">
    <Card className="w-full">
      <h1 className="text-xl font-semibold text-ink-primary">Connect to Tally</h1>
      {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
      {!request && !error && <Spinner className="mt-4 size-4" />}
      {request && request.search === search && <>
        <p className="mt-2 text-sm text-ink-secondary">Signed in as {request.email}</p>
        <p className="mt-2 text-ink-secondary"><strong>{request.clientName}</strong> is asking to:</p>
        <p className="mt-3 break-all font-semibold text-ink-primary">Return to: {new URL(request.redirectUri).host}</p>
        <p className="mt-2 break-all text-sm text-ink-secondary">This name is supplied by the app and is not verified by Tally. Access will return to <strong>{request.redirectUri}</strong>. Check that this is the app you intended to connect.</p>
        <div className="my-4 space-y-3">
          {TOKEN_SCOPES.map((scope) => <label key={scope} className="flex items-start gap-2 text-sm text-ink-secondary">
            <Checkbox checked={selectedScopes.includes(scope)} disabled={busy}
              onCheckedChange={(checked) => setSelectedScopes((current) => checked ? [...new Set([...current, scope])] : current.filter((item) => item !== scope))} />
            <span><strong className="text-ink-primary">{SCOPE_LABELS[scope].title}</strong>{request.scopes.includes(scope) ? " (requested)" : " (optional additional access)"}<br />{labels[scope]}</span>
          </label>)}
        </div>
        <p className="mb-4 text-sm text-ink-secondary">Access stays within your Tally permissions. It expires after 90 days. Reconnect to renew it, or revoke this connection in Settings at any time. Only approve a connection you started.</p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={() => decide(false)}>Decline</Button>
          <Button disabled={!selectedScopes.length} loading={busy} onClick={() => decide(true)}>Allow</Button>
        </div>
      </>}
    </Card>
  </main>;
}
