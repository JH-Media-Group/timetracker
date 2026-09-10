"use client";

/**
 * Asking for a password reset link.
 *
 * `POST /api/v1/auth/forgot` has existed, complete and careful, since auth was
 * built: identical bodies for known and unknown addresses, a response floor so
 * the two take the same time, and a per-address throttle in the service. It had
 * no caller. Nobody could ask for a reset link, so the only way back into an
 * account was to find an administrator and have them send one, and with Google
 * SSO unconfigured a password is the only way in.
 *
 * Raw `fetch` rather than `src/lib/api.ts`, like the two screens either side of
 * it. The client seam carries the signed-in envelope and a global 401 redirect,
 * both wrong on a page whose whole purpose is to run before there is a session.
 *
 * THE CONFIRMATION IS THE SAME WHATEVER HAPPENED
 *
 * The server is at pains not to say whether an address has an account, down to
 * padding the response time, because knowing who works somewhere is most of the
 * work of choosing a phishing target. It would be undone here by a screen that
 * said "no such account", so this shows one message for every outcome except a
 * rate limit, which says nothing about whether an account exists and is worth
 * telling somebody about so they know to wait.
 */

import * as React from "react";
import Link from "next/link";
import { Button, Field, Input } from "@/components/ui/primitives";
import { Logo } from "@/components/app/logo";

/** Shown whether or not the address is known. See the note above. */
const SENT =
  "If that address has an account, a reset link is on its way. It is good for a short time, so use it soon.";

export default function ForgotPasswordPage() {
  const [email, setEmail] = React.useState("");
  const [sent, setSent] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/v1/auth/forgot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });

      /*
        Two answers are safe to show, and the route says why: a rate limit and a
        malformed address both tell you nothing about whether an account exists.
        Everything else lands on the one confirmation.

        Worth showing rather than swallowing. The browser's own email check is
        lenient enough to pass something the server then rejects, and a person
        who typo'd their address would otherwise sit waiting for a link that was
        never sent.
      */
      if (response.status === 429 || response.status === 422) {
        const problem = await response.json().catch(() => null);
        const field = problem?.errors?.email?.[0];
        setError(
          field ?? problem?.detail ?? "That did not work. Check the address and try again."
        );
        return;
      }

      setSent(true);
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
          <h1 className="text-lg font-semibold text-ink">Reset your password</h1>

          {sent ? (
            <>
              <p className="mt-2 text-base text-ink-secondary" role="status">
                {SENT}
              </p>
              <p className="mt-4 text-base text-ink-secondary">
                Nothing arrived? Check the spam folder, then ask an administrator to send one.
              </p>
            </>
          ) : (
            <>
              <p className="mt-1 text-base text-ink-secondary">
                Enter the address you sign in with and we will send you a link.
              </p>

              <form onSubmit={submit} className="mt-5 flex flex-col gap-4">
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

                {error && (
                  <p role="alert" className="text-base text-danger">
                    {error}
                  </p>
                )}

                <Button type="submit" variant="primary" className="w-full" loading={busy} disabled={busy}>
                  Send the link
                </Button>
              </form>
            </>
          )}
        </div>

        <p className="mt-4 text-center text-sm text-ink-tertiary">
          <Link href="/signin" className="text-link underline">
            Back to sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
