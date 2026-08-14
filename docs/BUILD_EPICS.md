# Tally - backend build epics

The working checklist for the backend build and the frontend wiring. Tick items as they land. Each epic ends with an adversarial review sweep (Claude and Codex, looking for correctness, security, maintainability, and code quality), a "would a senior developer be impressed" pass, and a commit.

| | |
|---|---|
| Started | 2026-08-14 |
| Method | Epic, sweep, fix, commit. No permission prompts mid-build; blockers are collected in [Permissions and credentials needed](#permissions-and-credentials-needed). |

---

## E0. Foundations

- [x] Git repository initialised with a `.gitignore` that covers node, Next, env files, and the local database volume
- [x] Backend dependencies added (Drizzle, postgres driver, Zod, argon2, Redis, BullMQ, Vitest)
- [x] `docker/compose.dev.yml`: Postgres 16 on 5434 and Redis 7 on 6382, both chosen to dodge the containers already running on this machine
- [x] Typed environment config that fails loudly at boot on a missing variable
- [x] `drizzle.config.ts`, migration runner, and the `db:*` package scripts
- [x] Vitest configured with a separate test database

## E1. Schema and migrations

- [x] Drizzle schema for identity and people (§3.1), including the dated `user_rates` range
- [x] Clients and projects (§3.2)
- [x] Time and expenses (§3.3)
- [x] Invoicing (§3.4)
- [x] Platform tables (§3.5)
- [x] Migration `0001` with `citext` and `btree_gist`, every partial index, the one-running-timer index, and the rate-overlap exclusion constraint
- [x] Constraint tests: the database itself rejects two running timers and overlapping rates

## E2. Domain layer

- [x] Money: cents arithmetic, `roundHalfEven`, invoice total pipeline in the fixed order (§4.1)
- [x] Duration: parse, format, range parse (§4.2)
- [x] Rounding applied per aggregated group, never per entry (§4.3)
- [x] Calendar day resolution in the subject's timezone (§4.4)
- [x] Rate resolution, the five-step billable ladder and the independent cost rate (§4.5)
- [x] Budgets: unit and grain by `budget_by`, monthly reset window, health thresholds (§4.6)
- [x] Profitability: cost, revenue by billing type, fee recognition and allocation (§4.7)
- [x] Invoice state machine transitions (§4.8)
- [x] `canEdit` predicate covering all four locks (§4.10)
- [x] `uninvoiced` predicate (§4.11)
- [x] Unit tests with full branch coverage on money, duration, and rates

## E3. Service kernel

- [ ] `Ctx`, transaction wrapper, injectable clock
- [ ] Buffered audit and outbox, flushed inside the transaction
- [ ] Error taxonomy and RFC 9457 problem responses with a closed `code` union
- [ ] Capability set, base profile mapping, `assertCan`
- [ ] Scope predicates composed into SQL, not applied after the fetch
- [ ] Serializers with field redaction for cost and billable rates
- [ ] Idempotency key handling
- [ ] Route helper that turns a service call into a response, uniformly

## E4. Authentication

- [ ] Session table, cookie session, argon2id password hashing
- [ ] Sign in, sign out, session rotation, absolute cap
- [ ] `/api/v1/me`, `/api/v1/me/capabilities`
- [ ] Middleware that rejects unauthenticated API calls and redirects unauthenticated pages
- [ ] Google Workspace OIDC wired but inert until credentials arrive (permission item)

## E5. Reference and organize API

- [ ] `/settings`
- [ ] `/users`, rates, roles, departments, permission profiles
- [ ] `/clients` and contacts
- [ ] `/projects`, project tasks, members, tags, pin and unpin
- [ ] `/tasks` library with common-task propagation
- [ ] `/expense-categories`
- [ ] `/search` backing the command palette
- [ ] `/bootstrap` for the app shell

## E6. Time API

- [ ] `GET|POST /time-entries`, `GET|PATCH|DELETE /:id`, restore
- [ ] `/:id/start`, `/:id/stop`, running-entry resolution with the stop-then-insert transaction
- [ ] `/:id/split`, `/:id/duplicate`
- [ ] `/timesheet/copy-day`
- [ ] `PUT /timesheet/week` diffing upsert that skips locked rows
- [ ] `GET /timesheet/summary`

## E7. Expenses and approvals API

- [ ] Expenses CRUD and reimbursement state transitions
- [ ] Approvals: submit, approve, request changes, flags, `/approvals/me`

## E8. Invoices API

- [ ] Invoice CRUD with the numbering sequence drawn under row lock
- [ ] `POST /invoices/preview-lines` generating lines from uninvoiced time and expenses
- [ ] State machine endpoints: mark sent, write off, close, duplicate
- [ ] Payments, including void and the paid/open transition
- [ ] Recurring invoices and retainers with the draw ledger

## E9. Reports API

- [ ] `/reports/time` with grouping and server-computed group rows and totals
- [ ] `/reports/profitability`
- [ ] `/reports/team`
- [ ] `/reports/invoicing` with aging buckets
- [ ] `/projects/:id/summary` and `/projects/:id/chart`

## E10. Seed

- [ ] Deterministic JHMG-shaped seed writing to Postgres, matching the shape the front end was built against

## E11. Frontend wiring

- [ ] `src/lib/api.ts` rewritten to `fetch` the real API, signatures unchanged
- [ ] Sign-in page and the authenticated shell
- [ ] Error and loading states wired to the real failure modes
- [ ] Playwright pass over every route against the real backend

## E12. Cosmetic sweep

- [ ] Automated sweep listing every control that does nothing, run repeatedly until it comes back empty
- [ ] Each finding either wired up or deliberately marked as out of scope with a reason

## E13. Final security sweep

- [ ] Authorization matrix test across the base profiles
- [ ] Injection, session, and secrets review
- [ ] Dependency audit
- [ ] Permissions and credentials list handed over

---

## Permissions and credentials needed

Collected as they come up; nothing here blocked the build.

_(none yet)_
