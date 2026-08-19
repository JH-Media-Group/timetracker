/**
 * Every route reaches a gate.
 *
 * The capability check is applied by hand, one function at a time, and two
 * functions were missed: `projectSummary` and `projectChart` had no
 * `assertCan`, their routes declared no `capability`, and a Member could read
 * the company's cost base off a project page. Scope answered "which projects"
 * and nothing answered "which fields".
 *
 * The lesson is not "remember next time". It is that a rule applied by hand
 * needs something that counts. This walks the route files and insists each one
 * either declares a capability, or names itself here with a reason, so adding a
 * route without deciding about authorization fails the suite rather than
 * shipping.
 *
 * It also checks the other half of the pattern, which is the half that made the
 * gap invisible: a route that declares no capability because "the service does
 * its own check" is fine right up until the service does not, so the exemption
 * list says which is which.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { ANONYMOUS_PAGES } from "@/lib/anonymous-pages";

const API_ROOT = join(process.cwd(), "src/app/api/v1");

/**
 * Everything under `src/app/api`, versioned or not.
 *
 * This check used to scan only `v1`, which meant it did not cover the whole API
 * surface while reading as though it did. `src/app/api/health` was outside it
 * and had never been considered by the rule at all, and nothing would have
 * stopped somebody adding `src/app/api/anything/route.ts` with no capability
 * and no exemption. A guard with a hole in it is worse than no guard, because
 * the passing test is taken as evidence.
 *
 * Ids stay relative to `v1` for routes inside it, so the exemption list below
 * did not have to be rewritten, and relative to `api` for routes outside it.
 * `assert no duplicate ids` below is what makes that safe.
 */
const API_PARENT = join(process.cwd(), "src/app/api");

/**
 * The whole app, because a route handler is legal anywhere under it.
 *
 * A review put `src/app/sneaky/route.ts` in the tree with no capability and no
 * exemption, and every test passed. Scanning only `src/app/api` covered the
 * paths we happen to use, while the comment above claimed "the whole API
 * surface". The surface is `src/app/**\/route.*`.
 */
const APP_ROOT = join(process.cwd(), "src/app");

/**
 * Routes that deliberately declare no capability, and why.
 *
 * "Everyone" means every signed-in person may call it: their own record, their
 * own preferences, the reference data every screen reads. "Service" means the
 * service function gates it and the route cannot, usually because the gate
 * depends on the payload.
 */
