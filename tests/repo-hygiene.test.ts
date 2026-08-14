/**
 * Two repository-wide rules that were written down and never executed.
 *
 * Both come out of the same review. The project's stated lesson is that every
 * defect its adversarial passes found was "a rule stated in prose and asserted
 * nowhere executable", and these were two more of them.
 *
 *   1. **No em dashes in documentation.** CLAUDE.md states the rule and offers
 *      `grep -cP '\x{2014}'` as the way to check it. That command fails outright
 *      on this machine ("grep: -P supports only unibyte and UTF-8 locales"), and
 *      the CI that was meant to run it does not exist. So the one convention
 *      that shipped with a verification command shipped with a broken one.
 *
 *   2. **No credentials in tracked files.** `docs/PERMISSIONS-AND-CREDENTIALS.md`
 *      exists specifically to be the place a SendGrid key, a Google client
 *      secret and a Spaces key pair are discussed and handed over, and it is
 *      inside the Confluence sync's `docGlobs`. Paste a real key into it and the
 *      next sync publishes it to a page every licensed user of the Atlassian
 *      site can read, and into that page's version history, where deleting the
 *      line from the Markdown afterwards will not reach it. Git history is the
 *      same problem with a longer memory.
 *
 * Neither of these can be fixed by being more careful.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

/** Every file git tracks. The scan is about what is committed, not what exists. */
function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

const tracked = trackedFiles();

function read(path: string): string {
  try {
    return readFileSync(`${ROOT}/${path}`, "utf8");
  } catch {
    return ""; // Deleted but still in the index, or unreadable. Nothing to scan.
  }
}

/* -------------------------------------------------------------- em dashes */

const EM_DASH = "—";

/**
 * Our prose, not other people's.
 *
 * `.claude/skills/` is vendored verbatim from another repository and carries
 * about a hundred of them. Rewriting somebody else's skill to satisfy our house
 * style would make the next update from source a merge conflict for no reason.
 */
const isOurDoc = (path: string) =>
  extname(path) === ".md" && (path.startsWith("docs/") || path === "CLAUDE.md" || path === "README.md");

describe("documentation style", () => {
  it("contains no em dashes", () => {
    const offenders = tracked
      .filter(isOurDoc)
      .flatMap((path) => {
        const lines = read(path).split("\n");
        return lines
          .map((line, i) => ({ path, line: i + 1, text: line }))
          .filter(({ text }) => text.includes(EM_DASH));
      })
      .map((o) => `  ${o.path}:${o.line}  ${o.text.trim().slice(0, 90)}`);

    expect(
      offenders,
      "em dashes are not used in this project's prose. Use a comma, a pair of " +
        "parentheses, or a hyphen:\n" + offenders.join("\n")
    ).toEqual([]);
  });

  it("is actually reading the documentation", () => {
    // A filter that matched nothing would pass the assertion above forever.
    expect(tracked.filter(isOurDoc).length, "no documentation files found to check").toBeGreaterThan(4);
  });
});

/* ------------------------------------------------------------- credentials */

/**
 * Shapes that only a live credential has.
 *
 * Deliberately keyed on vendor prefixes and minimum lengths rather than on
 * entropy. An entropy heuristic flags every base64 fixture and sha256 hash in
 * the repository, gets suppressed within a week, and then flags nothing.
 */
