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
    expect(dialog).toContain("api.inviteUser(userId, { email: sendEmail, link: wantLink })");
    expect(
      (dialog.match(/api\.inviteUser\(/g) ?? []).length,
      "one call site, so the two channels cannot become two tokens"
    ).toBe(1);
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
