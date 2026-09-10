/**
 * Every route this application answers is one something can actually reach.
 *
 * THE DEFECT THIS EXISTS FOR
 *
 * A route and its service get built, reviewed and tested, and nothing ever
 * calls them. The feature looks finished from every angle a test was pointed
 * at, and is unreachable from the product. It has happened nine times:
 *
 *   both recurring-invoice writes   the client sent no idempotency key, so the
 *                                   server refused every attempt (t-wjV2jO)
 *   sign-out                        route and client function both existed, no
 *                                   control called either (t-lCxUn5)
 *   expense editing                 the tray asked for a stricter capability
 *                                   than the server (t-ZbqtuF)
 *   rateMissing                     computed by the domain, read by nothing
 *                                   (t-Fg-4v7)
 *   task delete                     the button pushed a canned error instead
 *                                   of calling the endpoint (t-o-itKE)
 *   entry duplicate                 the menu hand-rolled its own create and
 *                                   disagreed with the endpoint (t-XqXK3W)
 *   the re-rate action              documented in three places, built in none
 *                                   (t-zNfxik, t-9Uli4l)
 *   PATCH /me                       accepted a timezone with no capability and
 *                                   had no caller, so a contractor could not
 *                                   set her own (this one)
 *   POST /time-entries/:id/stop     took a user id in the body and threw it
 *                                   away, which silently undid the fix for
 *                                   t-DVQ2qW hours after it deployed
 *
 * Every one was found by a person hitting it. That last one was found by this
 * test, on its first run, in a fix that had already been deployed.
 *
 * HOW IT READS THE TWO HALVES
 *
 * `tests/support/client-surface.ts` parses the route tree and the two things
 * that speak to it: `src/lib/api.ts` for the web application and `src/mcp/*`
 * for the MCP server. Paths are matched the way Next resolves them, so a
 * literal segment can land on a dynamic route.
 *
 * THE LEDGER IS EXACT, IN BOTH DIRECTIONS
 *
 * `UNREACHED` below is not an allowlist. It is asserted to equal the unreached
 * set exactly, so adding a route nothing calls fails, and wiring up one that is
 * listed also fails until the line is deleted. An allowlist only ever grows;
 * a ledger has to be kept true.
 */

import { describe, expect, it } from "vitest";
import { clientCalls, mcpCalls, routeMethods, matchRoute, expandLiteral } from "./support/client-surface";

/**
 * Route methods nothing calls today, and why.
 *
 * Three kinds, and they should be read differently.
 *
 * REACHED FROM A PAGE THAT CANNOT USE THE CLIENT SEAM. Signed-out screens call
 * `fetch` directly, because `src/lib/api.ts` carries the session envelope and
 * the global 401 redirect, both wrong before there is a session. Verified by
 * file and line rather than asserted, because a scanner for four call sites
 * costs more than it is worth.
 *
 * THE BOOTSTRAP ALREADY CARRIES IT. The single-record read exists for holders
 * of an API token, which is a shipped product feature, and the application
 * takes the same data from the bootstrap payload instead.
 *
 * BUILT, WITH NO UI YET. These are the interesting ones. Each is a working
 * endpoint and service that no screen offers, which is a to-do list rather
 * than an approval, and the reason says so.
 */
