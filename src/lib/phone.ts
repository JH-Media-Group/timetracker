/**
 * Phone numbers, formatted well enough to read and never parsed for meaning.
 *
 * The product does not dial anything. A phone number here is printed on an
 * invoice and copied into somebody's phone by hand, so what matters is that it
 * is legible and that the country is not lost, which it is the moment a US
 * number is stored as ten bare digits and a colleague abroad cannot tell
 * whether to prefix +1.
 *
 * Stored as one string, in E.164-with-decoration: "+1 (312) 555-0100". The
 * dial code is recoverable from the front, which is all the round trip needs.
 * A full libphonenumber is a 500KB dependency for a field eleven people type
 * into a handful of times a year.
 */

/**
 * The country codes worth a menu.
 *
 * There is no "Other" option, and an earlier version of this comment said there
 * was. A number carrying a code that is not listed keeps it inside the number
 * and shows "No country code", which is honest about what is known.
 */
export const DIAL_CODES = [
  { code: "+1", label: "US / Canada (+1)" },
  { code: "+44", label: "United Kingdom (+44)" },
  { code: "+61", label: "Australia (+61)" },
  { code: "+33", label: "France (+33)" },
  { code: "+49", label: "Germany (+49)" },
  { code: "+52", label: "Mexico (+52)" },
  { code: "+91", label: "India (+91)" },
] as const;

export const DEFAULT_DIAL_CODE = "+1";

/**
 * Split a stored number back into a dial code and the rest.
 *
 * A number saved before this field existed has no code and must not grow one:
 * guessing "+1" for a string of digits somebody typed years ago would print a
 * country onto an invoice that nobody asserted. Those come back with a null
 * code, and the editor shows them as typed.
 */
export function splitPhone(stored: string | null | undefined): { dialCode: string | null; rest: string } {
  const s = (stored ?? "").trim();
  if (!s.startsWith("+")) return { dialCode: null, rest: s };

  // Longest known code first, so +1 does not swallow the front of +44.
  const codes = [...DIAL_CODES.map((d) => d.code)].sort((a, b) => b.length - a.length);
  for (const code of codes) {
    if (s.startsWith(code)) return { dialCode: code, rest: s.slice(code.length).trim() };
  }
  // A code we do not list. Keep it in the number rather than dropping it.
  return { dialCode: null, rest: s };
}

/** Digits only, which is what every format decision below is made from. */
export const phoneDigits = (input: string): string => input.replace(/[^0-9]/g, "");

/**
 * Format the national part for display.
 *
 * Only +1 gets a shape, because it is the only one where a single shape is
 * right: (312) 555-0100 is how every North American number is written. UK
 * numbers are grouped four different ways depending on the area code, and
 * imposing one of them on the other three is worse than leaving the digits
 * alone. Anything under a full +1 number is returned as typed so that the
 * field does not fight somebody halfway through it.
 */
export function formatNationalNumber(input: string, dialCode: string | null): string {
  if (dialCode !== "+1") return input;
  let d = phoneDigits(input);
  if (d.length < 10) return input;

  /*
    Eleven digits starting with 1 is the country code typed twice.

    This is how a +1 number sits on most people's clipboard, and the version
    that shipped treated the leading 1 as part of the area code: "1 312 555
    0100" became "+1 (131) 255-5010 x0". A reviewer put that in a table, and it
    is the worst kind of defect this file could have, because the whole point of
    the file is that the number gets printed on an invoice and dialled by hand.
    A wrong number that looks right is worse than no number.
  */
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);

  const ten = d.slice(0, 10);
  const extra = d.slice(10);
  const shaped = `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
  return extra ? `${shaped} x${extra}` : shaped;
}

/**
 * The single string that gets stored. Empty in, empty out.
 *
 * **This does not format.** It used to, and since the input's `onChange` calls
 * it on every keystroke, the "shaped on blur rather than on every keystroke"
 * promise in `PhoneInput` was false: the value jumped and the caret went to the
 * end the moment a tenth digit arrived, which is exactly the fight that comment
 * claimed to prevent. Both reviewers found it. Formatting is now something a
 * caller asks for, which means `onBlur` and nothing else.
 *
 * A national part that already carries its own `+` prefix keeps it and gets no
 * dial code bolted in front, so switching the country select on a number stored
 * as `+353 1 234 5678` cannot produce `+44 +353 1 234 5678`.
 */
export function joinPhone(dialCode: string | null, rest: string): string {
  const national = rest.trim();
  if (!national) return "";
  if (national.startsWith("+")) return national;
  return dialCode ? `${dialCode} ${national}` : national;
}