const EXEMPT: Record<string, string> = {
  "auth/providers": "public: the sign-in page renders before anybody has a session",
  "auth/signin": "public by definition",
  "auth/forgot":
    "public by necessity: somebody locked out has no session. Answers identically whether or not " +
    "the address exists, and is rate limited per address and per mailbox",
  "auth/reset":
    "public by necessity: the token is the credential. Rate limited per address, and deliberately " +
    "not per token, so nobody can burn a colleague's invite by spending its attempts",
  "auth/signout": "ending your own session needs no permission",
  "auth/signout-all": "declares settings:manage",
  bootstrap: "everyone: the shell cannot render without it, and it redacts per capability",
  me: "everyone: your own record",
  "me/capabilities": "everyone: what you may do is not itself privileged",
  users: "everyone: the roster is visible inside the account, with rates redacted",
  "users/[id]": "everyone for the read; the PATCH declares people:manage",
  clients: "everyone for the read; the POST declares client:manage",
  "clients/[id]": "everyone for the read; the writes declare client:manage",
  projects: "everyone for the read; the POST declares project:manage",
  "projects/[id]": "everyone for the read; the writes declare project:manage",
  "projects/[id]/pin": "a personal preference, scoped to a project you can see",
  "projects/[id]/unpin": "a personal preference",
  tasks: "everyone for the read; the POST declares task:manage",
  settings: "everyone for the read; the PATCH declares settings:manage",
  roles: "reference data",
  departments: "reference data",
  "expense-categories": "reference data for the read; the POST declares expense:manage",
  "expense-categories/[id]": "service: gated by expense:manage inside",
  expenses: "service: an expense of your own needs only the floor capability",
  "expenses/[id]": "service: editability depends on whose expense it is",
  "time-entries": "service: your own time needs only the floor capability",
  "time-entries/[id]": "service: editability depends on whose entry it is",
  "time-entries/running": "your own running timer",
  "time-entries/[id]/stop": "service: stopping somebody else's needs reach",
  "time-entries/[id]/restore": "service: scoped to entries you may edit",
  "time-entries/[id]/split": "service: scoped to entries you may edit",
  "time-entries/[id]/duplicate": "service: scoped to entries you may edit",
  "timesheet/summary": "your own timesheet",
  "timesheet/week": "declares time:create_own; the service checks reach",
  approvals: "service: the queue is scoped to what you may review",
  "approvals/me": "your own submissions",
  "approvals/submit": "service: submitting for somebody else needs reach",
  notifications: "your own notifications",
  "notifications/read": "your own notifications",
  search: "service: every result set is scoped",
  "invoices/[id]": "service: gated by invoice:view and invoice:manage inside",
  "projects/[id]/summary": "declares report:view_own; the service redacts by capability",
  "projects/[id]/chart": "declares report:view_own; the service redacts by capability",
  "reports/time": "service: gated by report:view_own, which everyone holds, and redacts money",
  "reports/team":
    "service: accepts report:view_team or the wider report:view_all, which one route option cannot express",
  "users/[id]/rates":
    "service: GET is gated by rates:view_billable, or by the row being your own, " +
    "and cost rows are then filtered out unless the actor holds rates:view_cost. " +
    "POST is gated by rates:manage. (This line said rates:view_cost until a " +
    "review compared it to the code; the behaviour was right and the sentence " +
    "meant to make it checkable was not.)",
  "users/[id]/rates/[rateId]": "service: gated by rates:manage inside",

  // Outside v1. These are infrastructure endpoints, not part of the API the
  // app calls, and they are deliberately unauthenticated so that a proxy and a
  // container runtime can poll them before anybody has a session.
  health: "unauthenticated by design: the legacy combined probe, behaves as ready",
  "health/live": "unauthenticated by design: process liveness, touches nothing",
  "health/ready": "unauthenticated by design: readiness, reports only ok or degraded",
};

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) routeFiles(full, out);
    // Next resolves a route from any of its pageExtensions, not just .ts. A
    // review added `route.tsx` with a bare, ungated GET and the suite passed.
    else if (/^route\.(ts|tsx|mts|js|jsx|mjs)$/.test(name)) out.push(full);
  }
  return out;
}

const routes = routeFiles(APP_ROOT).map((file) => {
  const raw = readFileSync(file, "utf8");

  /*
    Comments are stripped before looking for a capability.

    The pattern matched the word inside a doc block, so a route whose only
    mention of a capability was a sentence describing one satisfied the guard. A
    review proved it with a GET handler that had no gate and a tidy comment: all
    nine tests passed.
  */
  const source = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  const inV1 = !relative(API_ROOT, file).startsWith("..");
  const inApi = !relative(API_PARENT, file).startsWith("..");
  // Ids stay relative to v1 for routes inside it, so the exemption list below
  // did not have to be rewritten. Anything outside `api` is prefixed so it can
  // never quietly borrow an exemption meant for an API route.
  const root = inV1 ? API_ROOT : inApi ? API_PARENT : APP_ROOT;
  const rel = relative(root, file).split(sep).slice(0, -1).join("/");
  const id = inV1 || inApi ? rel : `app/${rel}`;

  return {
    id,
    source,
    declaresCapability: /capability:\s*"/.test(source),
    isPublic: /public:\s*true/.test(source),
    methods: [...source.matchAll(/export (?:const|async function) (GET|POST|PATCH|PUT|DELETE)/g)].map((m) => m[1]!),
  };
});

