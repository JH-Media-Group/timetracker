/**
 * Choose a password, from an invite or a reset link.
 *
 * A server component on purpose. The token arrives in the query string and is
 * resolved here, so the page can say whose account it is before anybody types,
 * and an expired or spent link says so immediately rather than after a failed
 * submit. It also means no extra public endpoint exists just to look a token up.
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

  return <SetPasswordForm token={token} subject={subject} />;
}
