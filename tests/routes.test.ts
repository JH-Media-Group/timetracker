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

const API_ROOT = join(process.cwd(), "src/app/api/v1");

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
  "users/[id]/rates": "service: gated by rates:view_cost and rates:manage inside",
  "users/[id]/rates/[rateId]": "service: gated by rates:manage inside",
};

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) routeFiles(full, out);
    else if (name === "route.ts") out.push(full);
  }
  return out;
}

const routes = routeFiles(API_ROOT).map((file) => {
  const source = readFileSync(file, "utf8");
  const id = relative(API_ROOT, file).split(sep).slice(0, -1).join("/");
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