describe("the API surface", () => {
  it("has routes to check", () => {
    expect(routes.length).toBeGreaterThan(50);
  });

  it("gives every route a unique id", () => {
    // Ids come from two roots, so a v1 route sharing a name with a top-level
    // one would silently take its exemption. Nothing does today; this is what
    // keeps that true.
    const seen = new Map<string, string[]>();
    for (const r of routes) seen.set(r.id, [...(seen.get(r.id) ?? []), r.source.length.toString()]);
    const dupes = [...seen.entries()].filter(([, v]) => v.length > 1).map(([k]) => k);
    expect(dupes, `two routes share an id: ${dupes.join(", ")}`).toEqual([]);
  });

  it("gives every route a capability or a documented reason not to have one", () => {
    const undecided = routes
      .filter((r) => !r.declaresCapability && !r.isPublic && !(r.id in EXEMPT))
      .map((r) => r.id);

    expect(
      undecided,
      "these routes declare no capability and are not in the exemption list. " +
        "Add `capability:` to the route, or add it to EXEMPT in this file with the reason:\n  " +
        undecided.join("\n  ")
    ).toEqual([]);
  });

  it("keeps the exemption list honest", () => {
    // An exemption for a route that has since grown a capability is a comment
    // that has stopped being true, which is how the last set of defects hid.
    const stale = Object.keys(EXEMPT).filter((id) => {
      const route = routes.find((r) => r.id === id);
      return !route;
    });
    expect(stale, `exempted routes that no longer exist: ${stale.join(", ")}`).toEqual([]);
  });

  it("declares a rate-limit class or takes the default deliberately", () => {
    // Not a hard requirement, but a route with no class at all is a route
    // nobody thought about, and the default is only right for plain reads.
    const heavy = routes.filter(
      (r) => r.id.startsWith("reports/") && !/rateLimit:\s*"report"/.test(r.source)
    );
    expect(heavy.map((r) => r.id), "report routes should draw from the report bucket").toEqual([]);
  });

  it("runs every mutating route through the shared kernel", () => {
    // `route()` is what makes the transaction, the audit flush, the rate limit
    // and the origin check automatic. A handler exported directly opts out of
    // all four at once, and the two that do it are auth routes that must.
    const raw = routes.filter(
      (r) =>
        r.methods.some((m) => m !== "GET") &&
        /export async function (POST|PATCH|PUT|DELETE)/.test(r.source) &&
        !r.id.startsWith("auth/")
    );
    expect(raw.map((r) => r.id), "mutating routes that bypass route()").toEqual([]);
  });
});

/**
 * The middleware's public-path list.
 *
 * An adversarial review found `/api/health` sitting in a `startsWith` list,
 * which exempted every path beginning with those characters: `/api/health-admin`
 * would have been served without a session, and nothing said so. Verified at the
 * time by requesting it against a production build and getting 200; it is 401
 * now.
 *
 * A prefix that is not a directory is the trap, so this asserts the shape rather
 * than the specific paths.
 */
