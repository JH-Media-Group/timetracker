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
- [x] Google Workspace OIDC deferred until credentials arrive, and the button suppressed rather than leading to a 404 (permission item)

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
- [x] Sign-in page and the authenticated shell
- [x] Capabilities read from the server rather than from a copy of the profile table
- [x] Error and loading states wired to the real failure modes: a network failure reads as one, a 401 signs out and redirects once, a bootstrap failure says so rather than rendering an empty account
- [x] Client-side money aggregates the products and divides once, like the server
- [x] Playwright pass over every route against the real backend: 27 routes, both themes, no console errors, no failed requests, no horizontal overflow
- [x] Interaction pass: 27 mutating flows driven through the UI and verified through the API

## E12. Cosmetic sweep

- [x] Static scan for interactive elements with no handler
- [x] Static scan for handlers whose only effect is a toast
- [x] Automated Playwright sweep clicking every control on every route and watching for a request, a navigation, or a DOM change
- [x] Each finding either wired up or disabled with the reason on the control
- [x] Sweep re-run and diffed against the previous pass

## E13. Final security sweep

- [x] Authorization matrix test across the base profiles (`tests/authz.test.ts`, 30 tests)
- [x] Security headers: CSP, HSTS, frame-ancestors, nosniff, referrer policy, permissions policy
- [x] Open redirect on the sign-in `next` parameter closed
- [x] Origin check on every mutating request, on top of SameSite and the JSON preflight
- [x] Session review: httpOnly, secure in production, SameSite=Lax, rolling and absolute expiry, revocation clears the cookie
- [x] Injection review: no unparameterised interpolation, one `dangerouslySetInnerHTML` (the theme initialiser, a constant)
- [x] Secrets review: no secrets tracked, `.env.*` ignored, the dev password lives only in the seed and is printed with a warning
- [x] Dependency audit clean (five advisories pinned out through overrides)
- [x] Permissions and credentials list handed over ([PERMISSIONS-AND-CREDENTIALS.md](PERMISSIONS-AND-CREDENTIALS.md))
- [x] Three adversarial reviews (two Claude, one Codex) applied in full
- [x] `tests/routes.test.ts`: every route declares a capability or names itself, with a reason, in an exemption list
- [x] `pnpm db:invariants`: ten data invariants checked against the database rather than against the code
- [x] Verified against a production build, not the dev server: the strict CSP with its per-request nonce, 27 routes in both themes, 27 interaction flows, the profile matrix and the scope probe

### What the final review found, and what it changed

The reviews were worth more than the tests. Between them they found a Member
able to read the company's cost base from an ungated project summary, a lost
update on `paid_cents` under concurrent payments, a retainer left over-drawn by
an invoice edit, an idempotency mechanism that deduplicated nothing because the
client generated a fresh key per call, an open redirect that survived a
leading-slash check because URL parsing strips tabs and newlines first, and a
Content-Security-Policy whose comment described a nonce it did not have.

The pattern underneath them is the one worth carrying forward: **every defect
was a rule stated in prose and asserted nowhere executable.** Comments had
drifted from the code, always in the flattering direction. So the response was
not only to fix them but to make the rules countable: `tests/routes.test.ts` for
the capability gate, `tests/invoices.test.ts` for the money invariants,
`tests/env.test.ts` for the environment schema, and `scripts/invariants.mts` for
the data. When adding a rule to this codebase, add the thing that checks it in
the same commit.

---

## Known limits, written down rather than discovered

Deliberate, measured, and left as they are because the fix is available when the
number moves rather than because nobody noticed.

- ~~The four report pages compute their figures in the browser.~~ **Fixed.**
  They read `/api/v1/reports/*`. It began as a bandwidth note (a year of entries
  was 1.2 MB against 7 to 11 KB for the grouped answer) and became a correctness
  one: three of the four disagreed with the server, most seriously profitability,
  which showed $[private total removed] profit for August where the API said $[private total removed], because the
  client treated a fixed fee as its full value rather than recognising it across
  the project window.

- **Collections are capped rather than paginated.** Invoices at 1,000, expenses
  at 5,000, approvals at 500. Each route fetches one row past its cap and
  reports `meta.hasMore`, and the client surfaces that, so a truncated list can
  never read as a complete one. Real pagination waits until a list actually
  reaches its cap.

- **The endpoints in BACKEND_PRD section 6.2 that are not built** are the ones
  that need a credential (receipt upload, PDF, email sends) plus saved reports,
  custom reports, and the export queue. Nothing that is built is missing a
  route; nothing has a route that is a stub.

## Permissions and credentials needed

Collected as they come up; nothing here blocked the build. The full version,
with what does not work until each arrives, is
[PERMISSIONS-AND-CREDENTIALS.md](PERMISSIONS-AND-CREDENTIALS.md).

1. **Google Workspace SSO credentials.** `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` for an OAuth client with `https://<host>/api/v1/auth/google/callback` as a redirect URI, and confirmation that `jhmediagroup.com` is the domain to pin. Until these exist the sign-in page offers password only, and the Google button stays hidden rather than leading to a configuration error.