const CREDENTIAL_SHAPES: [name: string, pattern: RegExp][] = [
  ["SendGrid API key", /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/],
  ["Google OAuth client secret", /\bGOCSPX-[A-Za-z0-9_-]{20,}/],
  ["AWS or Spaces access key id", /\b(?:AKIA|ASIA|DO00)[A-Z0-9]{16,}/],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ["Stripe live key", /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}/],
  ["private key block", /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/],

  /**
   * A secret assigned to one of the variables that holds a secret here.
   *
   * The earlier version had no pattern for these at all, so the two credentials
   * most likely to be pasted into this repository, `SESSION_SECRET` and
   * `SPACES_SECRET`, were the two it could not see. Keyed on the variable name
   * rather than on the value's shape, because a session secret is 32 random
   * bytes and looks exactly like any other base64 blob.
   *
   * `PLACEHOLDER` and the committed example values are excluded below rather
   * than here, so the pattern stays readable.
   */
  ["a secret assigned to a known variable", /\b(?:SESSION_SECRET|SPACES_SECRET|SMTP_PASSWORD|GOOGLE_CLIENT_SECRET)\s*[:=]\s*["']?[A-Za-z0-9+/_=-]{16,}/],

];

/**
 * Credentials in a connection string pointing somewhere that is not this
 * machine.
 *
 * A function rather than a regex, because the interesting part is judging the
 * password. Keying on length alone lets a short real password through, and a
 * short one is worse rather than better. Keying on the host alone flags every
 * line of documentation that shows the *shape* of a connection string, which
 * this repository has three of: `postgres://user:pass@host:port/dbname`,
 * `postgres://tally:…@postgres:5432/tally`, and the SendGrid example with
 * `SG.xxxxxxxx` in it. All three are the docs doing their job.
 */
const CONNECTION_STRING = /\b[a-z][a-z0-9+.-]*:\/\/([^\s:@/]+):([^\s:@/]+)@([^\s:@/]+)/g;
const LOOPBACK_HOSTS = /^(?:localhost|127\.0\.0\.1|\[::1\]|::1)$/i;

function isPlaceholderPassword(password: string): boolean {
  if (password.length < 6) return true; // "pass", "pw", "…"
  if (/(.)\1{3,}/.test(password)) return true; // xxxxxxxx, ********, ........
  if (/[<>{}$]/.test(password)) return true; // <your-key>, ${SECRET}
  if (/^(?:password|secret|changeme|redacted|your[-_]?\w+)$/i.test(password)) return true;
  return false;
}

function remoteCredentialIn(text: string): boolean {
  for (const match of text.matchAll(CONNECTION_STRING)) {
    const [, , password, host] = match;
    if (LOOPBACK_HOSTS.test(host!)) continue;
    if (isPlaceholderPassword(password!)) continue;
    return true;
  }
  return false;
}

/**
 * Values that match a pattern and are not credentials.
 *
 * A scanner that cries wolf gets muted, and muting it is a one-line change
 * somebody makes in a hurry. So the known-safe strings are listed explicitly:
 * adding one is a deliberate act with a name attached, not a loosened regex.
 */
const KNOWN_SAFE = [
  "AKIAIOSFODNN7EXAMPLE", // AWS's own published example key id
  "replace-me-with-32-random-bytes-base64",
  "dGVzdC1vbmx5LXNlY3JldC0zMi1ieXRlcy1sb25nLXh4", // the fixed test-suite secret
];

/**
 * This file names the shapes, so scanning it would flag itself.
 *
 * The alternative is assembling each pattern from fragments so the literal
 * never appears, which hides what the test is doing to satisfy the test. The
 * honest trade is stated instead: a credential pasted into this one file is not
 * caught, and there is no reason for one to be here.
 */
const SELF = "tests/repo-hygiene.test.ts";

/** Files whose whole point is to be binary or enormous. */
const skipScan = (path: string) =>
  path === SELF ||
  /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|eot|pdf|zip|lock)$/i.test(path) ||
  path === "pnpm-lock.yaml";

/** Whether a line matches a credential shape and is not a listed exception. */
function credentialIn(text: string): string | null {
  if (KNOWN_SAFE.some((safe) => text.includes(safe))) return null;
  for (const [name, pattern] of CREDENTIAL_SHAPES) {
    if (pattern.test(text)) return name;
  }
  if (remoteCredentialIn(text)) return "credentials in a remote connection string";
  return null;
}

function scanForCredentials(paths: string[]): string[] {
  const hits: string[] = [];
  for (const path of paths) {
    if (skipScan(path)) continue;
    read(path)
      .split("\n")
      .forEach((text, i) => {
        const name = credentialIn(text);
        if (name) hits.push(`  ${path}:${i + 1}  looks like ${name}`);
      });
  }
  return hits;
}

