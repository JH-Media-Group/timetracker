"use client";

/**
 * Sign in.
 *
 * Deliberately plain. This is the one screen where nothing should be
 * interesting: a person who cannot get in is already frustrated, and a clever
 * layout does not help them.
 *
 * Google Workspace is the intended route for staff and appears when the
 * credentials are configured. Email and password exists for contractors.
 */

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button, Field, Input } from "@/components/ui/primitives";
import { Logo } from "@/components/app/logo";

/**
 * Where to land after signing in.
 *
 * Only a path on this site. `?next=` arrives from the middleware, but it also
 * arrives from whatever anybody puts in a link, and an unchecked value here is
 * an open redirect: a phishing page can send somebody to a real Tally sign-in
 * and take them somewhere else the moment they succeed, with the credentials
 * having been typed into the genuine article.
 *
 * A protocol-relative `//evil.example` is a URL to another host that looks like
 * a path, so a leading-slash test alone is not enough.
 */
function safeNext(value: string | null): string {
  if (!value) return "/timesheet";
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/timesheet";
  return value;
}

export default function SignInPage() {
  const router = useRouter();
  const search = useSearchParams();
  const next = safeNext(search.get("next"));

  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [googleReady, setGoogleReady] = React.useState(false);

  React.useEffect(() => {
    // The button only appears when the server says the credentials exist.
    // Showing a Google button that leads to a configuration error is worse than
    // not showing one.
    fetch("/api/v1/auth/providers")
      .then((r) => (r.ok ? r.json() : null))
      .then((r) => setGoogleReady(Boolean(r?.data?.google)))
      .catch(() => setGoogleReady(false));
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/v1/auth/signin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!response.ok) {
        const problem = await response.json().catch(() => null);
        setError(problem?.detail ?? "That did not work. Try again.");
        return;
      }
      // A full navigation, not a client push: the shell needs to boot with the
      // session cookie in place.
      window.location.href = next;
    } catch {
      setError("Could not reach the server. Check your connection.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-bg px-6 py-12">
      <div className="w-full max-w-[380px]">
        <div className="mb-8 flex justify-center">
          <Logo height={30} />
        </div>

        <div className="rounded-lg border border-border bg-surface p-6 shadow-sm">
          <h1 className="text-lg font-semibold text-ink">Sign in to Tally</h1>
          <p className="mt-1 text-base text-ink-secondary">
            Time tracking, profitability, and invoicing for JH Media Group.
          </p>

          {googleReady && (
            <>
              <a
                href={`/api/v1/auth/google?next=${encodeURIComponent(next)}`}
                className="mt-5 flex h-9 w-full items-center justify-center gap-2 rounded-md border border-border bg-surface text-base font-medium text-ink hover:bg-surface-hover"
              >
                Continue with Google
              </a>
              <div className="my-5 flex items-center gap-3 text-sm text-ink-tertiary">
                <span className="h-px flex-1 bg-border" />
                or
                <span className="h-px flex-1 bg-border" />
              </div>
            </>
          )}

          <form onSubmit={submit} className={googleReady ? "flex flex-col gap-4" : "mt-5 flex flex-col gap-4"}>
            <Field label="Email">
              <Input
                type="email"
                autoComplete="username"
                required
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@jhmediagroup.com"
              />
            </Field>

            <Field label="Password">
              <Input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>

            {error && (
              <p role="alert" className="text-base text-danger">
                {error}
              </p>
            )}

            <Button type="submit" variant="primary" className="w-full" loading={busy} disabled={busy}>
              Sign in
            </Button>
          </form>
        </div>

        <p className="mt-4 text-center text-sm text-ink-tertiary">
          Accounts are created by invitation. Ask an administrator if you need one.
        </p>
      </div>
    </main>
  );
}