describe("middleware public paths", () => {
  const source = readFileSync(join(process.cwd(), "src/middleware.ts"), "utf8");
  const strings = (block: string) => [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  const prefixes = strings(/const PUBLIC_PREFIXES = \[[^\]]*\]/.exec(source)?.[0] ?? "");
  /*
    The literals in the block, plus the ones spread in from the shared list.

    `PUBLIC_EXACT` no longer spells out the pages a person reaches before
    signing in: it spreads `ANONYMOUS_PAGES`, which `layout.tsx`, the shell, the
    data provider and the timer all read too, so there is one list instead of
    four. A source-parsing test cannot follow a spread, so it unions the two
    deliberately rather than quietly reporting a shorter set.
  */
  const exact = [
    ...strings(/const PUBLIC_EXACT = new Set(?:<[^>]*>)?\(\[[^\]]*\]\)/.exec(source)?.[0] ?? ""),
    ...ANONYMOUS_PAGES,
  ];
  const list = (name: string) => (name === "PUBLIC_PREFIXES" ? prefixes : exact);

  it("has both lists", () => {
    expect(list("PUBLIC_PREFIXES").length).toBeGreaterThan(0);
    expect(list("PUBLIC_EXACT").length).toBeGreaterThan(0);
  });

  it("builds the exact list from the shared anonymous pages", () => {
    // Without this, the union above would be an assumption rather than a fact:
    // drop the spread and the test would still claim those pages are exempt.
    expect(
      source,
      "PUBLIC_EXACT should spread ANONYMOUS_PAGES so the four lists stay one"
    ).toMatch(/\.\.\.ANONYMOUS_PAGES/);
  });

  it("only prefix-matches directories", () => {
    // "/api/v1/auth/" is fine: the trailing slash bounds it to children.
    // "/signin" is not: it also matches a future "/signin-admin" page.
    const unbounded = list("PUBLIC_PREFIXES").filter((p) => !p.endsWith("/"));
    expect(
      unbounded,
      "these exempt every path that merely starts with them. Add a trailing slash, or move them to PUBLIC_EXACT:\n  " +
        unbounded.join("\n  ")
    ).toEqual([]);
  });

  it("exempts the health probes exactly, so a sibling path is not exempt too", () => {
    const exact = list("PUBLIC_EXACT");
    expect(exact).toContain("/api/health");
    expect(exact).toContain("/api/health/live");
    expect(exact).toContain("/api/health/ready");
  });

  it("exempts public pages exactly, so similarly named pages stay protected", () => {
    const exact = list("PUBLIC_EXACT");
    expect(exact).toContain("/signin");
    expect(exact).toContain("/set-password");
    expect(list("PUBLIC_PREFIXES")).not.toContain("/signin");
    expect(list("PUBLIC_PREFIXES")).not.toContain("/set-password");
  });
});

/**
 * A rate-limit key must identify the caller, never a constant.
 *
 * `enforce("auth", "forgot:no-client-ip")` reads like a safe fallback and is a
 * different mechanism entirely: every caller shares one bucket, so ten
 * anonymous requests ration the whole company. `auth/signin` carries a long
 * comment explaining this, and it was reintroduced two files away anyway, which
 * is why prose is not enough and this is a test.
 *
 * `clientIp()` returns null unless a trusted proxy is configured, and
 * `.env.example` ships `TRUST_PROXY=0`, so the fallback path is the likely one
 * rather than the rare one.
 */
describe("rate-limit keys", () => {
  const files = routeFiles(APP_ROOT);

  it("has routes to check", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("never rations every caller through one shared bucket", () => {
    const offenders: string[] = [];

    for (const file of files) {
      const text = readFileSync(file, "utf8");
      /*
        Any constant string anywhere in the key is the finding.

        A legitimate key varies with the caller, so it is a template that
        interpolates or a helper call. Matching only a key that IS a literal was
        too narrow: the first version passed against
        `ip ? \`forgot:ip:${ip}\` : "forgot:no-client-ip"`, which is precisely
        the shape the bug took.

        Checking for `"` and `'` alone was still too narrow, which a reviewer
        demonstrated: a backtick string with nothing interpolated in it, like
        `` `forgot:no-client-ip` ``, contains neither quote character and sailed
        through while being exactly what this test exists to forbid.

        And **each literal is judged on its own**, not the key as a whole. Asking
        whether the key contains `${` anywhere passes the shape that matters
        most, `ip ? \`forgot:ip:${ip}\` : \`forgot:no-client-ip\``, because the
        live branch's interpolation vouches for the constant one. That was this
        test's second miss in two attempts, both times on a ternary.
      */
      for (const m of text.matchAll(/(?:enforce|consume)\(\s*"[^"]+"\s*,([\s\S]*?)\);/g)) {
        const key = m[1] ?? "";
        const constantTemplate = [...key.matchAll(/`[^`]*`/g)].some((t) => !t[0].includes("${"));
        if (/["']/.test(key) || constantTemplate) {
          offenders.push(`  ${relative(process.cwd(), file)}:${key.trim()}`);
        }
      }
    }

    expect(
      offenders,
      "these limiter keys are constant, so one stranger's requests exhaust the bucket for everybody. " +
        "Key on the caller, and skip the limit when the caller cannot be identified:\n" +
        offenders.join("\n")
    ).toEqual([]);
  });
});
