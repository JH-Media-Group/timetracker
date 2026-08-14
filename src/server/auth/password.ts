/**
 * Passwords.
 *
 * argon2id at the parameters in BACKEND_PRD 7.1: m=19456 (19 MiB), t=2, p=1.
 * Those are OWASP's current minimums, and they matter more than the algorithm
 * choice: argon2id at default library settings is not meaningfully better than
 * bcrypt.
 *
 * Password sign-in exists for external contractors. Everyone in the Workspace
 * signs in with Google, and the account can turn password sign-in off entirely
 * once nobody needs it.
 */

import { hash, verify } from "@node-rs/argon2";

const OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export const hashPassword = (plain: string): Promise<string> => hash(plain, OPTIONS);

/**
 * Verifies a password.
 *
 * Returns false rather than throwing on a malformed hash, so a corrupt row
 * fails the sign-in instead of returning a 500 that tells an attacker they
 * found something interesting.
 */
export async function verifyPassword(storedHash: string | null, plain: string): Promise<boolean> {
  if (!storedHash) {
    // No password set. Still burn comparable time, so "this account has no
    // password" is not observable from response timing.
    await dummyVerify();
    return false;
  }
  try {
    return await verify(storedHash, plain);
  } catch {
    return false;
  }
}

/**
 * A fixed hash of a fixed string, used to equalise timing when an account does
 * not exist or has no password. Computed lazily and cached, so the cost is paid
 * once per process rather than on every failed attempt.
 */
let dummyHash: string | null = null;

async function dummyVerify(): Promise<void> {
  dummyHash ??= await hashPassword("timing-equalisation-placeholder");
  try {
    await verify(dummyHash, "not-the-password");
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------- policy */

export interface PasswordProblem {
  message: string;
}

/**
 * Deliberately short: length is what matters, and a rule that forces a symbol
 * mostly produces "Password1!" and a sticky note.
 */
export function checkPasswordPolicy(plain: string): PasswordProblem | null {
  if (plain.length < 12) return { message: "Use at least 12 characters." };
  if (plain.length > 200) return { message: "That is longer than 200 characters." };
  if (/^(.)\1+$/.test(plain)) return { message: "That is the same character repeated." };
  const common = ["password", "12345678", "qwerty", "letmein", "jhmediagroup"];
  const lower = plain.toLowerCase();
  if (common.some((c) => lower.includes(c))) return { message: "That contains a word that is guessed first." };
  return null;
}
