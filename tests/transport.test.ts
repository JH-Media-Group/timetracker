/**
 * The mail transport (TALLY-49).
 *
 * This is the one place the application hands an email to something outside
 * itself, and until this file existed none of it was asserted anywhere. Two
 * things in `transport.ts` are worth testing and both are the kind that fail
 * silently:
 *
 *   1. **The permanent-versus-transient classifier.** Getting it backwards is
 *      not a crash. Treating a 5xx as transient re-sends a message the server
 *      has already refused, five more times, which is how a domain loses its
 *      sending reputation. Treating a 4xx as permanent drops mail on the floor
 *      during a greylist or a rate limit, and the row goes to `failed` with
 *      nobody looking at it.
 *
 *   2. **The disk sink.** It is what stops a developer pointing a real key at a
 *      colleague to check a template. If it silently fell through to SMTP, the
 *      first anybody would know is a client receiving a half-finished draft.
 *
 * `nodemailer` and `env` are both mocked here: this file is about the branching,
 * and a test that needs an SMTP server is a test nobody runs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const h = vi.hoisted(() => ({
  sendMail: vi.fn(),
  env: {
    smtp: { url: "smtp://apikey:a-key@smtp.sendgrid.net:587", from: "Tally <tally@example.test>" } as
      | { url: string; from: string }
      | null,
    APP_URL: "http://localhost:3200",
  },
}));

vi.mock("nodemailer", () => ({ createTransport: vi.fn(() => ({ sendMail: h.sendMail })) }));
vi.mock("@/server/env", () => ({ env: h.env }));

import { PermanentSendFailure, canSend, send } from "@/server/mail/transport";

/** An error shaped the way nodemailer shapes an SMTP refusal. */
function smtpError(responseCode: number, message: string) {
  return Object.assign(new Error(message), { responseCode });
}

const MESSAGE = { to: "someone@example.test", subject: "Hello", text: "Body." };

/**
 * `.mail/` is written under `process.cwd()`, so the tests move cwd into a temp
 * directory rather than scattering files through the repo.
 */
let sandbox: string;
let originalCwd: string;

beforeEach(() => {
  h.sendMail.mockReset();
  h.env.smtp = { url: "smtp://apikey:a-key@smtp.sendgrid.net:587", from: "Tally <tally@example.test>" };
  delete process.env.MAIL_TO_DISK;

  originalCwd = process.cwd();
  sandbox = mkdtempSync(join(tmpdir(), "tally-mail-"));
  process.chdir(sandbox);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(sandbox, { recursive: true, force: true });
});

describe("classifying an SMTP refusal", () => {
  it("treats a 5xx as permanent, so it is never retried", async () => {
    h.sendMail.mockRejectedValue(smtpError(550, "550 5.1.1 The email account does not exist"));
    await expect(send(MESSAGE)).rejects.toBeInstanceOf(PermanentSendFailure);
  });

  it("keeps the server's own words, because that is what gets read in the failure row", async () => {
    h.sendMail.mockRejectedValue(smtpError(553, "553 Sender address rejected"));
    await expect(send(MESSAGE)).rejects.toThrow(/Sender address rejected/);
  });

  for (const [code, what] of [
    [421, "the server is shutting the connection down"],
    [450, "a greylist"],
    [451, "a local processing error"],
    [452, "out of storage"],
  ] as const) {
    it(`treats ${code} as transient, because it is ${what}`, async () => {
      h.sendMail.mockRejectedValue(smtpError(code, `${code} try again later`));
      // Not `rejects.toThrow()`: the whole point is *which* error, since
      // `drainMail` retries anything that is not a PermanentSendFailure.
      await expect(send(MESSAGE)).rejects.not.toBeInstanceOf(PermanentSendFailure);
    });
  }

  it("treats a connection failure with no reply code as transient", async () => {
    // A DNS failure or a timeout carries no `responseCode` at all. Classifying
    // by absence would make every outage permanent.
    h.sendMail.mockRejectedValue(new Error("connect ETIMEDOUT"));
    await expect(send(MESSAGE)).rejects.not.toBeInstanceOf(PermanentSendFailure);
  });

  it("treats a 600 as transient, because it is not a reply code at all", async () => {
    // The band is 500-599. An open-ended `code >= 500` would swallow anything a
    // library invented above the range.
    h.sendMail.mockRejectedValue(smtpError(600, "not an SMTP reply"));
    await expect(send(MESSAGE)).rejects.not.toBeInstanceOf(PermanentSendFailure);
  });

  it("still throws an Error when the thing rejected with was not one", async () => {
    // `drainMail` reads `.message` off whatever comes back. A rejected string
    // would record `undefined` as the failure reason.
    h.sendMail.mockRejectedValue("just a string");
    await expect(send(MESSAGE)).rejects.toBeInstanceOf(Error);
    await expect(send(MESSAGE)).rejects.toThrow(/just a string/);
  });
});

