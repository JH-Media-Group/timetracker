/**
 * Ending your own session, in one place, with the failure told honestly.
 *
 * Two surfaces do this: the account menu in the shell, and `/logout`, which is
 * the URL people type. They were separate copies of the same five lines, and
 * both got the same thing wrong.
 *
 * WHY THE REDIRECT IS CONDITIONAL
 *
 * `POST /api/v1/auth/signout` revokes the session row and clears the cookie.
 * Both of those happen on the server, so if the request does not land, neither
 * happens: the cookie is HttpOnly and the browser cannot clear it, and the
 * session row stays valid until it expires on its own.
 *
 * The first version swallowed the error and redirected anyway, reasoning that
 * getting the person off the screen was the safer half. It is the opposite.
 * Somebody signing out of a shared machine reads the sign-in page as proof
 * they are signed out; the next person types /timesheet and is still in the
 * first person's account, seeing whatever their profile could see. A screen
 * that says "signed out" over a live session is worse than one that says the
 * sign-out failed, because only the second one gets acted on.
 *
 * So: navigate only after the server has confirmed. Otherwise say so, and let
 * the person try again.
 *
 * WHY IT TAKES ITS DEPENDENCIES
 *
 * `signOut` and `leave` are arguments rather than imports so the rule above is
 * a thing a test can assert (`tests/sign-out.test.ts`), rather than a paragraph
 * in a `.tsx` that Vitest cannot even parse. That is the shape of defect every
 * adversarial round in this repo has found: a rule stated in prose, checked
 * nowhere, drifting in the flattering direction.
 */

export interface EndSessionDeps {
  /** The request that revokes the session. `api.signOut` in the application. */
  signOut: () => Promise<void>;
  /** Leaving the application. A full document load, so the query cache dies with it. */
  leave: () => void;
}

/**
 * Returns `null` when the session is over and the person has been sent away,
 * or a sentence to show them when it is not over.
 */
export async function endSession(deps: EndSessionDeps): Promise<string | null> {
  try {
    await deps.signOut();
  } catch (error) {
    const reason = error instanceof Error && error.message.trim() ? error.message.trim() : "";
    return reason
      ? `${reason.replace(/\.$/, "")}. You are still signed in, so try again.`
      : "Could not sign you out. You are still signed in, so try again.";
  }

  deps.leave();
  return null;
}
