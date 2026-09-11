/**
 * The invitation UI, and the one thing about it that must stay true.
 *
 * A structural check rather than a rendering one, in the style of the other
 * seam guards here: it asserts the page is wired to the endpoint and that the
 * dialog cannot ask for nothing, which is the state that would mint a token
 * and supersede a live invite for no reason.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { outcomeOf } from "@/lib/invite-outcome";

const page = readFileSync("src/app/team/[id]/page.tsx", "utf8");
const dialog = readFileSync("src/components/app/invite-dialog.tsx", "utf8");
const api = readFileSync("src/lib/api.ts", "utf8");

describe("the invitation UI", () => {
  it("offers an eligible person an invitation, and nobody else", () => {
    expect(page).toContain("InviteDialog");
    expect(page).toContain('!person.email.endsWith("@imported.invalid")');
    expect(page).toContain('can("people:manage")');
    expect(api).toContain('`/users/${id}/invite`');
  });

  it("asks for the channels in one request rather than two", () => {
    /*
      Two buttons would be two requests, and the second would supersede the
      token the first had already emailed. Whichever the person used might be
      the dead one, and the failure surfaces days later with nothing to connect
      it to. One call, one token, both channels.
    */
    expect(
      (dialog.match(/api\.inviteUser\(/g) ?? []).length,
      "one call site, so the two channels cannot become two tokens"
    ).toBe(1);
    expect(dialog, "both channels go in the one request").toContain("email: submitted.email");
    expect(dialog).toContain("link: submitted.link");
  });

  it("captures everything the request needs at submit, not when it runs", () => {
    /*
      A paused offline mutation runs its body on resume, so anything read
      inside is read then: the generation of a different opening, the channel
      checkboxes as they were reset, and the `userId` prop, which by then may
      be a different person. The server would mint a token for somebody nobody
      asked about and supersede their outstanding invite, while the generation
      guard quietly made the UI a no-op.

      Round four moved the generation out and left the rest, fixing the symptom
      that had been noticed rather than the cause.
    */
    expect(dialog).toMatch(
      /submitted: \{ startedAt: number; userId: string; email: boolean; link: boolean \}/
    );
    expect(dialog).toContain("api.inviteUser(submitted.userId");
    expect(dialog, "nothing the request depends on may be read from a closure").not.toMatch(
      /api\.inviteUser\(userId/
    );
  });

  it("will not submit with neither channel chosen", () => {
    expect(dialog).toContain("const nothingChosen = !sendEmail && !wantLink");
    expect(dialog).toContain("disabled={nothingChosen}");
  });

  it("says the link is a credential, and does not keep it", () => {
    // It is shown once and never stored. Anybody holding it can set this
    // person's password.
    expect(dialog).toMatch(/will not be shown again/i);
    expect(dialog).toMatch(/set this person&apos;s password/i);
    expect(dialog).toMatch(/expires in seven days/i);

    const persisted = /localStorage|sessionStorage|indexedDB/.test(dialog);
    expect(persisted, "a one-time credential must not be written to storage").toBe(false);
  });

  it("never puts the credential into the mutation cache at all", () => {
    /*
      Round one "fixed" the credential outliving the dialog by calling
      `invite.reset()`, and asserted the fix by checking the source contained
      that call. Round two showed `reset()` clears the observer and leaves the
      mutation's own `state.data` in the shared cache until garbage collection,
      minutes later. The source assertion was true and the property was false.

      So the credential no longer travels as the mutation's result: the request
      hands it straight to component state and the mutation returns booleans.
      There is one copy, in one place, and the close path clears it.
    */
    const returned = dialog.match(/Promise<\{[^}]*outcome: InviteOutcome \}>/)?.[0];
    expect(returned, "the mutation declares what it resolves to").toBeTruthy();
    expect(returned, "the link must not be part of the mutation's data").not.toMatch(/link/);
    expect(dialog, "setLink happens in the request, not from cached data").toMatch(
      /if \(outcome === "link"\) setLink\(result\.link!\)/
    );
  });

  /*
    The stale-response rule, tested as a rule rather than as a source string.

    Round three found that round two's generation guard covered the link and
    not the success handler: a response from a cancelled request returned
    `hadLink: false`, which read as an email-only invite that worked, so it
    toasted "Invitation queued for" whoever was on screen now and closed the
    dialog underneath them. The tests at the time asserted the source contained
    the guard, and could not have seen it, which is the third round running
    that a source-string assertion has covered for a live defect.

    `outcomeOf` exists so the rule is a pure function with no DOM, and these
    are assertions about behaviour.
  */
  describe("a response that outlived its opening of the dialog", () => {
    const asked = { email: true };

    it("is stale, whatever it came back with", () => {
      expect(outcomeOf({ link: "https://x/set-password?token=abc", queued: true }, asked, 1, 2)).toBe("stale");
      expect(outcomeOf({ queued: true }, asked, 1, 2)).toBe("stale");
    });

    it("is acted on when it is still the current opening", () => {
      expect(outcomeOf({ link: "https://x/set-password?token=abc", queued: true }, asked, 3, 3)).toBe("link");
      expect(outcomeOf({ queued: true }, asked, 3, 3)).toBe("queued");
    });

    it("is ignored by the success handler rather than treated as a plain invite", () => {
      // The defect: `stale` falling through to the branch that toasts about
      // the person currently shown and closes the dialog.
      expect(dialog).toMatch(/if \(outcome === "stale"\) return;/);
    });

    it("is ignored on the error path too", () => {
      // A stale failure would otherwise show a danger toast naming the wrong
      // person, about a request made for somebody else.
      expect(dialog).toMatch(/if \(startedAt !== generation\.current\)\s*\n?\s*return \{ queued: false, emailed: submitted\.email, outcome: "stale" \}/);
    });
  });

  /*
    An invitation nothing can deliver is not a queued invitation.

    The server reports what the queue accepted. With no transport configured
    the row is written `not_configured` and never sends, and the act has
    already spent whatever invitation the person was holding, so "Invitation
    queued" is the one thing the screen must not say.
  */
  describe("an email the queue cannot take", () => {
    it("is a distinct outcome, not a success", () => {
      expect(outcomeOf({ queued: false }, { email: true }, 1, 1)).toBe("undelivered");
    });

    it("does not fire when no email was asked for", () => {
      // Link-only never queues anything, so `queued: false` is the normal case
      // and says nothing about the transport.
      expect(outcomeOf({ link: "https://x/set-password?token=abc", queued: false }, { email: false }, 1, 1)).toBe("link");
    });

    it("never costs the person the link they asked for", () => {
      // Both channels, mail unconfigured: the link is the whole invitation now
      // and dropping it to show a warning would be the worse failure.
      expect(outcomeOf({ link: "https://x/set-password?token=abc", queued: false }, { email: true }, 1, 1)).toBe("link");
    });

    it("keeps the dialog open and says what to do instead", () => {
      const branch = dialog.match(/if \(outcome === "undelivered"\) \{([\s\S]*?)\n      \}/)?.[1];
      expect(branch, "the outcome is handled on its own terms").toBeTruthy();
      expect(branch, "says what happened").toMatch(/mail is not configured/i);
      expect(branch, "and how to get the invitation to them").toMatch(/link/i);
      expect(branch, "closing on a warning hides it").not.toMatch(/onOpenChange\(false\)/);
      expect(branch, "and it must not fall through to the success toast").toMatch(/return;/);
    });
  });

  it("drops the link from state and from the mutation cache when it closes", () => {
    /*
      This test used to assert the opposite, and was wrong: it pinned "clears on
      open" as the desired behaviour, which left the credential in React state
      and in `useMutation`'s `data` for the rest of the session. A reviewer
      caught the header comment claiming it disappeared on close while the code
      did no such thing, and the test was enshrining the defect rather than
      catching it.

      `setLink(null)` alone is not enough. `invite.data.link` is a second copy
      and just as readable from devtools.
    */
    expect(dialog).toContain("setLink(null)");
    expect(dialog, "the mutation result is the second copy").toContain("invite.reset()");
    expect(dialog).toMatch(/if \(!open\) invite\.reset\(\)/);
  });

  it("will not let Esc or the overlay silently destroy an uncopied link", () => {
    // Recovering means inviting again, which supersedes, which kills a link
    // that may already be pasted into a message to the person.
    expect(dialog).toContain("onOpenChange={requestClose}");
    expect(dialog).toMatch(/if \(!next && link && !copied\)/);
  });

  it("survives a clipboard API that is absent rather than failing", () => {
    // `navigator.clipboard` is undefined on an insecure origin, so writeText
    // throws synchronously and a rejection handler never runs.
    expect(dialog).toMatch(/try \{[\s\S]*navigator\.clipboard[\s\S]*\} catch \{/);
  });
});
