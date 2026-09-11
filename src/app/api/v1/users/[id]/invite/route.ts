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

export const POST = route(
  async (ctx, req, params) => {
    /*
      Capped before parsing. Reading the body by hand also means losing
      whatever the shared helper would have done about size, and this body is
      two booleans: anything past a few hundred bytes is a mistake or a game.
      An authenticated insider is the only one who can reach it, so this is
      tidiness rather than defence, but buffering an arbitrary body and then
      copying it with `.trim()` is a silly thing to leave available.
    */
    const declared = Number(req.headers.get("content-length") ?? "0");
    if (declared > 4096) {
      throw validationFailed({ _: ["That request body is far larger than this endpoint accepts."] });
    }

    const raw = (await req.text()).trim();
    if (raw.length > 4096) {
      throw validationFailed({ _: ["That request body is far larger than this endpoint accepts."] });
    }
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
