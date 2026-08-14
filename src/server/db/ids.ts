/**
 * Identifiers.
 *
 * uuid v7: a 48-bit millisecond timestamp followed by a 12-bit sequence and 62
 * bits of randomness. Rows insert in roughly chronological order, so the
 * primary key index appends rather than splitting pages all over the B-tree the
 * way v4 does. An id also sorts chronologically, which is quietly useful in a
 * debugging session.
 *
 * Generated application-side because Postgres 16 has no native uuidv7().
 *
 * Monotonicity is guaranteed, not hoped for. Two failure modes are handled
 * explicitly, because both actually happen:
 *   - the clock moving backwards (NTP correction, a VM resuming from a
 *     snapshot): the generator holds its previous timestamp rather than
 *     emitting an id that sorts before its predecessor;
 *   - more than 4,096 ids inside one millisecond: the sequence borrows from the
 *     next millisecond instead of wrapping, which would reorder the batch.
 */

import { randomBytes } from "node:crypto";

const SEQUENCE_MAX = 0xfff; // 12 bits

let lastMs = 0;
let sequence = 0;

function nextTimestampAndSequence(): { ms: number; seq: number } {
  const now = Date.now();

  if (now > lastMs) {
    lastMs = now;
    sequence = 0;
    return { ms: lastMs, seq: sequence };
  }

  // Same millisecond, or the clock went backwards. Either way we keep our own
  // monotonic counter and never emit a smaller timestamp than we already have.
  sequence += 1;
  if (sequence > SEQUENCE_MAX) {
    // Borrow from the next millisecond. Under sustained load this drifts the
    // embedded timestamp forward by at most one millisecond per 4,096 ids,
    // which is a far smaller lie than losing the ordering.
    lastMs += 1;
    sequence = 0;
  }
  return { ms: lastMs, seq: sequence };
}

export function newId(): string {
  const { ms, seq } = nextTimestampAndSequence();
  const bytes = randomBytes(16);

  // 48-bit big-endian timestamp. Math.floor on each shift, because a bitwise
  // operator would truncate to 32 bits and silently drop the high bytes.
  bytes[0] = Math.floor(ms / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(ms / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(ms / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(ms / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(ms / 2 ** 8) & 0xff;
  bytes[5] = ms & 0xff;

  // Version 7 in the high nibble of byte 6, then 12 bits of sequence.
  bytes[6] = 0x70 | ((seq >> 8) & 0x0f);
  bytes[7] = seq & 0xff;

  // RFC 4122 variant: binary 10 in the top two bits of byte 8.
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The millisecond embedded in a v7 id. Useful in tests and in the audit log. */
export function timestampOf(id: string): number {
  const hex = id.replace(/-/g, "").slice(0, 12);
  return parseInt(hex, 16);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

/**
 * For tokens and secrets. Deliberately v4-style randomness rather than v7: a
 * session token must not carry a readable creation time.
 */
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