const UNREACHED: Record<string, string> = {
  // Reached from a signed-out page through raw fetch.
  "POST /auth/forgot": "src/app/forgot-password/page.tsx asks for a reset link before a session exists",
  "POST /auth/reset": "src/app/set-password/form.tsx sets a password before a session exists",
  "GET /oauth/request": "src/app/oauth/authorize/page.tsx reads the consent request",
  "POST /oauth/authorize": "src/app/oauth/authorize/page.tsx posts the consent decision",

  // The bootstrap already carries this, so the application never asks twice.
  "GET /me": "the bootstrap returns `me`",
  "GET /me/capabilities": "the bootstrap returns the capability set `useCan` reads",
  "GET /permission-profiles": "the bootstrap returns `profiles`",
  "GET /expense-categories": "the bootstrap returns `expenseCategories`",
  "GET /clients/[id]": "the bootstrap returns every client; screens read the list",
  "GET /expenses/[id]": "the expenses screen holds the list it is showing",
  "GET /time-entries/[id]": "the timesheet holds the entries it is showing",
  "GET /departments": "a lookup for API consumers; the person editor edits names as free text",
  "GET /roles": "a lookup for API consumers; the person editor edits names as free text",

  // Built and working, with nothing in the product offering it.
  "GET /notifications": "no UI. The bell in the top bar opens a static menu",
  "POST /notifications/read": "no UI. Nothing can mark a notification read",
  "POST /tasks/[id]/propagate": "no UI. Adding a task to every active project is unreachable",
  "POST /time-entries/[id]/split": "no UI. Splitting an entry is unreachable",
  "POST /retainers/[id]/transactions": "no UI. The retainer ledger cannot be added to by hand",
  "POST /users/[id]/rates": "no UI. The rates card uses PUT, which closes the open range; POST adds an explicit dated range and is how history gets corrected",
  "DELETE /projects/[id]": "no UI. Projects are archived, never deleted, from the product",
  "POST /clients/[id]/archive": "no UI. The clients screen filters on archived but cannot set it",
  "POST /clients/[id]/restore": "no UI. An archived client cannot be brought back from the product",
  "GET /projects/[id]/chart": "no UI. The project page draws its charts from entries it already has",
  "GET /timesheet/summary": "no UI. The timesheet totals in the browser",
  "GET /approvals/me": "no UI. The approvals screen reads the list, not a personal view",
};

describe("the HTTP seam", () => {
  const routes = routeMethods();
  const calls = [...clientCalls(), ...mcpCalls()];

  const reached = new Set<string>();
  const missingRoute: string[] = [];

  for (const call of calls) {
    for (const raw of call.paths ?? []) {
      for (const path of expandLiteral(raw)) {
        const hit = matchRoute(path, routes.filter((r) => r.method === call.method));
        if (hit) reached.add(`${hit.method} /${hit.route}`);
        else missingRoute.push(`${call.method} ${path} (${call.helper}, line ${call.line})`);
      }
    }
  }

  it("found both halves, so the checks below are not vacuous", () => {
    // Without this, renaming a helper or moving the route tree would leave
    // every assertion passing over an empty list.
    expect(routes.length, "no routes found").toBeGreaterThanOrEqual(100);
    expect(calls.length, "no client calls found").toBeGreaterThanOrEqual(90);
    expect(reached.size, "nothing matched at all").toBeGreaterThanOrEqual(90);
  });

  it("can read the path of every call it found", () => {
    /*
      A call whose path this scanner cannot resolve matches no route and is
      silently approved, which is the same defect the file is written to catch.
      So it stops and asks to be taught the shape instead.
    */
    const unreadable = calls
      .filter((c) => c.paths === null)
      .map((c) => `${c.helper} ${c.method} at line ${c.line}: ${c.text.slice(0, 60)}`);

    expect(
      unreadable,
      "These calls do not pass a readable path. Write it as one literal, or teach " +
        "tests/support/client-surface.ts the new shape."
    ).toEqual([]);
  });

  it("never calls a path that no route answers", () => {
    // The other direction: a typo, or a route deleted out from under a caller.
    // Either is a 404 in production and nothing here would otherwise notice.
    expect(missingRoute, "These client calls reach no route.").toEqual([]);
  });

  it("has a caller for every route, or a written reason", () => {
    const unreached = routes
      .map((r) => `${r.method} /${r.route}`)
      .filter((key) => !reached.has(key))
      .sort();

    const ledger = Object.keys(UNREACHED).sort();

    /*
      Exact, not a subset. A new route nothing calls fails on the left; a listed
      route that somebody finally wired up fails on the right, and the line has
      to be deleted. An allowlist that only grows would have hidden every defect
      in this file's header.
    */
    expect(unreached, "Unreached routes and the ledger have diverged.").toEqual(ledger);
  });

  it("gives a reason for every entry in the ledger", () => {
    const empty = Object.entries(UNREACHED)
      .filter(([, reason]) => reason.trim().length < 20)
      .map(([route]) => route);
    expect(empty, "A ledger entry without a real reason is an allowlist.").toEqual([]);
  });
});
