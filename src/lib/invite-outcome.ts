/**
 * What a completed invite request should cause.
 *
 * Split out of the dialog because it is a rule rather than a rendering
 * concern, and because a rule in a `.tsx` file cannot be imported by a test in
 * this suite: the environment is `node`, so the transform refuses the JSX and
 * the whole test file fails to load. It did, silently, while the run still
 * reported passing tests from the other file in the same command.
 *
 * THE RULE
 *
 * A response belongs to the opening of the dialog that started it. Three
 * rounds of review circled this:
 *
 * Round two found that a response from a cancelled request could land after a
 * later one and overwrite a live link with a superseded one, and guarded the
 * link with a generation counter.
 *
 * Round three found that the guard covered the link and not the rest: a stale
 * result still reported success, so it toasted "Invitation queued for"
 * whoever happened to be on screen at that moment, who was not the person
 * invited, and closed the dialog underneath whatever the user had begun
 * choosing for them.
 *
 * So staleness is an outcome in its own right rather than an absence of one,
 * and the caller has to say what it does about it.
 *
 * AND "QUEUED" IS A CLAIM ABOUT THE QUEUE, NOT ABOUT THE REQUEST
 *
 * The server reports whether the message was accepted for delivery. With no
 * transport configured the row is written `not_configured` and nothing will
 * ever send it, so an email-only invite in that state has spent the person's
 * outstanding invitation and delivered nothing. That is a fourth outcome, not
 * a variety of success: the screen has to say so, and the way out is to take a
 * link instead, which is one checkbox away.
 *
 * A link that was asked for still wins. It is the credential, it is on screen
 * once, and a warning about the email is no reason to drop it.
 */

export type InviteOutcome = "stale" | "link" | "queued" | "undelivered";

export function outcomeOf(
  result: { link?: string; queued: boolean },
  asked: { email: boolean },
  startedAt: number,
  now: number
): InviteOutcome {
  if (startedAt !== now) return "stale";
  if (result.link) return "link";
  return asked.email && !result.queued ? "undelivered" : "queued";
}
