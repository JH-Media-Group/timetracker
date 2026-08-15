/**
 * How long each kind of auth token is good for.
 *
 * Its own module because two places need it and importing one from the other
 * would be a cycle: `auth-tokens` mints the tokens and queues the mail that
 * carries them, and `mail` needs to know when a queued message has outlived the
 * credential inside it. A copy in each would be two numbers that agree until
 * somebody changes one.
 */

export type TokenPurpose = "invite" | "password_reset";

/**
 * An invite can reasonably sit in an inbox over a weekend. A reset should not:
 * it is a live credential for whoever reads that mailbox, and the person asking
 * for it is waiting at the screen.
 */
export const TOKEN_TTL_MS: Record<TokenPurpose, number> = {
  invite: 7 * 24 * 60 * 60 * 1000,
  password_reset: 60 * 60 * 1000,
};
