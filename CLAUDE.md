# CLAUDE.md - onboarding for future sessions

Auto-loaded into every Claude Code session in this repo. Read it before doing anything substantive, and fix it when it drifts.

**Read order for a fresh session:**
1. `~/.claude/projects/c--Users-jason-Documents-GitHub-timetracker/memory/MEMORY.md` (auto-loaded; durable memories).
2. This file.
3. [docs/PRD-OVERVIEW.md](docs/PRD-OVERVIEW.md) for what and why, then the PRD covering the area you are touching.
4. [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) for what to build next, in order.

---

## TL;DR

- **Product:** Tally (working codename). An in-house replacement for JH Media Group's Harvest account: time tracking, project profitability, and invoicing. Internal only, never sold, served from a single DigitalOcean droplet.
- **Status (2026-08-14):** PRDs v1.1, design system complete, and the **whole thing runs end to end against Postgres**. `pnpm db:setup` then `pnpm dev -p 3200`, sign in as `person01@example.com` / `tally-dev-password`. 235 tests, clean typecheck, clean `next build`, clean dependency audit. Not built yet: Google SSO, email delivery, receipt and PDF storage, the job queue, and the Harvest import itself. Each of those is waiting on a credential; see [docs/PERMISSIONS-AND-CREDENTIALS.md](docs/PERMISSIONS-AND-CREDENTIALS.md).
- **Replaces:** the private Harvest account. Migration must reconcile to the cent; see BACKEND_PRD section 16.3.
- **User:** Jason. PowerShell on Windows. No em dashes in any generated user-facing text, docs included.

## Canonical docs

| Doc | Authority over |
|---|---|
| [docs/PRD-OVERVIEW.md](docs/PRD-OVERVIEW.md) | Scope, principles, permission profiles, tech stack, release phases and the §6.1 phase map, glossary |
| [docs/FRONTEND_PRD.md](docs/FRONTEND_PRD.md) | Design tokens, every page layout and interaction, component inventory, performance budgets. Section headers carry `Phase:` tags. |
| [docs/BACKEND_PRD.md](docs/BACKEND_PRD.md) | Schema DDL, domain formulas (§4 is the specification for all money math), API surface, jobs, integrations, migration, deployment |
| [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) | Build order. Treat as authoritative for "what's next". |
| [design system/](design%20system/README.md) | **Canonical for anything visual.** Tokens, Tailwind bridge, base layer, cva recipes. Five files ship verbatim into the app. Open `preview/index.html` in a browser to see the whole system rendered. Supersedes FRONTEND_PRD §2 as the implementation. |

Don't re-derive what is documented; cite back to it. If code and PRD disagree, the PRD wins until it is deliberately amended in the same commit.

## Non-negotiable conventions

- **No em dashes** in user-facing output: UI copy, docs, emails, commit-visible prose. Use commas, parentheses, or hyphens. `grep -cP '\x{2014}'` should return 0 on every doc (the escape keeps this check from flagging itself).
- **PowerShell syntax** for any command shown to Jason to run himself. The Bash tool stays bash.
- **Money is `bigint` cents, durations are integer seconds.** No floats touch storage. Aggregate first, divide last (BACKEND_PRD §3.6).
- **All business logic in `src/services/`**, plain functions taking `Ctx`. Route handlers, RSC pages, and job processors are thin callers. No Server Actions.
- **Rate snapshots on entries never change** except via the explicit re-rate action.
- **Archive over delete; every destructive action gets Undo or typed confirmation.**
- **404, not 403,** for records outside the actor's scope.
- **Phase discipline:** finish the current phase's exit criterion (PRD-OVERVIEW §6) before starting the next. No speculative building from later phases.
- **Never hard-code a colour, size, radius, or duration.** Everything resolves to a token in `design system/tokens/tokens.css`. If a token is missing, add it there rather than inlining a value.
- **Every table is AG Grid Community behind the `DataGrid` wrapper**, except the invoice document, anything printed, and short fixed lists under ~20 rows. We are on the MIT edition: row grouping, aggregation, master/detail, tool panels, set filter, context menu, and Excel export are Enterprise and unavailable. The Community patterns for the first three are documented at the top of `design system/recipes/grid.ts`. Grouped list endpoints return group rows and totals from the server.
- Design tokens descend from Toado (`C:\Users\jason\Documents\GitHub\visual-debugger`, see its `app.css` and `design-system.html`). Chart palettes must pass `node scripts/validate-palette.mjs` against both surfaces.
- Theming is CSS `light-dark()` on bare `:root`, driven by `color-scheme`. Do not write `prefers-color-scheme` blocks or `[data-theme]` colour overrides.

