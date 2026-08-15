/**
 * The one place the application hands an email to something outside itself.
 *
 * Everything else queues a row in `outbound_messages`; only the drain calls
 * this. That is why there is no `sendMail` helper for a route to reach for: a
 * send that happens inside a request is a send that happens inside a
 * transaction, and a transaction that rolls back cannot unsend an email.
 *
 * SENDGRID
 *
 * Over SMTP, which needs no SDK: host `smtp.sendgrid.net`, username the literal
 * string `apikey`, password the key. That is already the shape of `SMTP_URL`,
 * so nothing new is configured to switch providers.
 */

import { createTransport, type Transporter } from "nodemailer";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "@/server/env";

export interface Outgoing {
  to: string;
  cc?: string[];
  subject: string;
  text: string;
}

export interface SendResult {
  /** The provider's id, when it gives one. Useful when chasing a bounce. */
  messageId: string | null;
}

/**
 * A permanent refusal, which must not be retried.
 *
 * A 5xx from an SMTP server means the address is wrong or the message is
 * unacceptable, and sending it again tomorrow produces the same answer while
 * hurting the domain's reputation a second time. A 4xx is a greylist, a rate
 * limit or an outage, and is exactly what backoff is for.
 */
export class PermanentSendFailure extends Error {}

let cached: Transporter | null = null;

function transporter(): Transporter {
  if (cached) return cached;
  if (!env.smtp) throw new Error("No SMTP transport is configured.");

  cached = createTransport(env.smtp.url, {
    // A drain that hangs holds its claimed rows in `sending` until the next run
    // times them out. Fail fast instead and let the backoff handle it.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return cached;
}

/** Whether mail can be sent at all. The drain checks this before claiming anything. */
export const canSend = (): boolean => Boolean(env.smtp);

/**
 * Where a development send goes instead of the internet.
 *
 * Testing the invite flow must not require mailing real people, and pointing a
 * real key at a colleague's address to check a template is how a half-finished
 * template reaches a client. With `MAIL_TO_DISK=1` the message is written to
 * `.mail/` and the drain treats it as sent.
 */
const toDisk = (): boolean => process.env.MAIL_TO_DISK === "1" || process.env.MAIL_TO_DISK === "true";

export async function send(message: Outgoing): Promise<SendResult> {
  if (toDisk()) {
    const dir = join(process.cwd(), ".mail");
    mkdirSync(dir, { recursive: true });
    const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${message.to.replace(/[^a-z0-9]+/gi, "_")}.txt`;
    writeFileSync(
      join(dir, name),
      `To: ${message.to}\n` +
        (message.cc?.length ? `Cc: ${message.cc.join(", ")}\n` : "") +
        `Subject: ${message.subject}\n\n${message.text}\n`,
      "utf8"
    );
    return { messageId: `disk:${name}` };
  }

  if (!env.smtp) throw new Error("No SMTP transport is configured.");

  try {
    const info = await transporter().sendMail({
      from: env.smtp.from,
      to: message.to,
      cc: message.cc?.length ? message.cc : undefined,
      subject: message.subject,
      text: message.text,
    });
    return { messageId: info.messageId ?? null };
  } catch (e) {
    /*
      Nodemailer surfaces the SMTP reply code as `responseCode`. A 5xx is the
      server saying no and meaning it; anything else is treated as transient so
      the backoff gets a chance.
    */
    const code = (e as { responseCode?: number }).responseCode;
    const detail = e instanceof Error ? e.message : String(e);
    if (typeof code === "number" && code >= 500 && code < 600) {
      throw new PermanentSendFailure(detail);
    }
    throw e instanceof Error ? e : new Error(detail);
  }
}

/** Only for tests, which must not reuse a transport across cases. */
export function resetTransport(): void {
  cached = null;
}