describe("a successful send", () => {
  it("passes the message through and returns the provider's id", async () => {
    h.sendMail.mockResolvedValue({ messageId: "<abc@sendgrid>" });

    const result = await send({ ...MESSAGE, cc: ["manager@example.test"] });

    expect(result.messageId).toBe("<abc@sendgrid>");
    expect(h.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "Tally <tally@example.test>",
        to: "someone@example.test",
        cc: ["manager@example.test"],
        subject: "Hello",
        text: "Body.",
      })
    );
  });

  it("sends no cc header at all rather than an empty one", async () => {
    h.sendMail.mockResolvedValue({ messageId: null });
    await send({ ...MESSAGE, cc: [] });
    expect(h.sendMail.mock.calls[0]![0].cc).toBeUndefined();
  });

  it("reports a null id rather than inventing one", async () => {
    h.sendMail.mockResolvedValue({});
    expect((await send(MESSAGE)).messageId).toBeNull();
  });
});

describe("the transport itself", () => {
  it("is built with timeouts, because the mail lease assumes sending settles quickly", async () => {
    /*
      Asserted because nothing else did.

      A reviewer noticed that deleting all three timeouts survives every other
      test in this file, and that it matters more than it looks: `mail.ts`
      reclaims a row five minutes after it was claimed and may then send it
      again. The argument that a duplicate is rare rests entirely on a hung
      socket failing in twenty seconds rather than hanging for ever. With no
      socket timeout, a single unreachable SMTP host turns "can send twice" into
      the normal case.
    */
    const { createTransport } = await import("nodemailer");
    h.sendMail.mockResolvedValue({ messageId: null });
    await send(MESSAGE);

    expect(createTransport).toHaveBeenCalledWith(
      h.env.smtp!.url,
      expect.objectContaining({
        connectionTimeout: expect.any(Number),
        greetingTimeout: expect.any(Number),
        socketTimeout: expect.any(Number),
      })
    );

    const [, options] = vi.mocked(createTransport).mock.calls[0]!;
    const opts = options as { connectionTimeout: number; socketTimeout: number };
    expect(opts.socketTimeout, "comfortably inside the five minute lease").toBeLessThan(5 * 60_000);
    expect(opts.connectionTimeout).toBeLessThan(5 * 60_000);
  });
});

describe("the disk sink", () => {
  it("writes the message and does not touch SMTP", async () => {
    process.env.MAIL_TO_DISK = "1";

    const result = await send({ ...MESSAGE, cc: ["manager@example.test"] });

    // The assertion that matters: a configured transport was present and was
    // not used. A disk sink that also sends is not a sink.
    expect(h.sendMail).not.toHaveBeenCalled();
    expect(result.messageId).toMatch(/^disk:/);

    const [file] = readdirSync(join(sandbox, ".mail"));
    const written = readFileSync(join(sandbox, ".mail", file!), "utf8");
    expect(written).toContain("To: someone@example.test");
    expect(written).toContain("Cc: manager@example.test");
    expect(written).toContain("Subject: Hello");
    expect(written).toContain("Body.");
  });

  it("omits the Cc line when there is no cc", async () => {
    process.env.MAIL_TO_DISK = "1";
    await send(MESSAGE);
    const [file] = readdirSync(join(sandbox, ".mail"));
    expect(readFileSync(join(sandbox, ".mail", file!), "utf8")).not.toContain("Cc:");
  });

  it("names each file after its recipient without letting the address escape the directory", async () => {
    process.env.MAIL_TO_DISK = "1";
    await send({ ...MESSAGE, to: "../../etc/passwd@example.test" });

    // The address reaches a filename. Everything outside [a-z0-9] is replaced,
    // so `..` and `/` cannot walk out of `.mail/`.
    const files = readdirSync(join(sandbox, ".mail"));
    expect(files).toHaveLength(1);
    expect(files[0]).not.toContain("/");
    expect(files[0]).not.toContain("..");
  });

  it("works with no SMTP configured, which is the whole point", async () => {
    h.env.smtp = null;
    process.env.MAIL_TO_DISK = "1";
    await expect(send(MESSAGE)).resolves.toMatchObject({ messageId: expect.stringMatching(/^disk:/) });
  });
});

describe("canSend", () => {
  it("is true for a configured transport", () => {
    expect(canSend()).toBe(true);
  });

  it("is false with neither a transport nor the disk sink", () => {
    h.env.smtp = null;
    expect(canSend()).toBe(false);
  });

  it("is true for the disk sink alone", () => {
    /*
      This was a real bug, and an expensive one to notice. `queueMail` asks this
      to decide between `queued` and `not_configured`. With `MAIL_TO_DISK=1` and
      no `SMTP_URL`, every message was written `not_configured`, the drain never
      claimed one (it only looks at `queued`), and the job reported success
      having sent nothing. Those rows then stayed unsendable for ever, because
      setting `SMTP_URL` later does not revisit them.
    */
    h.env.smtp = null;
    process.env.MAIL_TO_DISK = "1";
    expect(canSend()).toBe(true);
  });

  it("accepts the two spellings the scripts actually use", () => {
    h.env.smtp = null;
    process.env.MAIL_TO_DISK = "true";
    expect(canSend()).toBe(true);
    process.env.MAIL_TO_DISK = "0";
    expect(canSend()).toBe(false);
  });
});