## How it fits together

- **Run it:** `pnpm db:setup` once (Docker Postgres on 5434, Redis on 6382, migrate, seed), then `pnpm dev -p 3200`. Every seeded account shares the password `tally-dev-password`. `pnpm db:seed --force` reseeds.
- **Routes:** `/timesheet` (day, week, calendar), `/expenses`, `/approvals`, `/team` + `/team/[id]`, `/clients` + new/detail/edit, `/projects` + new/detail/edit, `/tasks`, `/invoices` + new/detail (plus recurring and retainer views), `/reports` (time, profitability, team, invoicing), `/settings`, `/signin`.
- **`src/lib/api.ts` is the seam, and it is the only file that speaks HTTP.** It unwraps the `{ data, meta }` envelope, turns `application/problem+json` into an `ApiError` with the server's code and field errors, and adapts between the two vocabularies: `null` on the wire is `undefined` in the UI, `avatarKey` becomes `photo`, `profileId` becomes a profile name. No component knows a wire shape.
- **`src/server/http.ts` is the seam on the other side.** Every mutating request runs in a transaction whose commit also writes the audit rows and outbox events, every route declares a rate-limit class, idempotency claims its key before the handler runs, and mutations are refused from another origin. A service cannot opt out of being audited.
- **Capabilities come from the server.** `useCan()` reads the set the bootstrap returns, which the API computed from the same constant it gates on, so a button cannot appear for an action the request would refuse. Before the bootstrap lands the set is empty, so the shell renders its floor rather than flashing controls and taking them away.
- **Money is aggregated then divided, on both sides.** `sumValue` and `ValueAccumulator` in `src/lib/derive.ts` do what `ROUND(SUM(seconds * rate) / 3600)` does in SQL. Rounding per row and adding the results drifts in one direction, and the client and the server would disagree by a growing number of cents.
- **Forms that edit an existing record wait for it.** Field state initialises once from the record, so an editor must not mount until the record is in hand, or a cold load shows a blank form and saves the blanks. See `ClientEditor` / `ProjectEditor`. On save they seed the cached bootstrap and then navigate, rather than awaiting a refetch in front of the redirect.
- **Column types come from the app, not the design system** (`DataGrid` builds them): duration formatting is an account setting and money formatting depends on the row's currency. Custom cell renderers never run on the pinned totals row. Export writes what is on screen to CSV through AG Grid Community.
- **Security scripts live in the repo:** `pnpm authz:sweep` prints the profile-by-endpoint matrix, `pnpm authz:scope` checks that a Member gets only their own rows and none of the money. Both create their own accounts and clean up. The Playwright route sweep and interaction pass are in the session scratchpad.

## Reference material

- Harvest UI screenshots that drove the spec: `C:\Users\jason\Downloads\harvest screenshots` (captured 2026-08-13).
- Palette validator: `scripts/validate-palette.mjs` (usage: `node scripts/validate-palette.mjs "#hex,#hex,..." --mode light|dark --surface "#hex"`).

## Current focus snapshot

**Last updated:** 2026-08-14. Maintain this section manually.

- Backend and wiring complete. E0 through E13 in [docs/BUILD_EPICS.md](docs/BUILD_EPICS.md) are ticked. Handed to Jason for testing.
- Not built, each waiting on a credential rather than on a decision about scope: Google SSO, email delivery, receipt and PDF storage, the deployment, and running the Harvest import against real data. [docs/PERMISSIONS-AND-CREDENTIALS.md](docs/PERMISSIONS-AND-CREDENTIALS.md) says what does not work until each arrives.
- Deliberately disabled in the UI rather than faked: the full account export, CSV import, and the integration connect buttons. Per-grid CSV export does work.
- Open decisions parked for Jason: final product name ("Tally" is a placeholder), droplet size (4 vCPU/8 GB proposed), whether contractors keep password auth or everyone lands in Workspace, and whether invoice numbering continues Harvest's sequence.
- **Two adversarial reviews found real defects, and their lesson is worth keeping:** every money bug was a violation of a rule stated in prose at the top of a file and asserted nowhere executable. `tests/invoices.test.ts` now asserts the three invariants that were being broken: a preview equals the invoice it produces, stored totals equal the sum of the stored lines, and a retainer's balance equals the sum of its transactions. Add to that list rather than adding another comment.
