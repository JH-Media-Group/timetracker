/**
 * POST /api/v1/users/:id/invite
 *
 * Send somebody a link to choose their password. With Google SSO dropped in
 * favour of password-only, this is how an account becomes usable at all.
 *
 * The body picks how the invite reaches them: queued to their address, handed
 * back as a one-time link for the inviter to pass on, or both. Both is one
 * token, because issuing a second would kill the first and whichever the person
 * actually used would be the dead one. See `inviteUser`.
 *
 * A body that asks for neither is refused rather than treated as a default.
 * Guessing there would mean a request that meant nothing quietly minting a
 * token and superseding a live invite somebody is already holding.
 *
 * The `email` rate-limit class rather than `write`, because the cost of abusing
 * it is somebody else's inbox and this domain's sending reputation, not our CPU.
 * That still applies to a link-only request: the expensive part is minting
 * credentials for other people's accounts, whichever way they travel.
 */

import { z } from "zod";
import { parseOrThrow, route } from "@/server/http";
import { validationFailed } from "@/server/errors";
import { inviteUser } from "@/server/services/auth-tokens";

/**
 * An absent body means email only, which is what this endpoint did before it
 * could do anything else, so anything already calling it behaves as it did.
 *
 * Deliberately not `body(req, schema).catch(default)`: that swallows a real
 * validation failure alongside an absent body, so `{"email": "yes"}` would
 * quietly become email-only instead of being refused. Only genuinely empty
 * input gets the default; anything present is validated and can fail.
 */
const schema = z.object({
  email: z.boolean().optional(),
  link: z.boolean().optional(),
});

/**
 * The body as text, refusing anything over `limit` bytes without buffering it.
 *
 * Stops reading at the first chunk that takes the total past the limit, so an
 * oversized body costs one chunk rather than all of it. Returns the trimmed
 * text, because an empty body and a body of whitespace mean the same thing
 * here.
 */
async function readCapped(req: Request, limit: number): Promise<string> {
  const tooBig = () =>
    validationFailed({ _: ["That request body is far larger than this endpoint accepts."] });

  // A declared length over the limit is refused without reading anything, but
  // its absence proves nothing and the stream is counted regardless.
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw tooBig();

  // No body at all, which is the legacy call and means email only.
  if (!req.body) return "";

  /*
    If something upstream already consumed the body, fall back rather than
    throwing `TypeError: locked` and turning a 422 into a 500. The wrapper's
    idempotency peek reads a clone, which leaves this readable, but that is a
    property of another file and this should not break if it changes.
  */
  if (req.bodyUsed || req.body.locked) return (await req.text()).trim();

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let over = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        over = true;
        break;
      }
      chunks.push(value);
    }
  } finally {
    /*
      Cancel rather than merely release when bailing out.

      `releaseLock` hands the stream back unread, which is what leaves an
      oversized body half-consumed on the connection with nobody able to finish
      it; a loop of those is a cheap way to pin connections. Cancelling
      discards the rest and lets the runtime close it. The earlier version
      released and claimed in a comment that this was the careful thing to do,
      which was exactly backwards.
    */
    if (over) await reader.cancel().catch(() => {});
    else reader.releaseLock();
  }

  if (over) throw tooBig();

  // Decoded once over the concatenated bytes, so a multi-byte character split
  // across two chunks is not mangled.
  return new TextDecoder().decode(Buffer.concat(chunks)).trim();
}

export const POST = route(
  async (ctx, req, params) => {
    /*
      Capped by counting bytes off the stream, not by trusting a header and not
      by measuring the string afterwards.

      The first version did both of the wrong things. A missing `Content-Length`
      defaulted to zero and passed, and the length check ran after `.trim()`, so
      a hundred kilobytes of leading whitespace followed by a valid body was
      measured as twenty-seven characters and accepted. `String.length` counts
      UTF-16 units rather than bytes as well. Reading the whole body before
      deciding whether it is too big is the part that makes a cap pointless.

      This body is two booleans. An authenticated holder of `people:manage` is
      the only one who can reach it, so this is tidiness rather than defence,
      but the tidy version should at least do what it says.
    */
    const raw = await readCapped(req, 4096);
    let parsed: unknown = {};
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Same answer the shared helper gives, rather than a 500 from a throw
        // that nothing catches.
        throw validationFailed({ _: ["The request body was not valid JSON."] });
      }
    }
    const input = raw ? parseOrThrow(schema, parsed) : { email: true, link: false };

    return inviteUser(ctx, params.id!, {
      email: input.email ?? false,
      link: input.link ?? false,
    });
  },
  { capability: "people:manage", rateLimit: "email" }
);
