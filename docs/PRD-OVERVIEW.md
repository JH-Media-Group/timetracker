# Tally - Product Overview PRD

**Internal time tracking, project profitability, and invoicing for JH Media Group.**

| | |
|---|---|
| Status | Draft v1.1 (review pass applied 2026-08-13: 18 fixes, see git history) |
| Owner | Sample Person01 |
| Date | 2026-08-13 |
| Audience | Example Internal only. Not a commercial product. |
| Companion docs | [FRONTEND_PRD.md](FRONTEND_PRD.md) - [BACKEND_PRD.md](BACKEND_PRD.md) - [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) |

> **Name note.** "Tally" is a working codename used throughout these docs. Swap it for whatever ships; it appears only in the brand mark, page titles, and the `TALLY_*` env prefix.

---

## 1. Why we are building this

JHMG currently runs on Harvest. Account size, staff details, invoice totals, and usage metrics are private operational data. Harvest does the job, but:

1. **We pay per seat forever** for a workflow we fully understand and could own.
2. **The parts we actually need are a subset.** Peppol e-invoicing, Stripe-funded reimbursements, seat-limit upsells, Forecast cross-sells, and the "What's new" feed are noise for an 11-person shop.
3. **The parts we need most are the weakest.** Week view is disabled entirely when the account uses start/end timer mode. There is no approvals loop for a contractor-heavy roster. The project picker is slow. There is no command palette, no keyboard-first path, and no live view of who is tracking right now.
4. **Profitability is where the value is,** and it depends on cost rates, billable rates, and fixed-fee allocation rules that we want to control and extend (for example: per-role blended rates, retainer burn-down against tracked hours).

The goal is a tool that a contractor can use in fifteen seconds a day, and that gives Jason a truthful, real-time read on where money is being made and lost.

## 2. Product principles

These are the tie-breakers when two designs are both defensible.

1. **Logging time must cost the user nothing.** Every second of friction is multiplied by 11 people times 250 days. The timer is always one keystroke away, from any page.
2. **Never lose a keystroke.** Autosave everywhere, optimistic writes, an offline-tolerant timer, and a visible "Saved" state. The user should never wonder whether something stuck.
3. **Keyboard-first, mouse-complete.** A command palette plus a documented shortcut map. Nothing is keyboard-only, nothing is mouse-only.
4. **Show the number, then the breakdown.** Every screen leads with the figure that matters and lets you drill down, never the other way around.
5. **Destructive actions are reversible.** Archive over delete. Toast-with-Undo on every mutation that removes data. A hard delete requires typed confirmation and writes an audit row.
6. **Money is exact.** Integer minor units, no floats, snapshotted rates, and an explicit re-rate action when history should change.
7. **Fast by default.** Sub-200ms interaction feedback, sub-1s report loads at our data volumes. We control the whole stack and only serve eleven people; there is no excuse.

## 3. Users and permission profiles

Six base profiles, mirroring what JHMG already relies on, plus custom profiles.

| Profile | Can do | Cannot do |
|---|---|---|
| **Member** | Track time and expenses on assigned projects. See own reports. | See other people's time, rates, invoices, or settings. |
| **Project Manager** | Manage projects, clients, and tasks. View and edit time and expenses for their team. Approve timesheets for people they manage. | Rates, invoices, people admin, account settings. |
| **People Admin** | Manage people and all time entries and expenses account-wide. Run the approvals queue. | Rates, invoices, account settings. |
| **Accounting** | Manage invoices, expenses, and clients. View rates and all reports. | People admin, account settings. |
| **Executive Manager** | Manage time, expenses, projects, people, invoices, and reports. View rates. | Account settings. |
| **Administrator** | Everything, including account settings and integrations. | Nothing. |
| **Owner** | Administrator, plus cannot be demoted or removed by anyone else. | Nothing. |

