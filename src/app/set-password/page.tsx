/**
 * Choose a password, from an invite or a reset link.
 *
 * A server component on purpose. The token arrives in the query string and is
 * resolved here, so the page can say whose account it is before anybody types,
 * and an expired or spent link says so immediately rather than after a failed
 * submit. It also means no extra public endpoint exists just to look a token up.
 *
 * **The token is not passed to the client component.** Doing so serialised it
 * into the RSC payload, so the credential appeared in the response body as well
 * as the URL, where anything logging or proxying response bodies would pick it
 * up. The form reads it from `window.location` instead and clears it from the
 * address bar once it has, which also keeps it out of the browser history entry
 * the person leaves behind.
 */

import { peekToken } from "@/server/services/auth-tokens";
import { SetPasswordForm } from "./form";

export const dynamic = "force-dynamic";

export default async function SetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = (await searchParams).token;
  const token = typeof raw === "string" ? raw : "";
  const subject = token ? await peekToken(token) : null;

  // Only who it is for and what kind of link it is. Never the token.
  return <SetPasswordForm subject={subject} />;
}
