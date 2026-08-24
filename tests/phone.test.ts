/**
 * Phone numbers and the `?next=` hop.
 *
 * Both are small, and both have one property worth asserting: the phone
 * helpers must round-trip (what is stored splits back into what was chosen),
 * and `safeReturnPath` must refuse anything that is not a path on this site,
 * because the value ends up in a redirect.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_DIAL_CODE, DIAL_CODES, formatNationalNumber, joinPhone, phoneDigits, splitPhone,
} from "@/lib/phone";
import { safeReturnPath, withParam } from "@/lib/return-to";

describe("phone formatting", () => {
  it("shapes a full US number and leaves a partial one alone", () => {
    expect(formatNationalNumber("3125550100", "+1")).toBe("(312) 555-0100");
    expect(formatNationalNumber("312 555 0100", "+1")).toBe("(312) 555-0100");
    expect(formatNationalNumber("(312) 555-0100", "+1")).toBe("(312) 555-0100");
    expect(formatNationalNumber("31255", "+1")).toBe("31255"); // still typing
  });

  it("keeps an extension rather than dropping the digits past ten", () => {
    expect(formatNationalNumber("31255501004242", "+1")).toBe("(312) 555-0100 x4242");
  });

  it("does not treat a leading country digit as part of the area code", () => {
    /*
      The way a +1 number sits on most people's clipboard. The first version
      took `slice(0, 10)` unconditionally, so "1 312 555 0100" came back as
      "(131) 255-5010 x0": a different area code and a one digit extension. A
      wrong number that looks right is worse than no number, and this file
      exists so the number can be dialled off an invoice.
    */
    expect(formatNationalNumber("1 312 555 0100", "+1")).toBe("(312) 555-0100");
    expect(formatNationalNumber("13125550100", "+1")).toBe("(312) 555-0100");
    // Eleven digits not starting with 1 is not that, so it keeps its extension.
    expect(formatNationalNumber("31255501009", "+1")).toBe("(312) 555-0100 x9");
  });

  it("does not format when a value is merely stored", () => {
    /*
      `joinPhone` runs on every keystroke from the input's `onChange`. While it
      formatted, the value jumped and the caret went to the end the moment a
      tenth digit arrived, under a comment promising that shaping waited for
      blur. Formatting is now something a caller asks for.
    */
    expect(joinPhone("+1", "3125550100")).toBe("+1 3125550100");
    expect(joinPhone("+1", "312555")).toBe("+1 312555");
  });

  it("does not stack a second country code onto a number that has one", () => {
    // Switching the select on a legacy "+353 ..." used to store "+44 +353 ...".
    expect(joinPhone("+44", "+353 1 234 5678")).toBe("+353 1 234 5678");
  });

  it("imposes no shape on a country whose numbers have several", () => {
    // UK numbers group four different ways by area code. One shape would be
    // wrong for three of them, and wrong is worse than plain.
    expect(formatNationalNumber("20 7946 0958", "+44")).toBe("20 7946 0958");
    expect(formatNationalNumber("2079460958", null)).toBe("2079460958");
  });

  it("round-trips through storage", () => {
    for (const { code } of DIAL_CODES) {
      const stored = joinPhone(code, formatNationalNumber("5551234567", code));
      const back = splitPhone(stored);
      expect(back.dialCode, stored).toBe(code);
      expect(phoneDigits(back.rest), stored).toBe("5551234567");
    }
  });

  it("does not let +1 swallow the front of +44", () => {
    expect(splitPhone("+44 20 7946 0958").dialCode).toBe("+44");
    expect(splitPhone("+1 (312) 555-0100").dialCode).toBe("+1");
  });

  it("gives a legacy number no country rather than guessing one", () => {
    // The whole point: a number typed before this field existed asserted no
    // country, and printing "+1" on an invoice would be inventing a fact.
    expect(splitPhone("(312) 555-0100")).toEqual({ dialCode: null, rest: "(312) 555-0100" });
    expect(joinPhone(null, "(312) 555-0100")).toBe("(312) 555-0100");
  });

  it("keeps an unlisted country code in the number instead of dropping it", () => {
    expect(splitPhone("+353 1 234 5678")).toEqual({ dialCode: null, rest: "+353 1 234 5678" });
  });

  it("stores nothing for an empty field", () => {
    expect(joinPhone("+1", "")).toBe("");
    expect(joinPhone("+1", "   ")).toBe("");
  });

  it("offers a default that is one of the options", () => {
    expect(DIAL_CODES.map((d) => d.code)).toContain(DEFAULT_DIAL_CODE);
  });
});

describe("safeReturnPath", () => {
  it("accepts a path on this site", () => {
    expect(safeReturnPath("/projects/new")).toBe("/projects/new");
    expect(safeReturnPath("/projects/abc/edit?tab=team")).toBe("/projects/abc/edit?tab=team");
  });

  it("refuses anything that could leave this site", () => {
    for (const bad of [
      "https://evil.example",
      "//evil.example",
      `/${String.fromCharCode(92)}evil.example`, // a literal backslash, which some browsers read as protocol-relative
      "javascript:alert(1)",
      "evil.example",
      "",
      null,
      undefined,
    ]) {
      expect(safeReturnPath(bad as string | null), String(bad)).toBeNull();
    }
  });
});

describe("withParam", () => {
  it("keeps everything after a second separator", () => {
    // `split("?")` and `split("#")` destructured into two names dropped the
    // rest. Both characters are inside the class `safeReturnPath` accepts.
    expect(withParam("/p/new#a#b", "client", "x")).toBe("/p/new?client=x#a#b");
    expect(withParam("/p/new?note=a?b", "client", "x")).toBe("/p/new?note=a%3Fb&client=x");
  });

  it("adds, replaces, and keeps what was already there", () => {
    expect(withParam("/projects/new", "client", "abc")).toBe("/projects/new?client=abc");
    expect(withParam("/projects/new?client=old", "client", "abc")).toBe("/projects/new?client=abc");
    expect(withParam("/projects/new?tab=x", "client", "abc")).toBe("/projects/new?tab=x&client=abc");
  });

  it("does not lose a hash", () => {
    expect(withParam("/projects/new#team", "client", "abc")).toBe("/projects/new?client=abc#team");
  });
});
