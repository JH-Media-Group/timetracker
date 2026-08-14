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

- [x] `Ctx`, transaction wrapper, injectable clock
- [x] Buffered audit and outbox, flushed inside the transaction
- [x] Error taxonomy and RFC 9457 problem responses with a closed `code` union
- [x] Capability set, base profile mapping, `assertCan`
- [x] Scope predicates composed into SQL, not applied after the fetch
- [x] Serializers with field redaction for cost and billable rates
- [x] Idempotency key handling
- [x] Route helper that turns a service call into a response, uniformly

## E4. Authentication

- [x] Session table, cookie session, argon2id password hashing
- [x] Sign in, sign out, session rotation, absolute cap
- [x] `/api/v1/me`, `/api/v1/me/capabilities`
- [x] Middleware that rejects unauthenticated API calls and redirects unauthenticated pages
- [ ] Google Workspace OIDC wired but inert until credentials arrive (permission item)

## E5. Reference and organize API

- [x] `/settings`
- [x] `/users`, rates, roles, departments, permission profiles
- [x] `/clients` and contacts
- [x] `/projects`, project tasks, members, tags, pin and unpin
- [x] `/tasks` library with common-task propagation
- [x] `/expense-categories`
- [x] `/search` backing the command palette
- [x] `/bootstrap` for the app shell

## E6. Time API

- [x] `GET|POST /time-entries`, `GET|PATCH|DELETE /:id`, restore
- [x] `/:id/start`, `/:id/stop`, running-entry resolution with the stop-then-insert transaction
- [x] `/:id/split`, `/:id/duplicate`
- [x] `/timesheet/copy-day`
- [x] `PUT /timesheet/week` diffing upsert that skips locked rows
- [x] `GET /timesheet/summary`

## E7. Expenses and approvals API

- [x] Expenses CRUD and reimbursement state transitions
- [x] Approvals: submit, approve, request changes, flags, `/approvals/me`

## E8. Invoices API

- [x] Invoice CRUD with the numbering sequence drawn under row lock
- [x] `POST /invoices/preview-lines` generating lines from uninvoiced time and expenses
- [x] State machine endpoints: mark sent, write off, close, duplicate
- [x] Payments, including void and the paid/open transition
- [x] Recurring invoices and retainers with the draw ledger

## E9. Reports API

- [x] `/reports/time` with grouping and server-computed group rows and totals
- [x] `/reports/profitability`
- [x] `/reports/team`
- [x] `/reports/invoicing` with aging buckets
- [x] `/projects/:id/summary` and `/projects/:id/chart`

## E10. Seed

- [x] Deterministic JHMG-shaped seed writing to Postgres, matching the shape the front end was built against

## E11. Frontend wiring

- [x] `src/lib/api.ts` rewritten to `fetch` the real API, signatures unchanged
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

1. **Google Workspace SSO credentials.** `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` for an OAuth client with `https://<host>/api/v1/auth/google/callback` as a redirect URI, and confirmation that `jhmediagroup.com` is the domain to pin. Until these exist the sign-in page offers password only, and the Google button stays hidden rather than leading to a configuration error.
