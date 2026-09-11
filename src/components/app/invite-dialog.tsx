"use client";

/**
 * Invite somebody: email it, hand over a link, or both.
 *
 * WHY A LINK AT ALL
 *
 * A queued invite is not a delivered invite. Until mail is configured and
 * draining on the host, pressing the button writes a row that nothing sends and
 * the person waits for an email that never arrives. The workaround was a script
 * on the droplet, which needs a shell and the database credentials: far more
 * authority than whoever is doing the inviting should need, and not available
 * to the person actually onboarding somebody.
 *
 * WHY ONE REQUEST AND NOT TWO BUTTONS
 *
 * Issuing an invite supersedes any outstanding one, so "email it" followed by
 * "give me a link" would mint a second token and kill the first. Whichever one
 * the person actually used would be the dead one, and the failure arrives days
 * later as "this link has expired" with nothing to connect it to. Both boxes go
 * in one request and there is one token either way.
 *
 * THE LINK IS A CREDENTIAL
 *
 * Anybody holding it can set this person's password, once, within seven days.
 * It is shown after the fact rather than offered as a thing to keep, it is
 * never written to storage, and it is dropped from component state and from
 * the mutation cache when the dialog closes.
 *
 * That last clause used to say "it disappears when the dialog closes" while the
 * code cleared on open, which meant the credential sat in React state and in
 * `useMutation`'s `data` for the rest of the session: still there behind an
 * unlocked screen, in a screenshare, or in devtools. A reviewer caught the
 * comment claiming a property the code did not have, which is the flattering
 * direction for a comment to drift in.
 */

import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import { Check, Copy, Link2, Mail } from "lucide-react";
import * as api from "@/lib/api";
import { Button, Checkbox, Dialog, DialogContent } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { outcomeOf, type InviteOutcome } from "@/lib/invite-outcome";