Custom profiles start from a base profile and toggle individual capabilities. Permission checks are enforced server-side on every request; the UI only hides what the server would refuse. See [BACKEND_PRD.md §7](BACKEND_PRD.md#7-authentication-and-authorization) for the full capability matrix.

Two orthogonal taxonomies sit alongside profiles, both purely organisational:

- **Roles** (Designer, Developer, Project Manager, QA, Writer, ...) - used for filtering, grouping, and blended-rate reporting.
- **Departments** - used for filtering and department-level rollups.

And one employment flag: **employee vs contractor**, which drives the Team page grouping and the contractor cost report.

## 4. Scope

### 4.1 In scope for v1

**Track**
- Timesheet with Day, Week, and Calendar views
- Running timer with start/stop, duration entry, and start/end-time entry
- Track on behalf of a teammate (permission gated)
- Copy from previous day, duplicate entry, drag-to-create in calendar
- Google Calendar event import into a time entry
- Expenses with categories, unit-priced categories (mileage), receipts, and billable flag

**Review**
- Weekly timesheet submission and approval loop
- Time report (clients / projects / tasks / teammates) with billable split and uninvoiced amount
- Profitability report (clients / projects / team / tasks) with revenue, cost, profit, margin, return on cost
- Contractor cost and utilization report
- Uninvoiced / receivables report
- Detailed time and expense reports, custom report builder, saved reports

**Organize**
- Clients with contacts, currency, payment terms, tax, and discount defaults
- Projects: Time and Materials, Fixed Fee, Non-billable; budgets by hours or fees at project/task/person grain; monthly resetting budgets; over-budget email alerts; tags; project codes; per-project task list and team with rate overrides
- Global task library with common tasks auto-added to new projects
- People: capacity, roles, departments, dated billable-rate and cost-rate history, project assignment, permissions, notifications

**Bill**
- Invoices: draft, sent, late, paid, written off; line items; taxes; discounts; PO numbers; attachments; payment recording; PDF and print; branded template; client-facing pay page
- Generate an invoice from uninvoiced hours, expenses, or a project fee
- Recurring invoices with schedules, pause/resume, and generated-invoice history
- Retainers with add-funds and draw-down against invoices
- Invoice email templates (invoice / reminder / thank you) with variables
- Invoice numbering rules and per-client prefixes

**Platform**
- Light and dark themes (see [FRONTEND_PRD.md §2](FRONTEND_PRD.md#2-design-foundations))
- Command palette and full keyboard shortcut map
- Real-time updates (running timers, approvals, invoice status) over SSE
- Bulk actions across people, projects, clients, tasks, invoices, time entries, expenses
- CSV import and export, with revert for imports
- Audit log on every mutation
- Integrations: Google Workspace SSO, Google Calendar, QuickBooks Online, Slack, Stripe (client card/ACH payment of invoices)
- Personal access tokens for scripts and Zapier

### 4.2 Explicitly out of scope

| Not building | Why |
|---|---|
| Multi-tenancy, signup, plans, seats, billing | Single tenant. One company, one database. |
| Peppol / UBL e-invoicing | US-only client base. Revisit if that changes. |
| In-app reimbursement payouts (Stripe Connect) | Payroll and expense reimbursement stay in the existing accounting flow. We mark reimbursable and export. |
| Resource scheduling / capacity planning (Forecast equivalent) | Real product on its own. Phase 3 candidate. Capacity is captured per person so the data is ready. |
| Estimates and proposals | Handled elsewhere today. Phase 3 candidate; the invoice engine is designed so estimates are a thin variant. |
| Native mobile apps | Responsive web covers it. Add to Home Screen with a web app manifest. |
| Xero, ClickUp, Jira, Trello, Zendesk, Basecamp, Notion, Linear, Monday integrations | Not used by JHMG. The integration layer is generic so any of these is a later add. |
| Browser extension for in-tool timers | Phase 3. The public API and personal access tokens make it possible. |
| Client-facing dashboard portal | Phase 3. The invoice pay page is the only client-facing surface in v1. |

### 4.3 Migration

A one-time migration from Harvest is a hard requirement, not a nice-to-have. Historical hours drive every profitability trend line. The Harvest v2 API exposes clients, contacts, projects, tasks, task assignments, user assignments, users, time entries, expenses, expense categories, invoices, invoice payments, invoice messages, and estimates. We pull all of it, including archived records, map it into our schema, and keep the Harvest ID on every row (`external_ref`) so a re-sync is idempotent and any discrepancy is traceable. See [BACKEND_PRD.md §16](BACKEND_PRD.md#16-harvest-migration).

Rate history is the sharp edge: Harvest stores dated billable and cost rates per user, and time entries carry the rate that applied at the time. We import the entry-level rates as snapshots so historical reports match Harvest exactly, and import the dated rate rows so future entries rate correctly.

## 5. Tech stack

Chosen for: one repository, one deploy, boring and well documented, and already close to what JHMG runs on the `visual-debugger` project so there is one mental model across the two codebases.

| Layer | Choice | Why |
|---|---|---|
| Framework | **Next.js 15, App Router, React 19, TypeScript strict** | Server components make the report pages (which are read-heavy and join-heavy) fast on first paint without a client waterfall. One process to deploy. |
| Styling | **Tailwind CSS v4** with CSS custom properties as the token layer | Tokens live in `:root` / `[data-theme="dark"]` exactly as in `visual-debugger/app.css`, and Tailwind consumes them. Theme swap is one attribute. |
| Components | **shadcn/ui** (Radix primitives), vendored into the repo | Accessible primitives (dialog, popover, combobox, dropdown) we own and restyle to our tokens. No runtime dependency on someone else's design decisions. |
| Client data | **TanStack Query v5** | Optimistic mutations, cache invalidation keyed by entity, and a single place to wire the SSE-driven cache updates. |
| Forms | **React Hook Form + Zod**, schemas shared with the API | One schema, validated on both sides. |
| Charts | **Recharts** with a thin `<Chart>` wrapper enforcing our specs | Composable, SVG, server-renderable shell. The wrapper is where the data-viz rules in [FRONTEND_PRD.md §2.4](FRONTEND_PRD.md#24-data-visualization) are enforced so no chart can opt out. |
| Tables | **AG Grid Community** (MIT) behind one `DataGrid` wrapper | Virtualization, column resize/reorder/pin, cell editing for the week grid, keyboard navigation, and CSV export, all solved once. One grid engine across every table means one keyboard model and one place to fix a bug. Themed entirely from our tokens. Row grouping, aggregation, and master/detail are Enterprise, so those use full-width injected rows with server-computed totals; see [FRONTEND_PRD §4.1](FRONTEND_PRD.md#41-tables). Lazy loaded per route, never in the initial bundle. |
| Dates | **date-fns** + **@date-fns/tz** | No moment. Timezone handling is explicit at every boundary. |
| ORM | **Drizzle ORM** | Typed SQL, migrations as plain SQL files, no runtime magic. Same as `visual-debugger`. |
| Database | **PostgreSQL 16** | Money as `bigint` minor units, `date` for `spent_on`, `timestamptz` everywhere else, partial unique indexes for the running-timer constraint, generated columns for report rollups. |
| Cache / queue backing | **Redis 7** | BullMQ backing store and SSE pub/sub fan-out. |
| Jobs | **BullMQ** in a separate worker process | Recurring invoices, budget alerts, reminder emails, PDF rendering, QuickBooks sync, imports, exports, bulk actions. |
| Auth | **Auth.js v5 (NextAuth)** with Google Workspace OIDC (hosted-domain pinned) plus invite-based email + password (argon2id) for external contractors | Employees use SSO. Contractors outside the Workspace get an invite link. |
| Email | **Resend** (or Postmark) with React Email templates | Transactional only: invites, invoice sends, reminders, approval nudges, budget alerts. |
| PDF | **Playwright (chromium)** rendering our own invoice HTML in the worker | The PDF and the on-screen invoice are literally the same template. No second renderer to keep in sync. |
| Files | **DigitalOcean Spaces** (S3 API) via presigned URLs | Receipts, logos, invoice attachments, generated PDFs. |
| Runtime | **Docker Compose** on a single DigitalOcean droplet, **Caddy** in front for automatic TLS | Five containers: `caddy`, `web`, `worker`, `postgres`, `redis`. |
| CI | **GitHub Actions**: typecheck, lint, unit, integration, Playwright e2e, build, then deploy over SSH | Push to `main` builds and rolls the droplet. |
| Testing | **Vitest** (unit + integration against a throwaway Postgres), **Playwright** (e2e) | Money math, rate resolution, and budget calculations get exhaustive unit coverage. |
| Observability | **Sentry** (errors, both runtimes), **pino** structured logs, `/healthz` and `/readyz` | Small enough that Sentry plus logs is sufficient. |

**Droplet sizing:** 4 vCPU / 8 GB / 160 GB SSD is comfortable, including the Playwright chromium for PDFs. 2 vCPU / 4 GB works if PDF rendering moves to a queue with concurrency 1.

## 6. Release phases

Phases carry no week estimates on purpose: an earlier draft attached counts that were fantasy for a part-time solo build, and a wrong number is worse than none. Each phase is scoped by its exit criterion instead, is independently shippable, and is independently useful. A section-by-section phase map is in §6.1; the feature PRDs carry matching `Phase:` tags on their section headers.

**Phase 1 - Dogfood minimum**
App shell, theming, Google SSO. Clients, projects, tasks, and people CRUD (no rates yet; rate columns snapshot as zero with the `rate_missing` flag). Timesheet Day view, running timer, time entry editor. Harvest import of the full historical dataset with the reconciliation checks in [BACKEND_PRD.md §16.3](BACKEND_PRD.md#163-verification) passing. Read-only Time report.
*Done when:* Jason personally tracks a full week in Tally and the totals match Harvest for the same week.

**Phase 1.5 - Daily driver**
Week view (editable in both timer modes), Calendar view with the Google Calendar overlay, command palette and keyboard map, offline queue, mobile Track, invites and password auth for contractors.
*Done when:* the whole team tracks daily in Tally, with a nightly diff job keeping score against Harvest.

**Phase 2 - Review**
Rates (billable and cost, dated). Budgets and over-budget alerts. Project detail page with progress and hours-per-week charts. Profitability report with drill-downs. Team and contractor reports. Approvals loop covering time and expenses. Expenses.
*Done when:* Jason can answer "which projects made money last quarter" without opening Harvest, and one full approval cycle has run end to end.

**Phase 3 - Bill**
Invoices: create from uninvoiced time and expenses, from a project fee, or from scratch. Invoice template and branding, PDF, email send, payment recording, Stripe pay page. Recurring invoices. Retainers. Uninvoiced and receivables reports. QuickBooks Online sync.
*Done when:* a full month of invoicing runs through Tally with no Harvest fallback.

**Phase 4 - Cutover**
Final delta import from Harvest. Bulk actions. Import/export. Saved reports and report builder. Audit log UI. Slack integration. Harvest set to read-only, then cancelled.

**Phase 5 - Beyond (unscheduled)**
Resource scheduling, estimates, client portal, browser extension, outgoing webhooks.

### 6.1 Phase map

| Area | Spec | Phase |
|---|---|---|
| App shell, theming, sidebar, top bar, timer widget | FRONTEND §2-3 | 1 |
| Command palette, shortcut map | FRONTEND §3.3-3.4 | 1.5 |
| Offline queue and idempotent replay | FRONTEND §4.6, BACKEND §6.7 | 1.5 |
| Timesheet Day view, timer, entry editor | FRONTEND §5.1-5.2, §5.5-5.6 | 1 |
| Week and Calendar views, mobile Track | FRONTEND §5.3-5.4, §5.7 | 1.5 |
| Expenses | FRONTEND §6 | 2 |
| Approvals (time + expenses) | FRONTEND §7, BACKEND §4.10 | 2 |
| Team list, person settings, invites | FRONTEND §8 | 1 |
| Rates, utilization, assignments | FRONTEND §8.2-8.4, BACKEND §4.5 | 2 |
| Clients | FRONTEND §9 | 1 (financial tabs: 3) |
| Projects list and editor | FRONTEND §10.1, §10.3 | 1 |
| Project detail, budgets, charts | FRONTEND §10.2, BACKEND §4.6 | 2 |
| Tasks | FRONTEND §11 | 1 |
| Invoices, recurring, retainers, invoice config | FRONTEND §12-15, BACKEND §4.8, §4.11-4.12 | 3 |
| Time report (read-only) | FRONTEND §16.1 | 1 |
| Profitability, team, contractor reports | FRONTEND §16.2-16.3, BACKEND §4.7 | 2 |
| Invoicing report | FRONTEND §16.4 | 3 |
| Report builder, saved reports | FRONTEND §16.5 | 4 |
| Settings: company, preferences | FRONTEND §17.1-17.2 | 1 |
| Settings: modules, sign-in security | FRONTEND §17.3-17.4 | 2 |
| Import/export, bulk actions, activity log | FRONTEND §17.5-17.6, §17.8, BACKEND §13-14 | 4 |
| Google Calendar integration | BACKEND §12.2 | 1.5 |
| QuickBooks, Stripe integrations | BACKEND §12.3, §12.5 | 3 |
| Slack integration | BACKEND §12.4 | 4 |
| Harvest migration | BACKEND §16 | 1 (delta re-run: 4) |

## 7. Success criteria

| Metric | Target |
|---|---|
| Median time from page load to a started timer | Under 4 seconds, keyboard-only |
| Timesheet completeness (people with zero gaps in a submitted week) | 95% by end of month 2 |
| Report load: profitability, one quarter, all projects | Under 1 second p95 |
| Any interaction acknowledged on screen | Under 200 ms p95 |
| Lost time entries after the offline-buffer ships | Zero |
| Monthly cost | Under $60 (droplet + Spaces + email), versus current Harvest seat spend |
| Migration fidelity | Total tracked hours and invoiced totals match Harvest to the cent for every closed month |

## 8. Glossary

| Term | Meaning here |
|---|---|
| **Billable rate** | What we charge a client per hour for a person's time. Resolved per project via `bill_by`. |
| **Cost rate** | What a person costs JHMG per hour. Administrator-visible only. Drives profit. |
| **Capacity** | Hours per week a person is available. Drives the utilization percentage. |
| **Utilization** | Tracked hours divided by capacity, for a period. |
| **Budget** | A ceiling on hours or fees for a project, optionally per task or per person, optionally resetting monthly. |
| **Fixed Fee** | Project billed at an agreed price regardless of hours. Revenue comes from the fee, not from hours times rate. |
| **Time and Materials (T&M)** | Project billed by the hour at billable rates. |
| **Uninvoiced amount** | Billable value of tracked time and billable expenses not yet attached to an invoice. |
| **Retainer** | Client funds held in advance, drawn down as invoices are issued. |
| **Snapshot rate** | The billable and cost rate copied onto a time entry when it is saved, so historical reports never shift under you. |
| **Re-rate** | An explicit administrator action that recomputes snapshot rates over a selected range. |
| **Closed entry** | A time entry or expense attached to a sent invoice. Locked from edit unless unlocked by an Administrator. |
