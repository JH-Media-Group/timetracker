"use client";

/**
 * The form half of the set-password page.
 *
 * Plain, for the same reason the sign-in screen is: somebody who cannot get in
 * is already frustrated.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button, Field, Input } from "@/components/ui/primitives";
import { Logo } from "@/components/app/logo";
import type { TokenSubject } from "@/server/services/auth-tokens";

export function SetPasswordForm({ subject }: { subject: TokenSubject | null }) {
  const router = useRouter();

  /*
    The token comes from the address bar, not from a prop.

    Passing it down from the server component serialised it into the RSC
    payload, putting the credential in the response body as well as the URL.
    Reading it here keeps it in the one place it already had to be, and the
    effect below then removes it from the address bar so it does not sit in the
    history entry or get handed to anything through a Referer.
  */
  const [token, setToken] = React.useState("");

  React.useEffect(() => {
    const url = new URL(window.location.href);
    const value = url.searchParams.get("token") ?? "";
    setToken(value);

    if (value) {
      url.searchParams.delete("token");
      window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    }
  }, []);
  const [password, setPassword] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [done, setDone] = React.useState(false);

  const invite = subject?.purpose === "invite";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    // Checked here as well as on the server, because retyping a long password
    // only to be told the two did not match is a miserable way to find out.
    if (password !== confirm) {
      setError("Those two passwords are not the same.");
      return;
    }

    setBusy(true);
    try {
      const res = await fetch("/api/v1/auth/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      if (!res.ok) {
        const problem = (await res.json().catch(() => ({}))) as { detail?: string };
        throw new Error(problem.detail ?? "That did not work. Ask for a new link.");
      }
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-6 px-6">
      <Logo />

      {!subject ? (
        <div className="space-y-2">
          <h1 className="text-xl font-semibold text-ink">That link does not work</h1>
          <p className="text-md text-ink-secondary">
            It has expired, or it has already been used. Both links are good once only. Ask for
            another from the sign-in page, or ask whoever invited you to send a new one.
          </p>
          <Button variant="secondary" onClick={() => router.push("/signin")}>
            Back to sign in
          </Button>
        </div>
      ) : done ? (
        <div className="space-y-2">
          <h1 className="text-xl font-semibold text-ink">Password set</h1>
          {/*
            Not signed in automatically. Using the new password once, while they
            are still paying attention, is how somebody finds out it works.
          */}
          <p className="text-md text-ink-secondary">Sign in with it to make sure it works.</p>
          <Button onClick={() => router.push("/signin")}>Sign in</Button>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1">
            <h1 className="text-xl font-semibold text-ink">
              {invite ? "Welcome to Tally" : "Choose a new password"}
            </h1>
            <p className="text-md text-ink-secondary">
              {invite ? "Choose a password for " : "For "}
              <span className="font-medium text-ink">{subject.email}</span>
            </p>
          </div>

          <Field label="New password">
            <Input
              type="password"
              autoComplete="new-password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>

          <Field label="Again, to be sure">
            <Input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </Field>

          {error && <p className="text-md text-danger">{error}</p>}

          <Button type="submit" disabled={busy || !password || !token} className="w-full">
            {busy ? "Saving" : "Set password"}
          </Button>
        </form>
      )}
    </main>
  );
}
