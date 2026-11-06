"use client";
import * as React from "react";
import { Button, Card } from "@/components/ui/primitives";
import { SectionTitle } from "@/components/app/kpi";
import { useToast } from "@/components/ui/toast";

export function McpConnectionCard() {
  const [url, setUrl] = React.useState("");
  const toast = useToast();
  React.useEffect(() => { setUrl(`${window.location.origin}/mcp`); }, []);
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); toast.push({ tone: "default", title: "Connection URL copied." }); }
    catch { toast.push({ tone: "danger", title: "Could not copy. Select the URL and copy it manually." }); }
  };
  return <Card>
    <SectionTitle>Connect Claude or Codex</SectionTitle>
    <p className="mb-3 text-base text-ink-secondary">Add this URL in your client's MCP connection settings, sign in to Tally, and approve the access it requests. You do not need to create a personal token.</p>
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <code className="min-w-0 flex-1 break-all rounded bg-surface-secondary px-2 py-1 text-sm">{url || "Loading connection URL..."}</code>
      <Button variant="ghost" size="sm" disabled={!url} onClick={copy}>Copy URL</Button>
    </div>
    <div className="space-y-3 text-sm text-ink-secondary">
      <details><summary className="cursor-pointer font-medium text-ink-primary">Claude Desktop</summary>
        <p className="mt-2">Open Connectors in Claude's settings and add a custom remote connector using the URL above. Connect it, sign in to Tally, and review the permissions. Custom connectors must be available for your account and allowed by your organization.</p>
      </details>
      <details><summary className="cursor-pointer font-medium text-ink-primary">Claude Code</summary>
        <code className="mt-2 block break-all rounded bg-surface-secondary px-2 py-1">claude mcp add --transport http tally {url}</code>
        <p className="mt-2">Then open /mcp in an interactive Claude Code session, select Tally, and authenticate in your browser.</p>
      </details>
      <details><summary className="cursor-pointer font-medium text-ink-primary">Codex desktop or IDE</summary>
        <p className="mt-2">Open MCP servers in Settings, add a Streamable HTTP server named Tally with the URL above, and select Authenticate. Restart the connection if prompted.</p>
      </details>
      <details><summary className="cursor-pointer font-medium text-ink-primary">Codex CLI</summary>
        <code className="mt-2 block break-all rounded bg-surface-secondary px-2 py-1">codex mcp add tally --url {url}</code>
        <code className="mt-2 block break-all rounded bg-surface-secondary px-2 py-1">codex mcp login tally</code>
        <p className="mt-2">To request time entry access too, reconnect with <code className="break-all">codex mcp login tally --scopes tally.read,tally.time.write</code> and review the new consent.</p>
      </details>
      <p>Start by asking for your projects or current timer. To start timers or log time, select Log time on the consent screen. Additional actions need the corresponding permissions in Tally and access you approve during consent.</p>
      <details><summary className="cursor-pointer font-medium text-ink-primary">Connection help</summary>
        <p className="mt-2">Connections expire after 90 days. Authenticate again after expiry or revocation. If you previously supplied an Authorization header, remove it from that Tally connection before switching to browser sign-in. Declining consent leaves the client disconnected.</p>
        <p className="mt-2">For a rate-limit error, wait for the indicated retry time. For an unavailable server, try again later. Repeated sign-ins will not fix either error. Adding the URL in an ordinary chat does not install a connector.</p>
      </details>
    </div>
  </Card>;
}
