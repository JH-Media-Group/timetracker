/**
 * The client's half of two contracts that have broken before.
 *
 * `src/lib/api.ts` runs in a browser and talks to a server, so it is awkward to
 * unit test and easy to leave untested. Both of the things checked here were
 * defects that shipped and were caught by a reviewer rather than by the suite,
 * and both are one deleted line away from returning:
 *
 *   1. `createInvoice` must send `amountCents`. Without it the server falls
 *      back to `quantity x unitPrice`, the quantity is hours rounded to two
 *      decimals for the document, and the invoice bills a different number from
 *      the preview somebody approved. This is the same defect that was fixed on
 *      the server and then reintroduced at the client.
 *   2. The idempotency key must be derived from the payload. A fresh value per
 *      call makes the whole mechanism inert: the server stores a claim, matches
 *      nothing against it, and a double click on Record payment takes two
 *      payments.
 *
 * Textual, because the shape of the payload is textual. A runtime test would
 * need a DOM, a fetch stub and a session, which is a harder test that catches
 * the same two bugs.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "src/lib/api.ts"), "utf8");

function body(fn: string): string {
  const start = source.indexOf(`export async function ${fn}(`);
  expect(start, `${fn} is missing from api.ts`).toBeGreaterThan(-1);
  const end = source.indexOf("\nexport ", start + 1);
  return source.slice(start, end === -1 ? undefined : end);
}

describe("the invoice payload", () => {
  it("sends the exact line amount rather than letting the server re-derive it", () => {
    const create = body("createInvoice");
    expect(create).toContain("amountCents:");
    // And it has to be the line's own amount, not something computed here.
    expect(create).toMatch(/amountCents:\s*Math\.round\(l\.amountCents\)/);
  });

  it("passes the exact amount through the preview adapter too", () => {
    const preview = body("getUninvoiced");
    expect(preview).toContain("amountCents: l.amountCents");
  });
});

describe("the idempotency key", () => {
  it("is derived from the operation and its payload", () => {
    const helper = source.slice(source.indexOf("function idempotencyKey("));
    // A random value per call is the failure: it looks like it works and
    // deduplicates nothing.
    expect(helper).not.toContain("randomUUID");
    expect(helper).not.toContain("Math.random");
    expect(helper).toContain("JSON.stringify(payload)");
  });

  it("is passed by every money-moving request", () => {
    for (const fn of ["recordPayment", "createInvoice"]) {
      expect(body(fn), `${fn} must send an Idempotency-Key`).toContain("idempotencyKey(");
    }
  });
});

describe("the money adapters", () => {
  it("keeps a redacted rate absent rather than turning it into zero", () => {
    const user = source.slice(source.indexOf("function fromUser("), source.indexOf("interface ClientWire"));
    // `?? 0` here presents "you may not see this" as an accounting figure.
    expect(user).not.toMatch(/billableRateCents:\s*u\.billableRateCents\s*\?\?\s*0/);
    expect(user).not.toMatch(/costRateCents:\s*u\.costRateCents\s*\?\?\s*0/);

    const entry = source.slice(source.indexOf("function fromTimeEntry("), source.indexOf("interface ExpenseWire"));
    expect(entry).not.toMatch(/billableRateCents:\s*e\.billableRateCents\s*\?\?\s*0/);
    expect(entry).not.toMatch(/costRateCents:\s*e\.costRateCents\s*\?\?\s*0/);
  });

  it("does not silently rewrite a custom payment term", () => {
    const client = source.slice(source.indexOf("function fromClient("), source.indexOf("interface ProjectWire"));
    expect(client).not.toContain('=== "custom" ? "net_30"');
  });
});

describe("the sign-in redirect", () => {
  it("resolves the target and checks its origin rather than testing a prefix", () => {
    const signin = readFileSync(resolve(process.cwd(), "src/app/signin/page.tsx"), "utf8");
    const guard = signin.slice(signin.indexOf("function safeNext("));
    // URL parsing strips tab, newline and carriage return before parsing, so a
    // startsWith("//") test never sees "/\n/evil.example".
    expect(guard).toContain("new URL(");
    expect(guard).toContain("url.origin !== window.location.origin");
  });
});