describe("credentials", () => {
  /**
   * Positive control.
   *
   * Without it, a mistake in the patterns produces a permanently green test
   * that scans thousands of files and can never fail, which is the exact
   * failure mode the sql-literal guard was rewritten to escape.
   */
  it("recognises a credential when it sees one", () => {
    const shouldCatch = [
      "SMTP_URL=smtps://apikey:SG.aaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbb@smtp.sendgrid.net:465",
      "GOOGLE_CLIENT_SECRET=GOCSPX-abcdefghijklmnopqrstuvwxyz01",
      "SPACES_KEY=AKIAI44QH8DHBEXAMPLZ",
      "-----BEGIN RSA PRIVATE KEY-----",
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "xoxb-1234567890-abcdefghij",
      // Short passwords count. A short real one is worse than a long one.
      "DATABASE_URL=postgres://tally:hunter2@db.jhmediagroup.com:5432/tally",
      // The two most likely to be pasted here, and the two the first version missed.
      'SESSION_SECRET="Zm9vYmFyYmF6cXV1eDEyMzQ1Njc4OTBhYmNkZWY="',
      "SPACES_SECRET=aB3dE5gH7jK9mN1pQ3rS5tU7vW9xY1zA3bC5dE7f",
    ];

    for (const line of shouldCatch) {
      expect(credentialIn(line), `the scanner did not recognise: ${line}`).not.toBeNull();
    }

    // And it has to leave committed placeholders and examples alone. A scanner
    // that flags known-good content is a scanner somebody disables.
    const shouldIgnore = [
      "#   SMTP_URL=smtps://apikey:SG.xxxxxxxx@smtp.sendgrid.net:465",
      "SESSION_SECRET=replace-me-with-32-random-bytes-base64",
      "DATABASE_URL=postgres://tally:tally_dev_password@localhost:5434/tally",
      "TEST_DATABASE_URL=postgres://tally:tally_dev_password@127.0.0.1:5434/tally_test",
      "GOOGLE_CLIENT_ID=",
      "GOOGLE_HOSTED_DOMAIN=jhmediagroup.com",
      "SPACES_ENDPOINT=https://nyc3.digitaloceanspaces.com",
      // A client id is an identifier, not a secret, and it appears in docs.
      "GOOGLE_CLIENT_ID=123456789012-abcdefghijklmnopqrstuvwxyz012345.apps.googleusercontent.com",
      "AKIAIOSFODNN7EXAMPLE", // AWS's own published example
      "const hash = 'a4daf95752f021d6f1d788b0e4b908368acc177641ffa000f8e7d6a27f84c4f2';",
      // Documentation showing the shape of a connection string. This repository
      // has three of these, and all three were flagged by the first version.
      "  // postgres://user:pass@host:port/dbname?params",
      "DATABASE_URL=postgres://tally:…@postgres:5432/tally",
      "#   SMTP_URL=smtps://apikey:SG.xxxxxxxx@smtp.sendgrid.net:465",
      "REDIS_URL=redis://cache.internal:6379",
      "SPACES_ENDPOINT=https://<your-key>:<your-secret>@nyc3.digitaloceanspaces.com",
    ];
    for (const line of shouldIgnore) {
      expect(
        credentialIn(line),
        `the scanner flagged known-good content, which is how it gets muted: ${line}`
      ).toBeNull();
    }
  });

  it("finds none in any tracked file", () => {
    const hits = scanForCredentials(tracked);

    expect(
      hits,
      "a credential appears to be committed. Rotate it first, because removing " +
        "the line does not remove it from git history, and if this file is in " +
        "the Confluence docGlobs it may already have been published:\n" + hits.join("\n")
    ).toEqual([]);
  });

  it("is actually reading the repository", () => {
    expect(tracked.length, "git ls-files returned nothing").toBeGreaterThan(50);
  });
});