export function InviteDialog({
  open,
  onOpenChange,
  userId,
  name,
  email,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  userId: string;
  name: string;
  email: string;
}) {
  const toast = useToast();
  const [sendEmail, setSendEmail] = React.useState(true);
  const [wantLink, setWantLink] = React.useState(false);
  const [link, setLink] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  /*
    Which opening of the dialog a request belongs to.

    `invite.reset()` detaches the observer; it does not cancel a request in
    flight or stop its callback running. Cancel a pending link-only invite,
    reopen, invite again, and the first response can land after the second and
    overwrite the displayed link with one the second request has already
    superseded. The person then copies a dead link and finds out days later.

    A generation captured at submit and compared on arrival makes a late
    response from a previous opening a no-op.
  */
  const generation = React.useRef(0);

  const invite = useMutation({
    /*
      The link never becomes the mutation's data.

      Returning it put the credential in the shared mutation cache, where
      `reset()` does not reach: it clears the observer and leaves
      `state.data` until garbage collection, several minutes later. The round
      that added `reset()` believed it had fixed this and had a test asserting
      the source contained the call rather than that the cache was empty.

      Handing it straight to component state instead means there is one copy,
      in one place, that the close path actually clears.
    */
    /*
      The whole request is a variable passed to `mutate`, not read inside.

      Anything the function body reads is read when the body runs, and
      react-query pauses a mutation while the browser is offline and resumes it
      later. So a paused request wakes up reading whatever the dialog holds by
      then: the generation of a different opening, the channel checkboxes as
      they were reset, and worst of all the `userId` prop, which by then may be
      a different person. The generation guard would make the outcome a no-op
      while the server had already minted a token for somebody nobody asked
      about and superseded their outstanding invite.

      Round four moved the generation out and left the rest behind, which fixed
      the symptom that had been noticed and not the thing causing it. Everything
      the request depends on is captured at submit now.
    */
    mutationFn: async (
      submitted: { startedAt: number; userId: string; email: boolean; link: boolean }
    ): Promise<{ queued: boolean; outcome: InviteOutcome }> => {
      const { startedAt } = submitted;
      let result;
      try {
        result = await api.inviteUser(submitted.userId, {
          email: submitted.email,
          link: submitted.link,
        });
      } catch (error) {
        /*
          A failure belonging to an earlier opening is not this opening's
          failure. Letting it through showed a danger toast naming whoever is
          on screen now, about a request made for somebody else.
        */
        if (startedAt !== generation.current) return { queued: false, outcome: "stale" };
        throw error;
      }
      const outcome = outcomeOf(result, startedAt, generation.current);
      if (outcome === "link") setLink(result.link!);
      return { queued: result.queued, outcome };
    },
    onSuccess: ({ queued, outcome }) => {
      // A response belonging to an earlier opening says nothing about the one
      // on screen now. It must not toast about the person currently shown and
      // must not close the dialog out from under them.
      if (outcome === "stale") return;

      if (outcome === "link") {
        // Stay open: the link is the reason they are here and it is not
        // recoverable once this closes.
        if (queued) toast.push({ tone: "success", title: `Invitation queued for ${email}.` });
        return;
      }

      toast.push({ tone: "success", title: `Invitation queued for ${email}.` });
      onOpenChange(false);
    },
    onError: (error) =>
      toast.push({
        tone: "danger",
        title: error instanceof Error ? error.message : "Could not send that invitation.",
      }),
  });

  /*
    Cleared both ways, for two different reasons.

    On open, so the dialog starts from a known state rather than showing the
    last invite's answer. On close, so the credential does not outlive the
    dialog: clearing only on open left it in component state and in the
    mutation cache until the page was navigated away from.

    The close path drops the mutation result too. `invite.data.link` is a second
    copy that `setLink(null)` does not touch, and it is just as readable from
    devtools as the first.
  */
  React.useEffect(() => {
    // Bumped on both edges, so any request still in flight from the previous
    // opening lands on a generation that no longer matches and does nothing.
    generation.current += 1;
    setSendEmail(true);
    setWantLink(false);
    setLink(null);
    setCopied(false);
    if (!open) invite.reset();
    // `invite` is stable for the life of the component; depending on it would
    // re-run this on every mutation state change and wipe the link on success.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const cannotCopy = () =>
    toast.push({ tone: "danger", title: "Could not copy. Select the link and copy it by hand." });

  const copy = () => {
    if (!link) return;
    /*
      try/catch as well as the rejection handler. `navigator.clipboard` is
      undefined on an insecure origin, so this throws synchronously rather than
      returning a rejected promise, and the handler that was supposed to say
      "copy it by hand" would never run. The link is still on screen and
      selectable, so the message is the whole recovery path.
    */
    try {
      navigator.clipboard.writeText(link).then(() => {
        setCopied(true);
        toast.push({ tone: "default", title: "Link copied." });
      }, cannotCopy);
    } catch {
      cannotCopy();
    }
  };

  /*
    Closing while the link is on screen destroys the only copy, and Esc or a
    click on the overlay does it without asking. Recovering means inviting
    again, which supersedes, which kills a link that may already be pasted into
    a message to the person. So while a link is showing, only the Done button
    closes this.
  */
  const requestClose = (next: boolean) => {
    if (!next && link && !copied) {
      toast.push({
        tone: "default",
        title: "Copy the link first. It will not be shown again.",
      });
      return;
    }
    onOpenChange(next);
  };

  const nothingChosen = !sendEmail && !wantLink;

  return (
    <Dialog open={open} onOpenChange={requestClose}>
      <DialogContent
        title={`Invite ${name}`}
        description={link ? undefined : "They will be asked to choose a password."}
        size="md"
        footer={
          link ? (
            <Button onClick={() => onOpenChange(false)}>Done</Button>
          ) : (
            <>
              <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button
                loading={invite.isPending}
                disabled={nothingChosen}
                onClick={() =>
                  invite.mutate({
                    startedAt: generation.current,
                    userId,
                    email: sendEmail,
                    link: wantLink,
                  })
                }
              >
                Invite
              </Button>
            </>
          )
        }
      >
        {link ? (
          <div>
            <div className="mb-3 rounded-md border border-tint-amber/40 bg-tint-amber/5 p-3">
              <p className="mb-1 text-sm font-medium text-ink-primary">
                Copy this link now. It will not be shown again.
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 break-all rounded bg-surface-secondary px-2 py-1 text-xs">
                  {link}
                </code>
                <Button variant="ghost" size="sm" onClick={copy} aria-label="Copy link">
                  {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                </Button>
              </div>
            </div>
            <p className="text-base text-ink-secondary">
              It works once, expires in seven days, and replaces any earlier invitation.
              Anybody holding it can set this person&apos;s password, so send it by
              something private rather than a shared channel.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <label className="flex cursor-pointer items-start gap-3">
              <Checkbox checked={sendEmail} onCheckedChange={setSendEmail} className="mt-0.5" />
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-base font-medium text-ink">
                  <Mail className="size-3.5" aria-hidden />Email the invitation
                </span>
                <span className="mt-0.5 block break-words text-sm text-ink-secondary">
                  Queued for {email} and sent when the mail job next runs.
                </span>
              </span>
            </label>

            <label className="flex cursor-pointer items-start gap-3">
              <Checkbox checked={wantLink} onCheckedChange={setWantLink} className="mt-0.5" />
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-base font-medium text-ink">
                  <Link2 className="size-3.5" aria-hidden />Give me a link to send
                </span>
                <span className="mt-0.5 block text-sm text-ink-secondary">
                  Shown once, here. Use this if you want to pass it on yourself, or
                  if you are not sure the email will arrive.
                </span>
              </span>
            </label>

            {sendEmail && wantLink && (
              <p className="text-sm text-ink-secondary">
                Both use the same link, so either one works and using one does not
                break the other.
              </p>
            )}
            {nothingChosen && (
              <p className="text-sm text-danger">Choose at least one.</p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
