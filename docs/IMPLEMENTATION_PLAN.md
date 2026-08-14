# Tally - Implementation Plan

Ordered build plan. Each numbered item is a mergeable unit of work with its own verification. Do them in order; the ordering encodes the dependencies. Phase exit criteria live in [PRD-OVERVIEW.md §6](PRD-OVERVIEW.md#6-release-phases); the section-to-phase map is §6.1.

| | |
|---|---|
| Status | Phases 0 through 3 built and running against Postgres. See [BUILD_EPICS.md](BUILD_EPICS.md) for what actually shipped. |
| Updated | 2026-08-14 |

Mark items `[x]` as they land and add the commit SHA. This file is the working state that travels between sessions.

---

## Where we actually are

The build did not follow this plan's ordering. The front end was built first against a mock API, then the backend was built in one pass as the E0 to E13 epics in [BUILD_EPICS.md](BUILD_EPICS.md), and the two were joined at the `src/lib/api.ts` seam. **BUILD_EPICS.md is the accurate record of what exists.** This file is now the forward plan: what is left.

**An earlier version of this section overclaimed in five places and understated in one, and was caught by an adversarial review against the code rather than against itself.** The list below has been checked endpoint by endpoint. Where something is half-built, it says which half, because "built" covering a read-only endpoint is how TALLY-13 came to be filed as a missing screen when it is a missing endpoint.

**Built and working**

- **Phase 0 except CI.** Repo, scaffold, tokens, the `DataGrid` wrapper, the local Postgres and Redis stack, migrations, and a deterministic server-side seed. Item 0.4 is *not* done: there is no `.github/` directory, so the typecheck, lint, test, palette and em-dash gates run only when somebody runs them by hand.
- **Phase 1 except three things.** The Harvest import waits on the export, Google SSO waits on OAuth credentials, and item 1.7's SSE stream was never written: reconciliation between tabs is a 30-second poll (`src/components/app/timer.tsx`), so 1.7's "two tabs reconcile within a second" cannot pass as stated.
- **Phase 2 except alerts.** Rates, budgets, project detail, expenses, approvals, and the profitability, team and invoicing reports. There is no separate contractor report; contractor is a scope inside the Team report.
- **Phase 3 core.** Invoices end to end, payments, the invoicing report, and the retainer ledger with its draw-at-send.

**Half-built, and the half that is missing**

- **Budget alerts (2.2).** `budgetAlertPercent` is stored, editable and serialized, and read by nothing. No job compares it to spend and no notification exists. The UI offers to alert you and will not. Worse than unbuilt, because it promises.
- **Retainers (3.7).** The ledger, balance, draw and reversal are built and tested. `/api/v1/retainers` exports `GET` only, so a retainer cannot be created through the API at all. This is TALLY-13, and it is an endpoint, not just a screen.
- **Recurring invoices (3.6).** Same shape: `GET` only, no create.
- **Invoice configuration (3.8).** The six settings columns exist in the schema and are served by the settings API. There is no invoicing section in the settings UI; the page has eight sections and none of them is it.
- **Bulk actions (4.1).** The opposite drift: these were listed as not started and the UI is built and working across seven list pages, with a `bulk_action_runs` table and a `bulk:execute` capability. What is missing is the server-side registry the backend PRD specifies.

**Not started**

Phase 1.5 (offline queue, calendar drag-create, Google Calendar overlay, mobile Track), the rest of Phase 4 (import/export, saved reports, audit log UI, Slack, the droplet), QuickBooks, Stripe, and PDF rendering. Note that PDF *generation* is unbuilt, not merely PDF storage: Playwright is not a dependency. "Print or save as PDF" uses the browser's own dialog.

The seam is still one file. Every service the front end calls goes through `src/lib/api.ts`, and nothing else in the app speaks HTTP.

---

## Phase 0 - Bootstrap

- [ ] **0.1 Repo init.** `git init`, `.gitignore` (node, next, env, IDE), MIT-less private license note, README pointing at the docs.
- [ ] **0.2 Scaffold.** Next.js 15 + TypeScript strict + Tailwind v4 + pnpm. `src/` layout per [BACKEND_PRD.md §2](BACKEND_PRD.md#2-repository-layout). ESLint (with the `dangerouslySetInnerHTML` ban), Prettier, `pnpm typecheck` script.
- [ ] **0.3 Tokens and theme.** Copy the five shipping files from [`design system/`](../design%20system/README.md) into `src/styles/` and `src/components/ui/` per its porting checklist, add `class-variance-authority clsx tailwind-merge`, wire `THEME_INIT_SCRIPT` into `<head>`, build the theme toggle. Verify: no flash of wrong theme under either OS setting, and `bg-surface` resolves correctly in both themes without a `dark:` variant.
- [ ] **0.35 Grid foundation.** `pnpm add ag-grid-community ag-grid-react`, copy `ag-grid-theme.ts` and `ag-grid-overrides.css`, register modules at boot, build the `DataGrid` wrapper against the props contract in `design system/recipes/grid.ts` (card frame, toolbar, column picker, density, bulk bar, pinned totals, our own empty and loading states). Verify: the grid chunk is lazy and absent from the initial bundle; the grid renders correctly in both themes with no dark-mode code. Everything downstream that lists anything depends on this, so it lands before the first list page.
- [ ] **0.4 CI skeleton.** GitHub Actions: typecheck, lint, unit, integration (Postgres service container), build. Wire `node scripts/validate-palette.mjs` for both modes as a build gate. Wire the em-dash check (`grep -cP '\x{2014}' docs/*.md` must return 0; the escape keeps the check from flagging itself).
- [ ] **0.5 Local stack.** `docker/compose.dev.yml` with Postgres 16 + Redis 7. `scripts/migrate.ts` runner. Migration `0001`: extensions (`citext`, `btree_gist`) plus the Phase 1 tables below.
- [ ] **0.6 Seed.** `scripts/seed.ts` per [BACKEND_PRD.md §19](BACKEND_PRD.md#19-testing): deterministic JHMG-shaped dataset. Every test layer depends on this; build it before any feature.

## Phase 1 - Dogfood minimum

*Exit: Jason tracks a full week and totals match Harvest.*

- [ ] **1.1 Schema, first slice.** `users`, `permission_profiles`, `roles`, `departments`, `clients`, `client_contacts`, `projects`, `tags`, `tasks`, `project_tasks`, `project_members`, `user_pinned_projects`, `user_rates`, `time_entries`, `settings`, `audit_log`, `outbox`, `idempotency_keys`, `api_tokens`, `notifications`, Auth.js session tables. Constraints are the point: the running-timer partial unique index and the rate-overlap exclusion go in now, with integration tests proving the DB rejects violations.
- [ ] **1.2 Service kernel.** `Ctx`, transaction wrapper, buffered audit + outbox flush, error taxonomy, Zod schema plumbing, serializer with capability redaction. This is the chassis; every later service is a passenger.
- [ ] **1.3 Domain: money and duration.** `src/domain/` money helpers, duration parser and formatter, calendar-day resolution, per-group rounding. 100% branch coverage before moving on ([BACKEND_PRD.md §4.1-4.4](BACKEND_PRD.md#4-domain-rules)).
- [ ] **1.4 Auth.** Google OIDC with `hd` pin, session middleware, capability loading, the six base profiles seeded. Invites and password auth are Phase 1.5; until then every user is SSO.
- [ ] **1.5 App shell.** Top bar, sidebar with permission-aware sections, page header pattern, toast system, error boundaries. No command palette yet.
- [ ] **1.6 Organize CRUD.** Clients (list, new, edit, archive guard), Tasks (library with common-task propagation), Projects (list grouped by client, editor with type/bill-by/budget panels, member and task assignment), Team (members list, person settings: basic info, assigned projects, permissions). Rate resolution runs but returns 0 + `rate_missing` until Phase 2 populates rates.
- [ ] **1.7 Timer + Day view.** `services/time` CRUD, start/stop with the stop-then-insert transaction, `GET /timesheet/summary`, SSE stream carrying `timer.*` events, timer widget, Day view with inline editor, quick timer popover, copy-from-previous-day. Verify acceptance: cold load to running timer in four keystrokes; two tabs reconcile within a second.
- [ ] **1.8 Harvest import.** `scripts/harvest-import.ts` per [BACKEND_PRD.md §16](BACKEND_PRD.md#16-harvest-migration), including `billed_externally` from Harvest's `is_billed` and the six reconciliation checks. Output the reconciliation report to `docs/migration/`. This lands *before* the Time report so the report has real data to prove itself against.
- [ ] **1.9 Time report, read-only.** Summary band + Clients/Projects/Tasks/Teammates tabs + detailed view, ETag caching. Verify: figures match Harvest for the same filters.
- [ ] **1.10 Phase gate.** Run the Phase 1 acceptance subset (FRONTEND §20 items 1-3, 6-7, 9; BACKEND §20 items 2, 6-9, 15). Jason dogfoods for one week.

## Phase 1.5 - Daily driver

- [ ] **1.5.1 Week view** with duration-cell editing in both timer modes and inferred-time marking.
- [ ] **1.5.2 Calendar view**: drag-create, move, resize; Google Calendar per-user OAuth + ghost-event overlay + "Track this".
- [ ] **1.5.3 Command palette + shortcut map** (registry-driven `?` sheet).
- [ ] **1.5.4 Offline queue**: IndexedDB, `Idempotency-Key` replay, reconnect banner. Verify acceptance 10 (three offline entries, exactly three after reconnect).
- [ ] **1.5.5 Mobile Track** per FRONTEND §5.7 + invites/password auth for contractors.
- [ ] **1.5.6 Nightly Harvest diff job** while both tools run.

## Phase 2 - Review

- [ ] **2.1 Rates** (dated CRUD UI, resolution live, re-rate job). Once real rates exist, run the re-rate job over the Phase 1 dogfood window so entries snapshotted at zero pick up true rates; Harvest-imported entries already carry their historical snapshots and are not touched. **2.2 Budgets + alerts.** **2.3 Project detail page** (summary endpoint, two charts, tabs). **2.4 Expenses** (CRUD, receipts via presigned upload, categories, reimbursement queue). **2.5 Approvals** (submit covering time + expenses, review, period locks, flags, reminders; mobile per §7.3). **2.6 Profitability, Team, Contractor reports** (missing-rate fix-it drawer included). **2.7 Phase gate:** one full approval cycle; profitability for last quarter answered without Harvest.

## Phase 3 - Bill

- [ ] **3.1 Invoice core** (schema slice, totals engine, numbering, state machine with send-time revalidation). **3.2 Editor** (add-from-tracked-time drawer, project fee lines). **3.3 Document + PDF + pay page** (one component, three consumers; Playwright chromium in worker). **3.4 Send + payments + history.** **3.5 Stripe pay page + webhooks.** **3.6 Recurring invoices.** **3.7 Retainers** (draw-at-send + reversals). **3.8 Invoice configuration** (all seven sections). **3.9 QuickBooks sync + reconcile.** **3.10 Invoicing report.** **3.11 Security review** against OWASP ASVS L2 before real invoices go out. **3.12 Phase gate:** one full month invoiced with no Harvest fallback.

## Phase 4 - Cutover

- [ ] **4.1 Bulk actions registry + UI. 4.2 Import/export + revert. 4.3 Saved reports + builder + scheduled delivery. 4.4 Audit log UI. 4.5 Slack integration. 4.6 Production droplet** (compose, Caddy, backups + weekly restore verification, Sentry, uptime check). **4.7 Cutover runbook:** freeze Harvest, delta import, verify, switch, 60-day read-only, cancel.

---

## Standing rules while building

1. Every item lands with its tests; the domain items land with exhaustive tests first.
2. Update this file and the CLAUDE.md focus snapshot in the same commit as the work.
3. When implementation forces a deviation from a PRD, amend the PRD in the same commit and say why in the commit message.
4. Nothing from a later phase gets built speculatively.
