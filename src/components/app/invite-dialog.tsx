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
 * never stored, and it disappears when the dialog closes.
 */

import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import { Check, Copy, Link2, Mail } from "lucide-react";
import * as api from "@/lib/api";
import { Button, Checkbox, Dialog, DialogContent } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";

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
    Back to the starting state every time it opens, rather than on close.
    Clearing on close races the closing animation, and a link that flashes back
    into view for a frame on the way out is the one thing that must not happen
    to a credential.
  */
  React.useEffect(() => {
    if (open) {
      setSendEmail(true);
      setWantLink(false);
      setLink(null);
      setCopied(false);
    }
  }, [open]);

  const invite = useMutation({
    mutationFn: () => api.inviteUser(userId, { email: sendEmail, link: wantLink }),
    onSuccess: (result) => {
      if (result.link) {
        // Stay open: the link is the reason they are here and it is not
        // recoverable once this closes.
        setLink(result.link);
        if (result.queued) toast.push({ tone: "success", title: `Invitation queued for ${email}.` });
      } else {
        toast.push({ tone: "success", title: `Invitation queued for ${email}.` });
        onOpenChange(false);
      }
    },
    onError: (error) =>
      toast.push({
        tone: "danger",
        title: error instanceof Error ? error.message : "Could not send that invitation.",
      }),
  });

  const copy = () => {
    if (!link) return;
    navigator.clipboard.writeText(link).then(
      () => {
        setCopied(true);
        toast.push({ tone: "default", title: "Link copied." });
      },
      () => toast.push({ tone: "danger", title: "Could not copy. Select the link and copy it by hand." })
    );
  };

  const nothingChosen = !sendEmail && !wantLink;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
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
                onClick={() => invite.mutate()}
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
