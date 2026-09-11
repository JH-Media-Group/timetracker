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

  it("clears the link when the dialog opens, not when it closes", () => {
    // Clearing on close races the closing animation, and a credential flashing
    // back into view on the way out is the one thing that must not happen.
    expect(dialog).toContain("if (open) {");
    expect(dialog).toContain("setLink(null)");
  });
});
