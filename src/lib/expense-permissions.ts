import type { Capability } from "@/server/auth/capabilities";

/**
 * Who may change an expense, decided the same way the server decides it.
 *
 * A plain module rather than a branch inside the tray, so the rule can be
 * tested. Vitest cannot parse a `.tsx` under Next's `jsx: "preserve"`, which
 * means a rule written beside the JSX is a rule nothing can check, and this one
 * was wrong for as long as it lived there.
 *
 * The tray gated on `expense:manage` alone. The server (`loadEditable` in
 * `src/server/services/expenses.ts`) has always said something different:
 *
 *   own expense      -> expense:edit_own
 *   someone else's   -> expense:manage OR expense:edit_others
 *
 * Every profile holds `expense:edit_own`, and only four hold `expense:manage`.
 * So a Member could add an expense, and then could not edit the thing they had
 * just added, while the API would have accepted the change perfectly happily.
 * The UI was stricter than the server, in the direction that blocks the most
 * common action there is on this screen (t-ZbqtuF).
 *
 * **This mirrors only the capability half, and that is deliberate.** The lock
 * half is not recomputed here: the server sends `locked` and `lockReasons` on
 * every expense, decided by the same `canEdit` the mutation runs, and the tray
 * uses that. A first version of this file recomputed the lock as
 * `!!invoiceId`, which disagreed with the server about draft invoices and
 * reintroduced the very bug it was written to fix.
 *
 * The capability half legitimately lives on the client, because a button must
 * not appear for an action the request would refuse, and `useCan()` reads the
 * set the server computed. What keeps it honest is that the tests below build
 * their inputs from BASE_PROFILES rather than from a hand-written list, so a
 * change to what a Member holds fails here.
 *
 * What is still only prose: that these verbs match `loadEditable`'s verbs. If
 * the server ever stops accepting `expense:edit_others`, nothing here fails.
 * That is a known, accepted gap; the safe direction is that the server refuses
 * anyway and the UI merely offers something that then errors, rather than the
 * reverse.
 */
export function mayEditExpense(input: {
  /** Whether the expense belongs to the person looking at it. */
  own: boolean;
  /** On a sent invoice, or otherwise frozen. Overrides everything below. */
  locked: boolean;
  can: (capability: Capability) => boolean;
}): boolean {
  if (input.locked) return false;
  if (input.own) return input.can("expense:edit_own");
  return input.can("expense:manage") || input.can("expense:edit_others");
}

/**
 * Who may delete one. Same shape, different verbs.
 *
 * Split out rather than reusing the edit rule, because deleting somebody
 * else's expense is not the same act as correcting a typo in it, and the two
 * capabilities exist separately for that reason.
 */
export function mayDeleteExpense(input: {
  own: boolean;
  locked: boolean;
  can: (capability: Capability) => boolean;
}): boolean {
  if (input.locked) return false;
  if (input.own) return input.can("expense:delete_own");
  return input.can("expense:manage") || input.can("expense:delete_others");
}
