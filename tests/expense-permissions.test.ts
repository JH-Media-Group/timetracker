/**
 * The expenses screen decides editability the way the server does.
 *
 * It did not. The tray gated on `expense:manage`, which only four of the six
 * base profiles hold, while `loadEditable` in the service has always asked for
 * `expense:edit_own` on your own row. Every profile holds that one. So a Member
 * could add an expense and then find no way to correct it, while the API would
 * have accepted the change without complaint (t-ZbqtuF).
 *
 * The UI being stricter than the server is not a safe direction to be wrong in.
 * It looks like a permissions rule and behaves like a broken feature, and
 * nothing fails when it happens.
 *
 * These assertions are built from BASE_PROFILES rather than from a hand-written
 * list of capabilities, so a change to what a Member holds shows up here.
 */

import { describe, expect, it } from "vitest";
import { BASE_PROFILES, type BaseProfileKey, type Capability } from "@/server/auth/capabilities";
import { mayDeleteExpense, mayEditExpense } from "@/lib/expense-permissions";

const canFor = (key: BaseProfileKey) => {
  const held = new Set<Capability>(BASE_PROFILES[key].capabilities);
  return (c: Capability) => held.has(c);
};

const PROFILES = Object.keys(BASE_PROFILES) as BaseProfileKey[];

describe("mayEditExpense", () => {
  it("lets every base profile edit its own expense", () => {
    // This is the assertion the shipped code failed. A Member holds
    // expense:edit_own and nothing else relevant, and could not edit their own
    // expense because the gate asked for expense:manage.
    for (const key of PROFILES) {
      expect(
        mayEditExpense({ own: true, locked: false, can: canFor(key) }),
        `${BASE_PROFILES[key].name} must be able to edit their own expense`
      ).toBe(true);
    }
  });

  it("does not let a Member edit somebody else's", () => {
    expect(mayEditExpense({ own: false, locked: false, can: canFor("member") })).toBe(false);
  });

  it("lets a profile holding expense:manage edit somebody else's", () => {
    const managers = PROFILES.filter((k) =>
      BASE_PROFILES[k].capabilities.includes("expense:manage")
    );
    expect(managers.length, "no base profile holds expense:manage").toBeGreaterThan(0);
    for (const key of managers) {
      expect(
        mayEditExpense({ own: false, locked: false, can: canFor(key) }),
        BASE_PROFILES[key].name
      ).toBe(true);
    }
  });

  it("locks everything once the expense is on a sent invoice", () => {
    // The client has the document, so the number behind it cannot move. This
    // outranks every capability, including the owner's.
    for (const key of PROFILES) {
      expect(mayEditExpense({ own: true, locked: true, can: canFor(key) })).toBe(false);
      expect(mayDeleteExpense({ own: true, locked: true, can: canFor(key) })).toBe(false);
    }
  });
});

describe("mayDeleteExpense", () => {
  it("lets every base profile delete its own", () => {
    for (const key of PROFILES) {
      expect(
        mayDeleteExpense({ own: true, locked: false, can: canFor(key) }),
        BASE_PROFILES[key].name
      ).toBe(true);
    }
  });

  it("does not let a Member delete somebody else's", () => {
    expect(mayDeleteExpense({ own: false, locked: false, can: canFor("member") })).toBe(false);
  });
});
