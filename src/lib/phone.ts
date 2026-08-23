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

/** The country codes worth a menu. Everything else goes through "Other". */
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
  const d = phoneDigits(input);
  if (d.length < 10) return input;
  const ten = d.slice(0, 10);
  const extra = d.slice(10);
  const shaped = `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
  return extra ? `${shaped} x${extra}` : shaped;
}

/** The single string that gets stored. Empty in, empty out. */
export function joinPhone(dialCode: string | null, rest: string): string {
  const national = rest.trim();
  if (!national) return "";
  return dialCode ? `${dialCode} ${formatNationalNumber(national, dialCode)}` : national;
}
