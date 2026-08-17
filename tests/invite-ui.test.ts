import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("the invitation UI", () => {
  it("connects an eligible person's profile to the invitation endpoint", () => {
    const page = readFileSync("src/app/team/[id]/page.tsx", "utf8");
    const api = readFileSync("src/lib/api.ts", "utf8");

    expect(page).toContain("Send invite");
    expect(page).toContain("api.inviteUser(id)");
    expect(page).toContain('!person.email.endsWith("@imported.invalid")');
    expect(api).toContain('`/users/${id}/invite`');
  });
});
