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
- **Status (2026-08-14):** PRDs v1.1, design system complete, and the **whole front end is built and running against a mock API**. `pnpm dev -p 3200` opens it. Every route renders clean in both themes; `next build` passes. No backend yet: `src/lib/api.ts` is the only file that knows it is missing.
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

## The front end as it stands

- **Run it:** `pnpm dev -p 3200` (or `npx next dev -p 3200`). Sample data seeds itself into `localStorage`; Settings, Import and export, Reset the sample data puts it back.
- **Routes:** `/timesheet` (day, week, calendar), `/expenses`, `/approvals`, `/team` + `/team/[id]`, `/clients` + new/detail/edit, `/projects` + new/detail/edit, `/tasks`, `/invoices` + new/detail (plus recurring and retainer views), `/reports` (time, profitability, team, invoicing), `/settings`.
- **`src/lib/api.ts` is the seam.** Every function returns a Promise over an in-memory store. Swapping to the real `/api/v1` means rewriting the bodies; no signature and no component changes.
- **Responses are cloned, never handed out live** (`clone()` in `api.ts`). Returning a live reference into the store mutates the object already inside the React Query cache, structural sharing then sees no change, and a record you just created renders as "not found". A real `fetch` returns fresh objects, so the mock does too.
- **Forms that edit an existing record wait for it.** Field state initialises once from the record, so an editor must not mount until the record is in hand, or a cold load shows a blank form and saves the blanks. See `ClientEditor` / `ProjectEditor`.
- **Column types come from the app, not the design system** (`DataGrid` builds them): duration formatting is an account setting and money formatting depends on the row's currency. Custom cell renderers never run on the pinned totals row.
- **Verification scripts** used while building are in the session scratchpad, not the repo: a route sweep (both themes, checks for page errors and horizontal overflow), an interaction pass, and the mechanical no-shift check across all seven tables.

## Reference material

- Harvest UI screenshots that drove the spec: `C:\Users\jason\Downloads\harvest screenshots` (captured 2026-08-13).
- Palette validator: `scripts/validate-palette.mjs` (usage: `node scripts/validate-palette.mjs "#hex,#hex,..." --mode light|dark --surface "#hex"`).

## Current focus snapshot

**Last updated:** 2026-08-14. Maintain this section manually.

- Front end complete against the mock API and handed to Jason for testing. Next: his feedback, then the backend (BACKEND_PRD, starting with schema and the services layer).
- Not built yet, deliberately: real auth, the PDF renderer, email, the job queue, integrations beyond the settings placeholders, and the Harvest import itself (the UI for it exists).
- Open decisions parked for Jason: final product name ("Tally" is a placeholder), droplet size (4 vCPU/8 GB proposed), whether contractors keep password auth or everyone lands in Workspace.
