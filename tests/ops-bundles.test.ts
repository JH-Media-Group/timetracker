/**
 * The compiled operational scripts actually load.
 *
 * `ops/mail.mjs` crashed on import in the production image and nowhere else,
 * for as long as it existed:
 *
 *     Error: Dynamic require of "events" is not supported
 *
 * esbuild's ESM output replaces `require` with a shim that throws, and
 * nodemailer is CommonJS: it calls `require("events")` at import time. So the
 * job that drains the mail queue died before reading a row, every invite and
 * overdue reminder sat unsent, and `attempts` stayed at 0 because nothing ever
 * tried. On the host it was worse than a failing job, because no timer ran it,
 * so nothing reported the failure either.
 *
 * `tests/deployment-artifacts.test.ts` passed throughout. It greps the
 * Dockerfile for the script names, which proves the command exists rather than
 * that it works. **Nothing ever executed a compiled bundle.**
 *
 * So this compiles each one the way the Dockerfile does and loads it in a
 * child process. It does not need a database: the failure happens at import,
 * before any of these scripts opens a connection, which is precisely what made
 * it invisible to every test that needed one.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/** The scripts the Dockerfile compiles into `ops/`. */
const SCRIPTS = [
  "mail",
  "recurring",
  "sweep",
  "bootstrap-owner",
  "invite-link",
  "harvest-import",
  "harvest-reconcile",
] as const;

const out = mkdtempSync(join(tmpdir(), "tally-ops-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));

/**
 * The same flags the Dockerfile passes, including the banner that is the fix.
 *
 * Through esbuild's JS API rather than `node_modules/.bin/esbuild`, because on
 * Windows that path is a shell shim and `execFileSync` cannot run it.
 */
async function compile(name: string): Promise<string> {
  const file = join(out, `${name}.mjs`);
  const { build } = await import("esbuild");
  await build({
    entryPoints: [`scripts/${name}.mts`],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: ["@node-rs/argon2"],
    alias: { dotenv: "./docker/dotenv-stub.mjs" },
    banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" },
    outfile: file,
  });
  return file;
}

describe("the compiled ops bundles", () => {
  it.each(SCRIPTS)("ops/%s.mjs loads without a dynamic require", async (name) => {
    const file = await compile(name);

    /*
      `spawnSync`, not `execFileSync`, because a non-zero exit is expected and
      is not the thing being tested. These scripts run on import: pointed at a
      port nobody is listening on, they get as far as a connection error, which
      is proof the whole module graph loaded. What must never appear is the
      esbuild shim refusing a `require` from a CommonJS dependency, because
      that happens before any of them reads a row and is invisible to every
      test that needs a database.
    */
    const run = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(file).href)})`],
      {
        encoding: "utf8",
        timeout: 60_000,
        env: {
          ...process.env,
          NODE_ENV: "development",
          DATABASE_URL: "postgres://nobody:nobody@127.0.0.1:1/nothing",
          SESSION_SECRET: "dGVzdC1vbmx5LXNlY3JldC0zMi1ieXRlcy1sb25nLXh4",
          APP_URL: "http://localhost:3200",
        },
      }
    );

    const output = String(run.stdout ?? "") + String(run.stderr ?? "");
    expect(
      output,
      `ops/${name}.mjs cannot resolve a require at load time, so it dies before reading anything. ` +
        `The Dockerfile banner defines a real require for esbuild to find. Output: ` +
        output.slice(0, 400)
    ).not.toMatch(/Dynamic require of/);
  });
});
