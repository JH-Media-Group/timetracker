/**
 * Signing out only counts when the server said so.
 *
 * `POST /auth/signout` is what revokes the session row and clears the cookie,
 * and the cookie is HttpOnly, so a browser that fails to reach the server has
 * ended nothing. Both surfaces that sign somebody out used to swallow the
 * error and show the sign-in page anyway, which on a shared machine is a screen
 * that says "signed out" over a live session.
 *
 * The rule is one line of code and one paragraph of reasoning, which is exactly
 * the shape that drifts. So it is asserted here instead.
 */

import { describe, expect, it } from "vitest";
import { endSession } from "@/lib/sign-out";

describe("endSession", () => {
  it("leaves the application when the server confirms", async () => {
    let left = 0;
    const failure = await endSession({
      signOut: async () => {},
      leave: () => { left++; },
    });

    expect(failure, "nothing to report").toBeNull();
    expect(left, "and the person is sent away").toBe(1);
  });

  it("does not leave the application when the request fails", async () => {
    let left = 0;
    const failure = await endSession({
      signOut: async () => { throw new Error("Network request failed"); },
      leave: () => { left++; },
    });

    expect(left, "the session is still live, so the sign-in page would be a lie").toBe(0);
    expect(failure).toContain("still signed in");
  });

  it("says what went wrong when the server gave a reason", async () => {
    const failure = await endSession({
      signOut: async () => { throw new Error("Service unavailable."); },
      leave: () => {},
    });

    // The server's sentence, then the part the person needs to act on. The
    // trailing full stop is not doubled.
    expect(failure).toBe("Service unavailable. You are still signed in, so try again.");
  });

  it("still reports something when the failure carries no message", async () => {
    const failure = await endSession({
      signOut: async () => { throw new Error(""); },
      leave: () => {},
    });

    expect(failure).toBe("Could not sign you out. You are still signed in, so try again.");
  });
});
