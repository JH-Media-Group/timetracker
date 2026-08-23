# Tally - Back-End PRD

**Data model, domain rules, API, jobs, integrations, and deployment.**

| | |
|---|---|
| Status | Draft v1.1 (review pass applied 2026-08-13) |
| Date | 2026-08-13 |
| Companion docs | [PRD-OVERVIEW.md](PRD-OVERVIEW.md) - [FRONTEND_PRD.md](FRONTEND_PRD.md) - [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) |

---

## Table of contents

1. [Architecture](#1-architecture)
2. [Repository layout](#2-repository-layout)
3. [Data model](#3-data-model)
4. [Domain rules](#4-domain-rules)
5. [Service layer](#5-service-layer)
6. [HTTP API](#6-http-api)
7. [Authentication and authorization](#7-authentication-and-authorization)
8. [Real-time](#8-real-time)
9. [Background jobs](#9-background-jobs)
10. [Email](#10-email)
11. [Files and PDF](#11-files-and-pdf)
12. [Integrations](#12-integrations)
13. [Import, export, and bulk actions](#13-import-export-and-bulk-actions)
14. [Audit log](#14-audit-log)
15. [Observability and operations](#15-observability-and-operations)
16. [Harvest migration](#16-harvest-migration)
17. [Deployment](#17-deployment)
18. [Security](#18-security)
19. [Testing](#19-testing)
20. [Acceptance criteria](#20-acceptance-criteria)

---

## 1. Architecture

Single tenant, single database, five containers on one droplet.

```
                          ┌───────────────────┐
   Browser ──── HTTPS ───▶│  Caddy            │  automatic TLS, HTTP/2,
                          │  reverse proxy    │  gzip + brotli, static cache
                          └─────────┬─────────┘
                                    │
                     ┌──────────────┴──────────────┐
                     ▼                             ▼
          ┌────────────────────┐        ┌────────────────────┐
          │  web               │        │  worker            │
          │  Next.js 15 (node) │        │  BullMQ processors │
          │  · RSC pages       │        │  · recurring inv.  │
          │  · /api/v1 handlers│        │  · budget alerts   │
          │  · /api/live (SSE) │        │  · reminders       │
          │  · service layer   │        │  · PDF (chromium)  │
          └───┬────────┬───────┘        │  · QBO sync        │
              │        │                │  · imports/exports │
              │        │                │  · bulk actions    │
              │        │                └───┬────────┬───────┘
              │        └──────────┬─────────┘        │
              ▼                   ▼                  ▼
      ┌───────────────┐   ┌───────────────┐   ┌──────────────┐
      │ PostgreSQL 16 │   │ Redis 7       │   │ DO Spaces    │
      │ system of     │   │ queues +      │   │ receipts,    │
      │ record        │   │ pub/sub +     │   │ logos, PDFs  │
      │               │   │ rate limits   │   │ backups      │
      └───────────────┘   └───────────────┘   └──────────────┘
```

**The one rule that keeps this coherent:** all business logic lives in the **service layer**, a set of plain TypeScript modules that take a `Ctx` (actor, permissions, db handle, clock) and return typed results. Nothing else touches the database.

- React Server Components call services directly for first paint. No HTTP hop, no waterfall.
- `/api/v1` route handlers are a thin HTTP shell over the same services: parse, authorize, call, serialize.
- BullMQ processors call the same services with a system actor.

This means a rule like "a time entry attached to a sent invoice cannot be edited" is written once and enforced on every path, including bulk actions, imports, and the API.

**No Server Actions.** Mutations go through `/api/v1` exclusively. Two mutation paths means two places for permission checks to drift; one path is worth the small verbosity.

### 1.1 Request lifecycle for a mutation

```
POST /api/v1/time-entries
  │
  ├─ 1. withRoute()          request-id, pino child logger, Sentry scope
  ├─ 2. requireSession()     Auth.js session → actor { userId, profile, capabilities }
  ├─ 3. rateLimit()          Redis token bucket, keyed by actor + route class
  ├─ 4. parse(schema)        shared Zod schema → 422 with field-level errors
  ├─ 5. idempotency()        if Idempotency-Key present, replay or reserve
  ├─ 6. service.create(ctx)  ── authorize() ── db transaction ── audit row
  │                                                └─ emit domain event
  ├─ 7. serialize()          explicit DTO, never a raw row
  └─ 8. respond 201          + Location, + ETag where applicable
                              │
                              └─ after-response: liveBus.publish(event)
```

Domain events are emitted inside the transaction into an `outbox` table and published to Redis after commit, so a rolled-back transaction can never leak an event to connected clients.

---

## 2. Repository layout

Single Next.js app, no monorepo. The service layer is a directory, not a package.

```
/
├── app/
│   ├── (app)/                       authenticated shell
│   │   ├── timesheet/               expenses/ approvals/ team/ clients/
│   │   ├── projects/ tasks/ invoices/ reports/ settings/
│   ├── (public)/pay/[token]/        client invoice pay page
│   ├── (auth)/signin/ invite/[token]/
│   └── api/
│       ├── v1/<resource>/route.ts   thin HTTP handlers
│       ├── live/route.ts            SSE stream
│       ├── auth/[...nextauth]/
│       ├── webhooks/{stripe,qbo,slack}/route.ts
│       └── health/{live,ready}/route.ts
├── src/
│   ├── db/
│   │   ├── schema/                  Drizzle table definitions, one file per domain
│   │   ├── migrations/              numbered .sql files
│   │   └── client.ts                pool, transaction helper
│   ├── services/                    ← all business logic
│   │   ├── time/  expenses/  projects/  clients/  tasks/  people/
│   │   ├── rates/ budgets/ approvals/ invoices/ retainers/ reports/
│   │   ├── bulk/  imports/  exports/  audit/  events/
│   ├── auth/                        session, capabilities, policy
│   ├── domain/                      pure functions: money, duration, rounding,
│   │                                rate resolution, budget math, profitability
│   ├── schemas/                     Zod, shared with the client
│   ├── integrations/                google/ quickbooks/ slack/ stripe/
│   ├── jobs/                        queue definitions + processors
│   ├── email/                       React Email templates + send
│   └── lib/                         logger, errors, ids, redis, s3, clock
├── components/  hooks/  styles/
├── tests/       unit/  integration/  e2e/
├── docs/
├── docker/      Dockerfile, Caddyfile, compose.yml
└── scripts/     migrate.ts, seed.ts, harvest-import.ts, backup.sh
```

---

## 3. Data model

PostgreSQL 16. Conventions applied everywhere:

- Primary keys are `uuid` v7 (time-ordered, so they index well and sort chronologically). Generated application-side; Postgres 16 has no native uuidv7 function.
- Migration `0001` enables the required extensions before any table: `citext` (case-insensitive emails) and `btree_gist` (the rate-range exclusion constraint).
- Money is `bigint` in minor units (cents), never `numeric`, never `float`. Column names end in `_cents`.
- Durations are `integer` seconds. Column names end in `_seconds`.
- `spent_on` is `date` (a calendar day in the user's timezone at write time). Everything else is `timestamptz`.
- Soft delete is `archived_at timestamptz` for things users archive, `deleted_at` for things that get an Undo window. Hard delete is a real `DELETE` and always writes an audit row first.
- Every user-facing table has `created_at`, `updated_at`, `created_by`, `updated_by`.
- `external_ref jsonb` on every migrated table holds `{ "harvest": { "id": 12345 } }` for idempotent re-import.

### 3.1 Identity and people

```sql
CREATE TABLE users (
  id                  uuid PRIMARY KEY,
  email               citext NOT NULL UNIQUE,
  first_name          text NOT NULL,
  last_name           text NOT NULL,
  avatar_key          text,                       -- Spaces object key
  employee_id         text,
  timezone            text NOT NULL DEFAULT 'America/New_York',
  weekly_capacity_seconds integer NOT NULL DEFAULT 144000,   -- 40h
  employment_type     text NOT NULL DEFAULT 'employee',      -- employee | contractor
  is_owner            boolean NOT NULL DEFAULT false,
  profile_id          uuid NOT NULL REFERENCES permission_profiles(id),
  auto_assign_projects boolean NOT NULL DEFAULT false,
  theme               text NOT NULL DEFAULT 'system',        -- system | light | dark
  notification_prefs  jsonb NOT NULL DEFAULT '{}',
      -- { reminders: { time: "09:00", days: [1,2,3,4,5] },
      --   channels: { email: true, slack: false },
      --   weekly_summary: true, project_deleted: true, budget_alerts: true, approvals: true }
  started_on          date,
  ended_on            date,
  archived_at         timestamptz,
  last_seen_at        timestamptz,
  external_ref        jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON users (archived_at) WHERE archived_at IS NULL;

CREATE TABLE roles        (id uuid PRIMARY KEY, name text NOT NULL UNIQUE, archived_at timestamptz);
CREATE TABLE departments  (id uuid PRIMARY KEY, name text NOT NULL UNIQUE, archived_at timestamptz);
CREATE TABLE user_roles       (user_id uuid REFERENCES users, role_id uuid REFERENCES roles,       PRIMARY KEY (user_id, role_id));
CREATE TABLE user_departments (user_id uuid REFERENCES users, department_id uuid REFERENCES departments, PRIMARY KEY (user_id, department_id));

CREATE TABLE permission_profiles (
  id           uuid PRIMARY KEY,
  name         text NOT NULL UNIQUE,
  is_base      boolean NOT NULL DEFAULT false,     -- the six built-ins, not deletable
  base_key     text,                               -- member | project_manager | people_admin |
                                                   -- accounting | executive_manager | administrator
  capabilities text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Who a manager can see and approve, when their profile is not account-wide.
CREATE TABLE user_managed_users (
  manager_id uuid REFERENCES users, managed_id uuid REFERENCES users,
  PRIMARY KEY (manager_id, managed_id)
);
```

**Rates are dated ranges, not single values.** This is the crux of accurate history.

```sql
CREATE TABLE user_rates (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users,
  kind         text NOT NULL,               -- billable | cost
  amount_cents bigint NOT NULL,
  currency     char(3) NOT NULL DEFAULT 'USD',
  starts_on    date,                        -- NULL = "all prior"
  ends_on      date,                        -- NULL = "all future"
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users
);
-- No two rates of the same kind may overlap for one user.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE user_rates ADD CONSTRAINT user_rates_no_overlap
  EXCLUDE USING gist (
    user_id WITH =, kind WITH =,
    daterange(COALESCE(starts_on,'-infinity'), COALESCE(ends_on,'infinity'), '[]') WITH &&
  );
CREATE INDEX ON user_rates (user_id, kind, starts_on DESC);
```

### 3.2 Clients and projects

```sql
CREATE TABLE clients (
  id                uuid PRIMARY KEY,
  name              text NOT NULL,
  address           text,
  currency          char(3) NOT NULL DEFAULT 'USD',
  payment_term      text NOT NULL DEFAULT 'net_15',   -- upon_receipt|net_15|net_30|net_45|net_60|custom
  payment_term_days integer,
  tax_percent       numeric(6,3),
  tax2_percent      numeric(6,3),
  discount_percent  numeric(6,3),
  invoice_prefix    text,                             -- overrides the account numbering prefix
  archived_at       timestamptz,
  external_ref      jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ON clients (lower(name)) WHERE archived_at IS NULL;

CREATE TABLE client_contacts (
  id uuid PRIMARY KEY, client_id uuid NOT NULL REFERENCES clients ON DELETE CASCADE,
  first_name text, last_name text, title text,
  email citext, phone_office text, phone_mobile text,
  is_primary boolean NOT NULL DEFAULT false,
  archived_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE projects (
  id                uuid PRIMARY KEY,
  client_id         uuid NOT NULL REFERENCES clients,
  name              text NOT NULL,
  code              text,
  billing_type      text NOT NULL,     -- time_and_materials | fixed_fee | non_billable
  bill_by           text NOT NULL DEFAULT 'none',  -- project | tasks | people | none
  hourly_rate_cents bigint,            -- used when bill_by = 'project'
  fee_cents         bigint,            -- fixed_fee total
  fee_cadence       text,              -- single | monthly
  budget_by         text NOT NULL DEFAULT 'none',
      -- project_hours | project_fees | task_hours | task_fees | person_hours | none
  budget_seconds    integer,           -- hour budgets (project_hours)
  budget_fee_cents  bigint,            -- fee budgets (project_fees); typed columns, no unit ambiguity
  CONSTRAINT budget_one_kind CHECK (budget_seconds IS NULL OR budget_fee_cents IS NULL),
  budget_resets_monthly boolean NOT NULL DEFAULT false,
  budget_alert_percent  numeric(5,2),  -- NULL = no alert
  currency          char(3),           -- NULL = same as client
  starts_on date, ends_on date,
  notes             text,
  report_visibility text NOT NULL DEFAULT 'managers', -- managers | everyone (field list: §7.4)
  archived_at       timestamptz,
  external_ref      jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON projects (client_id) WHERE archived_at IS NULL;
CREATE INDEX ON projects (archived_at);

CREATE TABLE tags (id uuid PRIMARY KEY, name text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE project_tags (project_id uuid REFERENCES projects ON DELETE CASCADE, tag_id uuid REFERENCES tags ON DELETE CASCADE, PRIMARY KEY (project_id, tag_id));

CREATE TABLE tasks (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  default_hourly_rate_cents bigint,
  is_default_billable boolean NOT NULL DEFAULT true,
  is_common boolean NOT NULL DEFAULT false,      -- auto-added to new projects
  archived_at timestamptz,
  external_ref jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ON tasks (lower(name)) WHERE archived_at IS NULL;

-- A task made available on a project. Time entries reference THIS, not tasks.
CREATE TABLE project_tasks (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects ON DELETE CASCADE,
  task_id    uuid NOT NULL REFERENCES tasks,
  is_billable boolean NOT NULL DEFAULT true,
  hourly_rate_cents bigint,          -- used when project.bill_by = 'tasks'
  budget_seconds integer,            -- used when project.budget_by = 'task_hours'
  budget_fee_cents bigint,           -- used when project.budget_by = 'task_fees'
  archived_at timestamptz,
  UNIQUE (project_id, task_id)
);

CREATE TABLE project_members (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users,
  is_manager boolean NOT NULL DEFAULT false,
  hourly_rate_cents bigint,          -- override; used when project.bill_by = 'people'
  budget_seconds integer,            -- used when project.budget_by = 'person_hours'
  archived_at timestamptz,
  UNIQUE (project_id, user_id)
);
CREATE INDEX ON project_members (user_id) WHERE archived_at IS NULL;

-- Pinning is a per-user preference, not a project attribute.
CREATE TABLE user_pinned_projects (
  user_id    uuid REFERENCES users ON DELETE CASCADE,
  project_id uuid REFERENCES projects ON DELETE CASCADE,
  pinned_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, project_id)
);
```

### 3.3 Time and expenses

```sql
CREATE TABLE time_entries (
  id               uuid PRIMARY KEY,
  user_id          uuid NOT NULL REFERENCES users,
  project_id       uuid NOT NULL REFERENCES projects,
  project_task_id  uuid NOT NULL REFERENCES project_tasks,
  spent_on         date NOT NULL,
  started_at       timestamptz,          -- clock times, when the account tracks them
  ended_at         timestamptz,
  times_are_inferred boolean NOT NULL DEFAULT false,  -- week-grid entry in start/end mode
  duration_seconds integer NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0),
  timer_started_at timestamptz,          -- NOT NULL ⇒ running
  notes            text,
  is_billable      boolean NOT NULL,
  -- Rate snapshots, resolved at write time. Never recomputed except by an explicit re-rate.
  billable_rate_cents bigint NOT NULL DEFAULT 0,
  cost_rate_cents     bigint NOT NULL DEFAULT 0,
  rates_locked_at     timestamptz,       -- set when the entry lands on a sent invoice
  billed_externally boolean NOT NULL DEFAULT false,
      -- invoiced in Harvest pre-migration; no invoice row exists here (§4.11, §16.2)
  invoice_id       uuid REFERENCES invoices ON DELETE SET NULL,
  approval_id      uuid REFERENCES timesheet_submissions ON DELETE SET NULL,
  source           text NOT NULL DEFAULT 'web',  -- web | api | import | calendar | slack
  external_ref     jsonb NOT NULL DEFAULT '{}',
  deleted_at       timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid REFERENCES users,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid REFERENCES users
);

-- Exactly one running timer per person, enforced by the database.
CREATE UNIQUE INDEX one_running_timer_per_user
  ON time_entries (user_id) WHERE timer_started_at IS NOT NULL AND deleted_at IS NULL;

-- The three access patterns that matter.
CREATE INDEX ON time_entries (user_id, spent_on DESC)     WHERE deleted_at IS NULL;
CREATE INDEX ON time_entries (project_id, spent_on DESC)  WHERE deleted_at IS NULL;
CREATE INDEX ON time_entries (spent_on)                   WHERE deleted_at IS NULL AND invoice_id IS NULL
                                                            AND NOT billed_externally AND is_billable;
CREATE INDEX ON time_entries (invoice_id)                 WHERE invoice_id IS NOT NULL;

CREATE TABLE expense_categories (
  id uuid PRIMARY KEY, name text NOT NULL,
  unit_name text, unit_price_cents bigint,     -- both set ⇒ unit-priced (e.g. Mileage)
  archived_at timestamptz, external_ref jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE expenses (
  id uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users,
  project_id  uuid NOT NULL REFERENCES projects,
  category_id uuid NOT NULL REFERENCES expense_categories,
  spent_on    date NOT NULL,
  units       numeric(12,2),                   -- unit-priced categories only
  total_cents bigint NOT NULL,
  notes       text,
  is_billable boolean NOT NULL DEFAULT true,
  is_reimbursable boolean NOT NULL DEFAULT false,
  reimbursement_state text,                    -- pending | approved | paid
  reimbursed_at timestamptz,
  receipt_key text, receipt_content_type text, receipt_bytes integer,
  billed_externally boolean NOT NULL DEFAULT false,           -- see time_entries
  invoice_id  uuid REFERENCES invoices ON DELETE SET NULL,
  approval_id uuid REFERENCES timesheet_submissions ON DELETE SET NULL,
  external_ref jsonb NOT NULL DEFAULT '{}', deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid REFERENCES users,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid REFERENCES users
);
CREATE INDEX ON expenses (user_id, spent_on DESC) WHERE deleted_at IS NULL;
CREATE INDEX ON expenses (project_id, spent_on DESC) WHERE deleted_at IS NULL;

CREATE TABLE timesheet_submissions (
  id uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users,
  period_start date NOT NULL, period_end date NOT NULL,
  state        text NOT NULL DEFAULT 'submitted',  -- submitted | approved | changes_requested
  submitted_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by  uuid REFERENCES users, reviewed_at timestamptz,
  review_note  text,
  total_seconds integer NOT NULL DEFAULT 0,
  flags        jsonb NOT NULL DEFAULT '[]',        -- computed at submit time
  UNIQUE (user_id, period_start)
);
CREATE INDEX ON timesheet_submissions (state, period_start DESC);
```

A submission covers **both** the period's time entries and its expenses; both tables carry `approval_id`, both are associated at submit time, and the approver reviews them together. The lock that approval imposes is period-based, not row-based - see §4.10.

### 3.4 Invoicing

```sql
CREATE TABLE invoices (
  id uuid PRIMARY KEY,
  client_id   uuid NOT NULL REFERENCES clients,
  number      text NOT NULL,
  subject     text, notes text, po_number text,
  currency    char(3) NOT NULL DEFAULT 'USD',
  issue_date  date NOT NULL,
  due_date    date NOT NULL,
  payment_term text,
  state       text NOT NULL DEFAULT 'draft',    -- draft|open|paid|written_off|closed
  subtotal_cents bigint NOT NULL DEFAULT 0,
  discount_percent numeric(6,3), discount_cents bigint NOT NULL DEFAULT 0,
  tax_percent  numeric(6,3),  tax_cents  bigint NOT NULL DEFAULT 0,
  tax2_percent numeric(6,3),  tax2_cents bigint NOT NULL DEFAULT 0,
  total_cents  bigint NOT NULL DEFAULT 0,
  paid_cents   bigint NOT NULL DEFAULT 0,
  show_total_hours boolean NOT NULL DEFAULT false,
  pay_token   text UNIQUE,                       -- public pay page
  sent_at timestamptz, paid_at timestamptz, closed_at timestamptz,
  recurring_invoice_id uuid REFERENCES recurring_invoices ON DELETE SET NULL,
  retainer_draw_cents bigint NOT NULL DEFAULT 0,
  external_ref jsonb NOT NULL DEFAULT '{}',      -- holds the QuickBooks id
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid REFERENCES users,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid REFERENCES users
);
CREATE UNIQUE INDEX ON invoices (number) WHERE deleted_at IS NULL;
CREATE INDEX ON invoices (client_id, issue_date DESC) WHERE deleted_at IS NULL;
CREATE INDEX ON invoices (state, due_date) WHERE deleted_at IS NULL;

CREATE TABLE invoice_item_types (
  id uuid PRIMARY KEY, name text NOT NULL UNIQUE,
  is_default_for_expenses boolean NOT NULL DEFAULT false,
  is_default_for_services boolean NOT NULL DEFAULT false,
  qbo_income_account_id text, archived_at timestamptz
);

CREATE TABLE invoice_line_items (
  id uuid PRIMARY KEY,
  invoice_id uuid NOT NULL REFERENCES invoices ON DELETE CASCADE,
  position   integer NOT NULL,
  item_type_id uuid REFERENCES invoice_item_types,
  project_id uuid REFERENCES projects,
  description text NOT NULL,
  quantity   numeric(12,2) NOT NULL DEFAULT 1,
  unit_price_cents bigint NOT NULL DEFAULT 0,
  amount_cents bigint NOT NULL DEFAULT 0,
  is_taxed boolean NOT NULL DEFAULT true,
  is_taxed2 boolean NOT NULL DEFAULT false,
  UNIQUE (invoice_id, position) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE invoice_payments (
  id uuid PRIMARY KEY,
  invoice_id uuid NOT NULL REFERENCES invoices ON DELETE CASCADE,
  amount_cents bigint NOT NULL,
  paid_at timestamptz NOT NULL,
  method text, reference text, notes text,
  gateway text, gateway_txn_id text UNIQUE,     -- Stripe idempotency
  voided_at timestamptz, voided_by uuid REFERENCES users,
  recorded_by uuid REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE invoice_messages (
  id uuid PRIMARY KEY,
  invoice_id uuid NOT NULL REFERENCES invoices ON DELETE CASCADE,
  kind text NOT NULL,                            -- invoice | reminder | thank_you
  subject text, body text,
  recipients jsonb NOT NULL,                     -- { to:[], cc:[], bcc:[] }
  attached_pdf boolean NOT NULL DEFAULT true,
  provider_message_id text,
  sent_by uuid REFERENCES users, sent_at timestamptz NOT NULL DEFAULT now(),
  opened_at timestamptz
);

CREATE TABLE invoice_attachments (
  id uuid PRIMARY KEY, invoice_id uuid NOT NULL REFERENCES invoices ON DELETE CASCADE,
  object_key text NOT NULL, filename text NOT NULL, content_type text, bytes integer,
  uploaded_by uuid REFERENCES users, created_at timestamptz NOT NULL DEFAULT now()
);

-- Many-to-many so one invoice can cover several projects, and a project can be
-- linked to invoices that were not generated from it.
CREATE TABLE invoice_projects (
  invoice_id uuid REFERENCES invoices ON DELETE CASCADE,
  project_id uuid REFERENCES projects ON DELETE CASCADE,
  PRIMARY KEY (invoice_id, project_id)
);

CREATE TABLE recurring_invoices (
  id uuid PRIMARY KEY,
  client_id uuid NOT NULL REFERENCES clients,
  subject text, template jsonb NOT NULL,         -- line items, taxes, notes, recipients
  frequency text NOT NULL,                       -- weekly|monthly|quarterly|yearly
  interval integer NOT NULL DEFAULT 1,           -- "every N <frequency>"
  day_of_month integer, day_of_week integer,
  starts_on date NOT NULL, ends_on date, occurrences_remaining integer,
  next_issue_on date,
  send_automatically boolean NOT NULL DEFAULT false,
  state text NOT NULL DEFAULT 'active',          -- active | paused | completed
  last_issued_on date,
  external_ref jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON recurring_invoices (next_issue_on) WHERE state = 'active';

CREATE TABLE retainers (
  id uuid PRIMARY KEY,
  client_id uuid NOT NULL REFERENCES clients,
  project_id uuid REFERENCES projects,           -- NULL = applies to all projects
  balance_cents bigint NOT NULL DEFAULT 0,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, project_id)
);

CREATE TABLE retainer_transactions (
  id uuid PRIMARY KEY,
  retainer_id uuid NOT NULL REFERENCES retainers ON DELETE CASCADE,
  kind text NOT NULL,                            -- add | draw | adjust
  amount_cents bigint NOT NULL,                  -- always positive; kind carries the sign
  balance_after_cents bigint NOT NULL,
  invoice_id uuid REFERENCES invoices ON DELETE SET NULL,
  note text, occurred_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users
);
```

### 3.5 Platform tables

```sql
CREATE TABLE settings (              -- singleton, one row, id = 1
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  company_name text NOT NULL, company_address text, logo_key text, tax_id text,
  base_currency char(3) NOT NULL DEFAULT 'USD',
  timezone text NOT NULL DEFAULT 'America/New_York',
      -- the ACCOUNT timezone: cron schedules, monthly budget-reset boundaries,
      -- recurring-invoice issue dates, and the invoices-issued-per-month chart
  week_starts_on smallint NOT NULL DEFAULT 1,        -- ISO: 1 = Monday
  fiscal_year_start_month smallint NOT NULL DEFAULT 1,
  timer_mode text NOT NULL DEFAULT 'start_end',      -- duration | start_end
  time_display text NOT NULL DEFAULT 'decimal',      -- decimal | hours_minutes
  rounding_minutes smallint NOT NULL DEFAULT 0,
  rounding_mode text NOT NULL DEFAULT 'nearest',     -- nearest | up | down
  require_notes text NOT NULL DEFAULT 'never',       -- never | always | non_billable
  allow_future_dates boolean NOT NULL DEFAULT true,
  flag_missing_below_seconds integer,
  lock_timesheets_after_days integer,
  project_notes_visibility text NOT NULL DEFAULT 'managers',
  modules jsonb NOT NULL DEFAULT '{}',               -- feature flags
  invoice_defaults jsonb NOT NULL DEFAULT '{}',
  invoice_appearance jsonb NOT NULL DEFAULT '{}',
  invoice_messages jsonb NOT NULL DEFAULT '{}',
  invoice_field_labels jsonb NOT NULL DEFAULT '{}',
  invoice_number_pattern text NOT NULL DEFAULT '{seq:5}',
  invoice_next_seq integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid REFERENCES users
);

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  actor_id uuid REFERENCES users, actor_kind text NOT NULL DEFAULT 'user', -- user|system|api|integration
  action text NOT NULL,                          -- e.g. time_entry.update
  entity_type text NOT NULL, entity_id uuid, entity_label text,
  before jsonb, after jsonb, diff_keys text[],
  request_id text, ip inet, user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_log (created_at DESC);
CREATE INDEX ON audit_log (entity_type, entity_id, created_at DESC);
CREATE INDEX ON audit_log (actor_id, created_at DESC);

CREATE TABLE outbox (                            -- transactional event publishing
  id bigserial PRIMARY KEY, topic text NOT NULL, payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz
);
CREATE INDEX ON outbox (id) WHERE published_at IS NULL;

CREATE TABLE idempotency_keys (
  key text PRIMARY KEY, actor_id uuid, route text NOT NULL,
  request_hash text NOT NULL, response_status smallint, response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_tokens (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users,
  label text NOT NULL, token_hash text NOT NULL UNIQUE, prefix text NOT NULL,
  scopes text[] NOT NULL DEFAULT '{}', last_used_at timestamptz,
  expires_at timestamptz, revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE integration_connections (
  id uuid PRIMARY KEY,
  provider text NOT NULL,                        -- google|quickbooks|slack|stripe
  scope text NOT NULL DEFAULT 'account',         -- account | user
  user_id uuid REFERENCES users,                 -- set when scope = 'user'
  external_account_id text,
  access_token_enc bytea, refresh_token_enc bytea, expires_at timestamptz,
  granted_scopes text[], config jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'connected',      -- connected | expired | error
  last_error text, last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, scope, user_id)
);

CREATE TABLE saved_reports (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES users,
  name text NOT NULL, kind text NOT NULL, config jsonb NOT NULL,
  visibility text NOT NULL DEFAULT 'private',    -- private | shared
  schedule jsonb, last_run_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bulk_action_runs (
  id uuid PRIMARY KEY, actor_id uuid NOT NULL REFERENCES users,
  action_key text NOT NULL, params jsonb NOT NULL,
  target_count integer NOT NULL, succeeded integer NOT NULL DEFAULT 0,
  skipped integer NOT NULL DEFAULT 0, failed integer NOT NULL DEFAULT 0,
  results jsonb NOT NULL DEFAULT '[]', state text NOT NULL DEFAULT 'running',
  revert_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);

CREATE TABLE import_runs (
  id uuid PRIMARY KEY, actor_id uuid NOT NULL REFERENCES users,
  kind text NOT NULL, filename text, object_key text,
  mapping jsonb, row_count integer, inserted integer, skipped integer, failed integer,
  errors jsonb NOT NULL DEFAULT '[]',
  state text NOT NULL DEFAULT 'pending',         -- pending|validating|running|done|failed|reverted
  created_ids uuid[], reverted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notifications (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users,
  kind text NOT NULL, title text NOT NULL, body text,
  entity_type text, entity_id uuid, url text,
  read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON notifications (user_id, created_at DESC) WHERE read_at IS NULL;
```

### 3.6 Reporting rollup

Report queries over the expected workload are trivially fast in raw SQL, but profitability joins time entries, rates, expenses, invoices, and projects across arbitrary periods. Rather than a materialized view that goes stale, we use one **generated view** plus targeted indexes, and only introduce a rollup table if p95 exceeds the 1s budget.

```sql
CREATE VIEW time_entry_facts AS
SELECT
  te.id, te.user_id, te.project_id, te.project_task_id, pt.task_id,
  p.client_id, te.spent_on, te.is_billable, te.duration_seconds,
  te.invoice_id, te.approval_id,
  (te.duration_seconds * te.billable_rate_cents) / 3600 AS billable_cents,
  (te.duration_seconds * te.cost_rate_cents)     / 3600 AS cost_cents,
  p.billing_type, p.archived_at IS NOT NULL AS project_archived
FROM time_entries te
JOIN project_tasks pt ON pt.id = te.project_task_id
JOIN projects p       ON p.id = te.project_id
WHERE te.deleted_at IS NULL AND te.timer_started_at IS NULL;
```

Integer division truncates, which under-reports by at most half a cent per entry. All money aggregation therefore sums `duration_seconds * rate_cents` first and divides once at the end. The view exists for readability; the report services compose the aggregation themselves so the division happens last.

---

## 4. Domain rules

These live in `src/domain/` as pure functions with exhaustive unit tests. They are the specification.

### 4.1 Money

- Represented as `bigint` cents throughout. Never a JavaScript `number` in a calculation that reaches storage.
- `roundHalfEven` is the rounding mode for tax and discount, because half-up systematically favours one direction over thousands of line items.
- Invoice totals compute in a fixed order and store every intermediate:
  ```
  subtotal   = Σ line.amount_cents
  discount   = round(subtotal × discount_percent / 100)
  taxable    = Σ line.amount_cents where line.is_taxed  (post-discount, pro-rated)
  tax        = round(taxable × tax_percent / 100)
  taxable2   = Σ line.amount_cents where line.is_taxed2
  tax2       = round(taxable2 × tax2_percent / 100)
  total      = subtotal − discount + tax + tax2
  balance    = total − Σ payment.amount_cents (non-voided) − retainer_draw_cents
  ```
- `line.amount_cents = round(quantity × unit_price_cents)`, where `quantity` is `numeric(12,2)`.
- Multi-currency is schema-ready but v1 asserts a single base currency. A project or client in a foreign currency is accepted and stored, but reports refuse to sum across currencies and instead group by currency. No FX conversion in v1.

### 4.2 Duration

- Stored as integer seconds.
- Parser accepts `1.5`, `1,5`, `90`, `90m`, `1h30`, `1h 30m`, `1:30`, `:45`, `1h`. Bare numbers are hours when they contain a decimal separator or are less than 24, minutes otherwise. Ambiguity resolves toward hours because that is what people mean.
- Range parser accepts `9-10:30`, `9am-10:30am`, `09:00 to 10:30`, `9:00-17:00`. An end before the start rolls to the next day only if the span is under 12 hours; otherwise it is an error.
- Formatter renders decimal to two places or `H:MM`, per the account setting.

### 4.3 Rounding

Rounding is a **presentation and invoicing** concern, never a storage concern.

- `rounding_minutes` and `rounding_mode` apply to: summary time reports, invoice line generation from time, and the "if billed hourly" columns.
- They never apply to: timesheets, the detailed time report, utilization, capacity, or profitability cost.
- Rounding is applied per **aggregated group**, not per entry, so ten 6-minute entries under 15-minute rounding become 1.0 hours, not 2.5. This is the behaviour finance expects and the opposite of the naive implementation.

### 4.4 The calendar day

`spent_on` is a calendar date, resolved in the **acting user's** timezone at the moment of write. A timer started at 11:45pm New York and stopped at 12:30am belongs to the day it started. Rules:

- `spent_on` is set from `timer_started_at` converted to the user's timezone, once, at creation. It never drifts afterwards.
- Week boundaries use `settings.week_starts_on` and the user's timezone.
- Reports filter on `spent_on` (a `date`), never on `created_at`, so a late-entered entry lands in the right period.
- An entry created for someone else uses **that person's** timezone, not the actor's.
- Account-level boundaries use `settings.timezone`, not any individual's: monthly budget resets, recurring-invoice issue dates, the invoices-issued-per-month chart, and every cron schedule in §9.

### 4.5 Rate resolution

Run once when a time entry is created or when its project, task, person, or date changes, and the result is stored on the entry.

**Billable rate** (returns 0 for non-billable entries and non-billable projects):

```
1. project.billing_type = 'non_billable'          → 0
2. project_task.is_billable = false               → 0
3. project.bill_by = 'people'  → project_member.hourly_rate_cents
                               ?? user_rate(billable, spent_on)
                               ?? 0
4. project.bill_by = 'tasks'   → project_task.hourly_rate_cents
                               ?? task.default_hourly_rate_cents
                               ?? 0
5. project.bill_by = 'project' → project.hourly_rate_cents ?? 0
6. project.bill_by = 'none'    → 0
```

**Cost rate:** `user_rate(cost, spent_on) ?? 0`. Independent of the project entirely.

`user_rate(kind, on)` selects the `user_rates` row whose `daterange` contains `on`. There can be at most one by the exclusion constraint.

**When rate lookup returns 0 but a rate was expected**, the service records a `rate_missing` flag on the response and the reporting layer surfaces it in the data-quality banner. It never guesses.

**Re-rate.** An Administrator action (`POST /api/v1/admin/re-rate`) recomputes snapshots for a filter set (date range, project, person). It refuses to touch entries with `rates_locked_at` set unless `force: true` is passed, writes an audit row per changed entry with before and after values, and runs as a background job with a progress stream.

### 4.6 Budgets

`budget_by` determines both the unit and the grain:

| `budget_by` | Unit | Grain | Spent is |
|---|---|---|---|
| `project_hours` | hours | project | Σ duration on the project |
| `project_fees` | currency | project | Σ billable value on the project |
| `task_hours` | hours | each `project_task` | Σ duration on that task |
| `task_fees` | currency | each `project_task` | Σ billable value on that task |
| `person_hours` | hours | each `project_member` | Σ that person's duration on the project |
| `none` | - | - | - |

The budget value lives in typed columns - `budget_seconds` for hour budgets, `budget_fee_cents` for fee budgets, and their `project_tasks` / `project_members` equivalents at task and person grain. The `budget_one_kind` CHECK forbids both being set on a row; the service layer validates that the populated column matches `budget_by` (a cross-table rule for task and person grain, so it cannot be a database constraint).

When `budget_resets_monthly` is true, "spent" is scoped to the calendar month containing the reference date, with month boundaries in the account timezone; the projects list and project page both use the current month.

`remaining = budget − spent`. `percent_used = spent / budget`. Health thresholds: under 80% is `--info`, 80-100% is `--warning`, over 100% is `--danger` with an overflow segment.

**Budget alerts** fire once per threshold crossing per budget period. A `budget_alerts_sent` key in Redis (`budget:{project_id}:{period}:{threshold}`) prevents duplicate emails, with the authoritative record written to `notifications`. Crossing back under the threshold clears the key so a later re-crossing alerts again.

### 4.7 Profitability

For a period `P` and a grouping dimension `D`:

```
COST(D)    = Σ over time entries in P grouped by D of (duration_seconds × cost_rate_cents / 3600)
           + Σ over expenses in P grouped by D of total_cents      [expenses that are a cost to us]

REVENUE(D) for Time & Materials projects
           = Σ (duration_seconds × billable_rate_cents / 3600)     [billable entries]
           + Σ expense.total_cents where is_billable

REVENUE(D) for Fixed Fee projects
           = the project's fee, recognised over the period, allocated across D by the
             chosen allocation mode:
               'evenly'         → fee / count(D members active in P)
               'by_hours'       → fee × (hours in D / total hours on the project in P)
               'by_billable'    → fee × (billable value in D / total billable value in P)

PROFIT(D)  = REVENUE(D) − COST(D)
MARGIN(D)  = PROFIT(D) / REVENUE(D)     (null when REVENUE = 0)
ROC(D)     = PROFIT(D) / COST(D)        (null when COST = 0)
```

Fee recognition for `fee_cadence = 'monthly'` is the monthly fee times the number of months of the project's active window intersecting `P`. For `single`, the fee is recognised across the project's full active window, pro-rated by tracked hours within `P` unless the project has a start and end date, in which case it is pro-rated by elapsed days. The recognition mode is exposed in the report's `ⓘ` popover so the number is never a black box.

A `tracked_time` versus `invoiced` toggle switches revenue from the accrual view above to the cash-basis view: `Σ invoice line amounts issued in P`. Line amounts attribute to projects through `invoice_line_items.project_id`, which is always set on lines generated from time, expenses, or a project fee. Lines without a project fall back to the invoice's `invoice_projects` links, split evenly; lines on an invoice with no project link at all group under "Unassigned" rather than disappearing. Within a project, people and task attribution uses the same allocation modes as fixed-fee revenue.

**Data-quality flags** returned alongside every profitability response: `missing_cost_rate` (per user), `missing_billable_rate` (per project), `missing_project_dates` (fixed-fee projects with no window, so single-fee recognition falls back to hours), each with the specific entity IDs so the UI can offer an inline fix.

### 4.8 Invoice state machine

```
                 ┌──────────────────────────────────────────┐
                 ▼                                          │
   [draft] ──send──▶ [open] ──payment (partial)──▶ [open]   │ edit
      │               │  │                                  │ (draft only)
      │               │  └──payment (full)──▶ [paid] ───────┘
      │               │
      │               ├──write_off──▶ [written_off]
      │               └──close──────▶ [closed]
      └──delete──▶ (gone, audit row retained)
```

- `open` is derived into the UI label `Sent` or `Late` by comparing `due_date` to today. Lateness is not a stored state.
- **Send** performs, in one transaction: revalidate attached entries and expenses against the generated line items, aborting with `attached_entries_changed` if any changed since the lines were generated (the UI offers a one-click "Regenerate lines"); set `state='open'`; set `sent_at`; set `rates_locked_at` on every attached time entry and expense; execute the retainer draw, if any (§4.12); mint a `pay_token`; write an `invoice_messages` row; and enqueue the email. If the email later fails, the invoice stays `open` and a notification tells the sender to retry; we do not roll back the state, because the client may already have the link.
- **Edit after send** is allowed for Administrators and Accounting, rotates the `pay_token`, and writes a loud audit row. Attached entries stay locked.
- **Delete** is only possible from `draft` unless the actor is an Administrator; deleting a sent invoice detaches its entries (making them uninvoiced again), reverses any retainer draw (§4.12), and writes an audit row with the full invoice snapshot in `before`.
- **Write off** sets `state='written_off'` and leaves entries attached and locked, so the work is not double-billed later. Any retainer draw is reversed with a compensating transaction (§4.12).
- **Payments** are additive rows. Voiding a payment sets `voided_at`, recomputes `paid_cents`, and can move an invoice from `paid` back to `open`.

**Numbering.** `settings.invoice_number_pattern` supports `{seq}`, `{seq:N}` (zero-padded), `{year}`, `{yy}`, `{month}`, `{client_code}`, `{project_code}`. A per-client `invoice_prefix` overrides the pattern's static prefix. The sequence is drawn inside the creating transaction with `SELECT ... FOR UPDATE` on the settings row, so concurrent creates cannot collide. Manual override is allowed and validated against the unique index, which returns a friendly conflict rather than a 500.

### 4.9 Timer rules

- **One running timer per user**, enforced by the partial unique index, not by application logic. Starting a second one is a single transaction that must **stop the running entry first, then insert** the new one; the reverse order trips the unique index. The API accepts `POST /time-entries/:id/start` and handles the stop implicitly, returning both entries so the client can show the combined toast.
- **Task defaulting.** A timer started with only a project (command palette `⌥Enter`, quick-resume) resolves its task as: the actor's most recently used task on that project, else the project's first billable `project_task` ordered by task name. The same rule pre-fills the task combobox in the picker; there is no stored "default task" field.
- **Stopping** sets `duration_seconds += extract(epoch from now() − timer_started_at)`, sets `ended_at = now()` when the account tracks clock times, and nulls `timer_started_at`. The addition happens in SQL so the server clock is authoritative.
- **Elapsed time is never sent as a running total.** The API returns `duration_seconds` and `timer_started_at`; the client computes the live value. This makes a sleeping laptop, a stale tab, and a clock-skewed device all correct.
- **Runaway timers.** A nightly job stops any timer running longer than 16 hours, sets its duration to the elapsed time capped at 12 hours, flags the entry `needs_review`, and notifies the owner. The 16/12 split is deliberate: we stop the bleeding but do not silently invent a plausible-looking number.
- **Locking.** A timer cannot start on an archived project, an archived project task, a project the user is not assigned to, or a date in a locked or approved period.

### 4.10 Editability

A single `canEdit(record, actor)` predicate, applied identically to time entries and expenses:

```
locked if record.invoice_id is set AND that invoice.state <> 'draft'
locked if record.billed_externally
locked if an APPROVED timesheet_submission exists for record.user_id whose period
         contains record.spent_on
         -- period-based, not row-membership: an entry back-dated into an approved
         -- week is locked too, closing the post-approval loophole
locked if settings.lock_timesheets_after_days is set AND
         spent_on < today − lock_timesheets_after_days
Administrators and People Admins bypass all four, and every bypass writes an audit row
tagged 'override' so the amendment is visible in the activity log.
```

**Creating** a record dated into an approved period is refused with `period_approved` for the owner. An admin override creates it, flags the submission `amended`, and notifies the approver, so an approved week can never change silently.

**Concurrency** is last-write-wins, by explicit decision: with eleven users the collision window is negligible, every write is audited with before and after values, and the audit log is the recovery path. Mutations therefore carry no `If-Match` precondition. If this ever bites, adding an `updated_at` check per endpoint is a one-line change; do not build it speculatively.

### 4.11 Uninvoiced amounts

One predicate, shared by the Time report, the Invoicing report, the project KPI card, and invoice line generation:

```
uninvoiced(record) = invoice_id IS NULL AND NOT billed_externally AND is_billable
```

`billed_externally` marks records invoiced in Harvest before migration, where no invoice row exists in Tally (§16.2). Without it, every historical billable hour would masquerade as receivable.

Amounts by project type:

- **Time & Materials:** `Σ duration × billable_rate` over uninvoiced entries, plus uninvoiced billable expense totals.
- **Fixed Fee:** `fees_to_date − invoiced_amount`, floored at zero (over-billing shows zero with a `overbilled` data-quality flag, never a negative receivable). `fees_to_date` is the full fee for `fee_cadence = 'single'`, and elapsed whole months of the active window times the monthly fee for `'monthly'`.
- The Time report's summary figure **excludes** Fixed Fee projects and says so in its caption; the project KPI card and the Invoicing report **include** them via the formula above.

### 4.12 Retainer draws

A draw is recorded at **send time**, never on a draft. Inside the send transaction: validate `draw ≤ retainer.balance_cents` (abort with `retainer_insufficient` otherwise), insert a `draw` transaction, decrement the balance, and set `invoices.retainer_draw_cents`. Writing off or deleting a sent invoice inserts a compensating `adjust` transaction restoring the balance, linked to the same invoice so the ledger shows both movements. The draft editor displays the intended draw but touches nothing.

---

## 5. Service layer

Every service module exports functions with this shape:

```ts
type Ctx = {
  actor: { userId: string; profileId: string; capabilities: Set<Capability>; kind: 'user'|'system'|'api' };
  db: Database;                 // pool or an open transaction
  now: () => Date;              // injectable clock, so tests are deterministic
  requestId: string;
  audit: (entry: AuditInput) => void;    // buffered, flushed with the transaction
  emit:  (event: DomainEvent) => void;   // written to the outbox in the same transaction
};

export async function createTimeEntry(ctx: Ctx, input: CreateTimeEntry): Promise<TimeEntry>
```

Rules:

1. **Authorize first, in the service.** `assertCan(ctx, 'time:create_own')` and, for entries on behalf of someone else, `assertCanEditTimeFor(ctx, targetUserId)`. Route handlers never make the authorization decision; they only surface the error.
2. **One transaction per public service call.** A service that needs another service's behaviour passes the open transaction through `ctx.db`.
3. **Audit and events are buffered in `ctx` and flushed inside the transaction.** No event escapes a rollback.
4. **Return DTOs, not rows.** The serializer strips cost rates for actors without `rates:view_cost`, so a permission bug cannot leak money data through an unrelated endpoint.
5. **Never `SELECT *`.** Every query names its columns, so adding a column cannot silently widen a payload.

### 5.1 Module inventory

| Module | Responsibilities |
|---|---|
| `services/time` | CRUD, start/stop, bulk day operations, copy-previous-day, split, duplicate, week-grid upsert, running-timer resolution |
| `services/expenses` | CRUD, receipts, reimbursement state |
| `services/approvals` | submit (covering the period's time entries and expenses together), approve, request changes, flag computation, reminders |
| `services/people` | users, roles, departments, profiles, assignment, invites |
| `services/rates` | dated rate CRUD with overlap validation, `resolveRates`, re-rate job |
| `services/projects` | projects, tasks on projects, members, tags, duplication, archive cascade |
| `services/clients` | clients, contacts, archive guard |
| `services/tasks` | global task library, common-task propagation |
| `services/budgets` | spend computation, threshold evaluation, alert dispatch |
| `services/invoices` | CRUD, state machine, numbering, totals, line generation from time and expenses, payments, sends, PDF request |
| `services/recurring` | schedule math, generation, pause/resume |
| `services/retainers` | balance ledger, draws |
| `services/reports` | time, profitability, team, contractor, invoicing, detailed, custom builder, saved reports |
| `services/bulk` | the action registry and executor |
| `services/imports` `services/exports` | CSV mapping, validation, apply, revert; async export generation |
| `services/audit` | write and query |
| `services/events` | outbox drain and Redis publish |

---

## 6. HTTP API

`/api/v1`, JSON, cookie session for the app and `Authorization: Bearer` for personal access tokens. The same surface serves both, with token scopes narrowing capabilities.

### 6.1 Conventions

- Collections return `{ data: T[], meta: { total, page, per_page, has_more } }`. Single resources return `{ data: T }`.
- **Grouped collections carry their own group headers and totals.** The client grid is AG Grid Community, which has no row grouping or aggregation, so any endpoint backing a grouped list returns rows already in display order with group headers interleaved, plus a grand total:
  ```json
  { "data": [
      { "_kind": "group", "_id": "client:abc", "label": "Example Client 04",
        "totals": { "hours": 1307.97, "cost_cents": 2395830 } },
      { "_kind": "data", "_id": "proj:def", "name": "PRODUCT OWNER & UX", "...": "..." }
    ],
    "meta": { "total": 40, "totals": { "hours": 3672.18, "cost_cents": 7125182 } } }
  ```
  This keeps every total on the same rounding rules and permission scoping as the reports, which client-side aggregation could not guarantee. `meta.totals` always covers the full result set, not the page.
- Pagination is `?page=&per_page=` (max 200) for stable lists, and cursor-based (`?cursor=`) for the audit log and time entries.
- Filtering uses explicit query params, never a generic query language: `?from=&to=&user_id=&project_id=&client_id=&is_billable=&invoiced=`.
- Sorting is `?sort=field` and `?sort=-field` for descending, validated against an allowlist per resource.
- Sparse fieldsets via `?include=` for expansions (`?include=project,task,user`), also allowlisted.
- Errors are RFC 9457 problem details:
  ```json
  { "type": "https://tally.jhmg/errors/validation_failed",
    "title": "Validation failed", "status": 422,
    "detail": "duration_seconds must be at least 0",
    "request_id": "01J...", "code": "validation_failed",
    "errors": { "duration_seconds": ["must be at least 0"] } }
  ```
- `code` is drawn from a closed string-literal union shared with the client, so the UI can branch on error kind without string matching.
- Mutating requests accept an `Idempotency-Key` header. Requests that create money-moving records (invoices, payments) require one.
- `ETag` and `If-None-Match` on report responses; `Cache-Control: private, no-store` on everything else.

### 6.2 Endpoint inventory

**Time**
```
GET    /time-entries                    ?from&to&user_id&project_id&client_id&task_id&is_billable&invoiced&approved&cursor
POST   /time-entries
GET    /time-entries/:id
PATCH  /time-entries/:id
DELETE /time-entries/:id                soft delete, 10s Undo grace
POST   /time-entries/:id/restore
POST   /time-entries/:id/start          starts a NEW entry from this one's project/task/notes
POST   /time-entries/:id/stop
POST   /time-entries/:id/split          { at_seconds }
POST   /time-entries/:id/duplicate      { spent_on? }
GET    /time-entries/running            the caller's running entry, or null
POST   /timesheet/copy-day              { from, to, include_durations }
PUT    /timesheet/week                  bulk upsert of the week grid, one round trip
GET    /timesheet/summary               ?from&to&user_id  → per-day totals, capacity, flags
```

**Expenses**
```
GET|POST /expenses
GET|PATCH|DELETE /expenses/:id
POST   /expenses/:id/receipt            → presigned PUT
DELETE /expenses/:id/receipt
POST   /expenses/reimbursements/approve { ids }
POST   /expenses/reimbursements/pay     { ids, paid_at }
GET|POST /expense-categories
PATCH|DELETE /expense-categories/:id
```

**Approvals**
```
GET    /approvals                       ?period_start&state
POST   /approvals/submit                { period_start } (self)
POST   /approvals/:id/approve
POST   /approvals/:id/request-changes   { note }  (note required)
POST   /approvals/remind                { period_start, user_ids? }
GET    /approvals/me
```

**People**
```
GET|POST /users
GET|PATCH /users/:id
POST   /users/:id/archive | /restore | /invite | /reset-password
GET|POST /users/:id/rates
PATCH|DELETE /users/:id/rates/:rateId
GET|PUT  /users/:id/project-assignments
GET|PUT  /users/:id/managed-users
GET|PUT  /users/:id/notification-prefs
GET|POST /roles  ·  PATCH|DELETE /roles/:id
GET|POST /departments  ·  PATCH|DELETE /departments/:id
GET|POST /permission-profiles  ·  PATCH|DELETE /permission-profiles/:id
GET      /me      ·  PATCH /me   ·  GET /me/capabilities
GET|POST /me/tokens  ·  DELETE /me/tokens/:id
GET      /me/sessions ·  DELETE /me/sessions/:id
```

**Organize**
```
GET|POST /clients   ·  GET|PATCH|DELETE /clients/:id  ·  POST /clients/:id/archive|/restore
GET|POST /clients/:id/contacts  ·  PATCH|DELETE /contacts/:id
GET|POST /projects  ·  GET|PATCH|DELETE /projects/:id
POST   /projects/:id/archive|/restore|/duplicate
POST   /projects/:id/pin | /unpin       per-user (user_pinned_projects), not account-wide
GET|PUT  /projects/:id/tasks       ·  GET|PUT /projects/:id/members
GET      /projects/:id/summary     KPI card payload in one request
GET      /projects/:id/chart       ?metric=progress|hours&from&to&granularity
GET|POST /tasks     ·  GET|PATCH|DELETE /tasks/:id  ·  POST /tasks/:id/archive
GET|POST /tags      ·  DELETE /tags/:id
```

**Bill**
```
GET|POST /invoices  ·  GET|PATCH|DELETE /invoices/:id
POST   /invoices/:id/send            { to, cc, bcc, subject, body, attach_pdf }
POST   /invoices/:id/reminder        · /thank-you
POST   /invoices/:id/mark-sent | /close | /write-off | /duplicate
GET|POST /invoices/:id/payments      ·  POST /invoices/:id/payments/:pid/void
GET|POST /invoices/:id/attachments   ·  DELETE /attachments/:id
GET    /invoices/:id/pdf             302 to a signed Spaces URL, generating on demand
POST   /invoices/preview-lines       { project_ids, from, to, grouping } → line items, no writes
GET|PUT  /invoices/:id/projects      link and unlink
GET|POST /recurring-invoices  ·  GET|PATCH|DELETE /recurring-invoices/:id
POST   /recurring-invoices/:id/pause | /resume | /run-now
GET|POST /retainers  ·  GET|DELETE /retainers/:id
POST   /retainers/:id/transactions
GET|PUT  /invoice-item-types
```

**Review**
```
GET /reports/time            ?from&to&group_by=client|project|task|user&filters…
GET /reports/time/detailed
GET /reports/profitability   ?from&to&group_by&basis=tracked|invoiced&fee_allocation=…
GET /reports/team            ·  /reports/contractor
GET /reports/invoicing       ?view=uninvoiced|receivables|payments|tax
GET /reports/expenses/detailed
POST /reports/custom         { measure, group_by[], filters, visualize }
GET|POST /saved-reports  ·  GET|PATCH|DELETE /saved-reports/:id  ·  POST /saved-reports/:id/run
POST /exports                { kind, filters, format }  → 202 + job id, emailed when ready
GET  /exports/:id
```

**Platform**
```
GET|PATCH /settings
GET|POST  /bulk-actions            list the registry / execute
GET       /bulk-actions/runs  ·  GET /bulk-actions/runs/:id  ·  POST /bulk-actions/runs/:id/revert
POST      /imports                 → presigned upload + mapping
POST      /imports/:id/validate | /apply | /revert
GET       /audit-log               ?actor&entity_type&entity_id&action&from&to&cursor
GET       /notifications  ·  POST /notifications/read
GET|DELETE /integrations/:provider ·  GET /integrations/:provider/authorize
GET       /search                  ?q  the command palette's backing endpoint
GET       /live                    SSE
GET       /health/live | /health/ready
```

### 6.3 The endpoints that carry the most weight

**`PUT /timesheet/week`** exists so the week grid is one round trip instead of thirty. Body:

```json
{ "user_id": "…", "week_start": "2026-08-10",
  "rows": [ { "project_id": "…", "project_task_id": "…", "notes": "…",
              "days": { "2026-08-10": 18000, "2026-08-11": 22080 } } ] }
```

The service diffs against existing entries for that week and that row key (project + task + notes), then creates, updates, and soft-deletes as needed. It returns the full resulting week so the client can reconcile in one shot. It refuses to touch locked entries and reports them in a `skipped` array rather than failing the whole request.

**`GET /search`** backs the command palette. A single query across projects, clients, users, tasks, and invoices using a Postgres `tsvector` column maintained by trigger on each table, unioned and ranked, plus a trigram index for fuzzy matching on short queries. Capped at 5 per type with per-type totals so the UI can offer "show all". Results are permission-filtered before ranking, never after.

**`GET /projects/:id/summary`** returns everything the five KPI cards need in one query set: hours split, budget spend and remaining, internal cost split, invoiced total, uninvoiced total and project fees. Built as a single CTE chain so the project page needs two requests total (summary and chart), not seven.

### 6.4 Rate limiting

Redis token buckets, per actor, per route class:

| Class | Limit |
|---|---|
| Read | 600 / minute |
| Write | 120 / minute |
| Report | 30 / minute |
| Export and PDF | 10 / minute |
| Send email (invoice, reminder) | 30 / hour |
| Auth (signin, invite, reset) | 10 / 15 min per IP and per email |

Exceeding returns 429 with `Retry-After`. The client backs off and surfaces a toast rather than failing silently.

### 6.5 Validation

One Zod schema per operation in `src/schemas/`, imported by both the route handler and the client form. Cross-field rules (an end time after a start time, a rate range that does not overlap, a budget that requires a `budget_by`) live in `.superRefine` so the error attaches to the right field. Unknown keys are stripped, never accepted.

### 6.6 Versioning

`/api/v1` is frozen once the first personal access token is issued. Additive changes only: new optional fields, new endpoints. A breaking change mints `/api/v2` and both run until every token holder migrates.

### 6.7 Idempotency and offline replay

The client queues mutations in IndexedDB while offline and replays them in order on reconnect, each carrying an `Idempotency-Key` (a client-generated UUID, stable across retries).

Server behaviour:

1. On receipt, `INSERT ... ON CONFLICT DO NOTHING` into `idempotency_keys` with the key, route, and a hash of the body.
2. If the insert wins, process normally and write the response status and body back to the row.
3. If it loses, and the stored `request_hash` matches, return the stored response verbatim with `Idempotency-Replayed: true`.
4. If it loses and the hash differs, return 409 `idempotency_key_reused`.

Keys expire after 24 hours via a nightly sweep. This is what makes "go offline, log three entries, reconnect" produce exactly three entries.

---

## 7. Authentication and authorization

### 7.1 Authentication

**Auth.js v5**, database session strategy (sessions in Postgres, not JWTs, so revocation is immediate).

- **Google Workspace OIDC** with `hd` pinned to `jhmediagroup.com`. The `hd` claim is verified server-side; a Google account outside the domain is rejected even if it authenticates. First sign-in matches an existing `users` row by email; it never auto-creates. Provisioning is by invite only.
- **Email and password** for external contractors: an Administrator sends an invite, which mints a single-use token (32 bytes, hashed at rest, 7-day expiry). The invitee sets a password hashed with argon2id (`m=19456, t=2, p=1`). Password sign-in is rate limited per IP and per email, and can be disabled account-wide from Settings when everyone is in the Workspace.
- **Two-factor** (TOTP) is optional per user and enforceable account-wide with a grace period. Ten single-use recovery codes are issued at enrolment, hashed at rest.
- **Sessions:** httpOnly, `Secure`, `SameSite=Lax` cookie, 30-day rolling expiry, absolute cap 90 days. Every session row records device, IP, and last-seen so the user can review and revoke.
- **Personal access tokens:** `tally_pat_` prefix plus 32 random bytes, shown once, stored as a SHA-256 hash with the prefix kept in the clear for identification. Scoped and expirable.

### 7.2 Capabilities

Authorization is capability-based, not role-name-based. A profile is a set of capability strings; code asks for capabilities, never for profile names.

```
time:create_own          time:edit_own          time:delete_own
time:view_others         time:edit_others       time:delete_others
expense:*                (same shape)
approval:submit          approval:review        approval:review_all
project:view             project:manage         project:manage_own      project:archive
client:view              client:manage
task:manage
people:view              people:manage          people:invite
rates:view_billable      rates:view_cost        rates:manage
invoice:view             invoice:manage         invoice:send            invoice:delete
report:view_own          report:view_team       report:view_all         report:view_financial
settings:manage          integrations:manage    audit:view              bulk:execute
```

Base profile mapping:

| Capability group | Member | Project Mgr | People Admin | Accounting | Exec Mgr | Admin |
|---|:--:|:--:|:--:|:--:|:--:|:--:|
| time own | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| time others | | team | all | | all | all |
| approval:review | | team | all | | all | all |
| project:manage | | ✓ | | | ✓ | ✓ |
| client:manage | | ✓ | | ✓ | ✓ | ✓ |
| people:manage | | | ✓ | | ✓ | ✓ |
| rates:view_billable | | team | | ✓ | ✓ | ✓ |
| rates:view_cost | | | | | | ✓ |
| rates:manage | | team | | | | ✓ |
| invoice:* | | | | ✓ | ✓ | ✓ |
| report:view_financial | | | | ✓ | ✓ | ✓ |
| settings:manage | | | | | | ✓ |
| audit:view | | | | | | ✓ |

"team" means scoped through `user_managed_users` and `project_members.is_manager`.

**Rates, and why a Project Manager holds two of these.** A project manager
prices the work their projects sell, so they set what a client is charged.
What a person costs is a different fact about a colleague: writing a cost
rate requires `rates:view_cost` on top of `rates:manage`, which no profile but
Administrator holds. Both cells read `team` rather than a tick because reach
applies to the number as well as the row: this profile sees and sets rates for
the people it manages and answers 404 for anybody else. **Nobody sets their
own rate except the account owner**, for the same reason nobody changes their
own permission profile.

### 7.3 Enforcement

Three layers, all mandatory:

1. **Capability gate** - `assertCan(ctx, 'invoice:manage')` at the top of every service function.
2. **Scope filter** - every list query composes a scope predicate from the actor. A Project Manager's `/time-entries` query is filtered to their managed users and managed projects at the SQL level, not in application code after the fetch. This is the layer that prevents the classic "forgot the WHERE clause" leak.
3. **Field redaction** - the serializer strips `cost_rate_cents`, `billable_rate_cents`, and every derived money field the actor lacks capability for, on the way out. A capability bug therefore fails closed rather than leaking.

Requests for records outside scope return **404, not 403**, so the API never confirms the existence of a record the actor cannot see.

An integration test asserts, for each base profile, that every endpoint returns the expected status. A new endpoint without a row in that matrix fails the test suite.

### 7.4 Project report visibility

`projects.report_visibility = 'everyone'` grants people assigned to the project a scoped, money-free read of that project's report, regardless of profile. Exactly these fields: total hours, the billable versus non-billable split, per-task hours, per-person hours, and the budget percentage consumed (the percentage only, never the underlying hours ceiling or currency value). Never: rates, billable amounts, costs, fees, invoices, or profitability. The field list is exported as a constant; the serializer enforces it the same way capability redaction does (§7.3), and the frontend's "What will people see?" popover renders from the same constant, so the promise and the enforcement cannot drift.

---

## 8. Real-time

### 8.1 Transport

Server-Sent Events at `GET /api/live`, not WebSockets. Rationale: the traffic is entirely server-to-client, SSE traverses Caddy with no special configuration, it reconnects natively with `Last-Event-ID`, and it costs one long-lived HTTP response per client. With eleven users this is trivial.

- Auth is the normal session cookie.
- The handler subscribes to Redis channels `account` and `user:{id}` and writes events as they arrive.
- A 25-second `:keepalive` comment prevents proxy timeouts.
- `Last-Event-ID` on reconnect replays from an in-Redis ring buffer of the last 200 events (a 5-minute window), so a brief disconnect loses nothing.
- `X-Accel-Buffering: no` and `Cache-Control: no-cache, no-transform` so nothing buffers the stream.

### 8.2 Event taxonomy

Every event is `{ id, type, at, actor_id, payload }`. Types:

| Event | Channel | Carries | Consumers |
|---|---|---|---|
| `timer.started` / `timer.stopped` | `user:{id}` and `account` | entry id, project, task, `timer_started_at`, `duration_seconds` | Timer widget across tabs, Team presence dots |
| `time_entry.created` / `.updated` / `.deleted` | `user:{id}` | full entry | Timesheet views |
| `expense.created` / `.updated` | `user:{id}` | expense | Expenses |
| `approval.submitted` / `.approved` / `.changes_requested` | `account`, `user:{id}` | submission | Approvals queue, sidebar count, submitter banner |
| `invoice.sent` / `.paid` / `.state_changed` | `account` | invoice id, state, totals | Invoices list, sidebar late count, project page |
| `budget.threshold_crossed` | `account` | project id, percent, threshold | Projects list, notifications bell |
| `project.updated` / `.archived` | `account` | project id | Projects list, pickers |
| `notification.created` | `user:{id}` | notification | Bell |
| `bulk_action.progress` / `.completed` | `user:{id}` | run id, counts | Bulk action progress |
| `import.progress` / `.completed` | `user:{id}` | run id, counts | Import wizard |

### 8.3 The outbox

Events are written into `outbox` inside the same transaction as the data change. The **worker** runs the single drain loop - a 250ms poll with a Postgres `LISTEN/NOTIFY` wake-up so the common case is near-instant. Next.js has no clean home for a background loop, so the web process never drains; the cost is one process hop of latency, well inside the 1-second liveness target, and it removes the need for a Redis leader lock. At-least-once delivery; clients deduplicate by event id.

This is why an event can never describe a change that did not commit.

---

## 9. Background jobs

### 9.0 What is built, and why it is not BullMQ yet

**Amended 2026-08-14 (TALLY-26).** The table below is the target once jobs exist that
need real retry semantics. It is not what runs today, and the difference is deliberate.

Three jobs are built, and all run from cron rather than a queue:

| Script | `pnpm` | Cron | Does |
|---|---|---|---|
| `scripts/sweep.mts` | `pnpm sweep` | `0 3 * * *` | Purges dead sessions and expired idempotency claims |
| `scripts/recurring.mts` | `pnpm jobs:recurring` | `0 6 * * *` | Raises the recurring invoices due today |
| `scripts/mail.mts` | `pnpm jobs:mail` | `*/5 * * * *` | Sends the queued outbound mail |

The reasoning, so this is a decision and not a shortcut:

- **Amended 2026-08-15 (TALLY-49).** The first two talk only to Postgres, in a transaction, so
  retry with backoff had nothing to retry. **`jobs:mail` breaks that argument**: an SMTP server
  greylists, rate limits and goes down, which is precisely what backoff is for. The retry state
  lives in the row (`attempts`, `next_attempt_at`, `last_error`) instead of in a queue, which
  keeps the single-process deployment and makes the backlog inspectable with SQL, but it is a
  queue in all but name. The case for BullMQ is now weaker than it looks below, because the one
  thing it would have added is built.
- **Idempotency lives in the data, which is the stronger place for it.** `issueIfDue` takes a
  row lock and rechecks the due date under it, so a second run raises nothing, two overlapping
  runs cannot both bill a schedule, and a person pressing Issue now mid-run is serialised
  against the job. A queue's exactly-once guarantee would sit above the database and be weaker
  than the one the database already gives.
- **A queue would make Redis load-bearing for correctness.** Today Redis is an optimisation for
  rate limiting with an in-process fallback, and the droplet survives losing it. Billing must
  not acquire that dependency for nothing.
- **It would add a second process to deploy and watch,** on a single droplet, for about thirty
  invoices a month.

**Adopt BullMQ when the first job that calls something flaky ships** - `email` (TALLY-19) or
`pdf` (TALLY-21). Those genuinely need attempts, backoff and a dead-letter queue. At that point
the two cron jobs move onto it for consistency, not because cron failed them.

Until then, the operational contract is: **safe to run at any time, safe to run twice, and a
missed day is fixed by running it again.** The failure mode is "late", never "billed twice".
`tests/recurring-job.test.ts` asserts each of those against the database, and
`tests/jobs.test.ts` asserts that every job script has a `pnpm` entry and a cron line in this
table, because a job nobody scheduled is the failure that looks exactly like everything working.

### 9.1 Target design

BullMQ over Redis. The `worker` container runs every processor. Queues, concurrency, and retry policy:

| Queue | Trigger | Concurrency | Retry |
|---|---|---|---|
| `email` | on demand | 5 | 5 attempts, exponential from 10s |
| `pdf` | on demand and on send | 2 | 3 attempts |
| `recurring-invoices` | cron `0 6 * * *` (account timezone) | 1 | 3 attempts |
| `budget-alerts` | cron `*/15 * * * *` | 1 | 2 attempts |
| `timesheet-reminders` | cron `*/5 * * * *`, matched against per-user reminder settings | 1 | 2 attempts |
| `approval-nudges` | cron `0 9 * * MON` | 1 | 2 |
| `weekly-summary` | cron `0 8 * * MON` | 1 | 2 |
| `saved-report-delivery` | cron `*/15 * * * *`, matched against `saved_reports.schedule` | 1 | 2 |
| `invoice-late-sweep` | cron `0 5 * * *` | 1 | 2 |
| `runaway-timers` | cron `0 3 * * *` | 1 | 2 |
| `quickbooks-sync` | on invoice state change, plus cron `0 */4 * * *` reconcile | 1 | 5, with a dead-letter queue |
| `imports` | on demand | 1 | none (failures are reported, not retried) |
| `exports` | on demand | 2 | 2 |
| `bulk-actions` | on demand | 1 | none |
| `re-rate` | on demand | 1 | none |
| `backup` | cron `0 4 * * *` | 1 | 3 |
| `retention` | cron `0 4 * * SUN` | 1 | 2 |

Rules:

- **Every job is idempotent.** Recurring-invoice generation checks `last_issued_on` inside the transaction. Budget alerts check the Redis dedupe key. Email jobs carry a dedupe key derived from the recipient and the entity.
- **Cron jobs use BullMQ repeatable jobs with a fixed `jobId`,** so a redeploy does not schedule duplicates.
- **Failures write to a dead-letter queue** and raise a Sentry event. A `/settings/integrations` panel surfaces the QuickBooks dead-letter count with a Retry action.
- **Long jobs stream progress** through the outbox so the UI can show a progress bar.

### 9.1 Notable job logic

**`recurring-invoices`** selects rows where `state='active' AND next_issue_on <= today`. For each, in one transaction: build the invoice from `template`, draw the number, insert it, compute `next_issue_on` from the schedule, decrement `occurrences_remaining`, set `state='completed'` when the schedule ends, and enqueue a send if `send_automatically`. Month-end handling: `day_of_month = 31` on a 30-day month issues on the last day, and the schedule preview in the UI shows exactly this.

**`budget-alerts`** evaluates every project with `budget_alert_percent` set. Spend uses the same `services/budgets` code the UI uses, so the alert and the bar can never disagree. Crossing the threshold writes a `notifications` row, emits `budget.threshold_crossed`, emails the project managers, and posts to the configured Slack channel.

**`invoice-late-sweep`** finds `open` invoices past `due_date`, emits `invoice.state_changed` so the UI badge updates, and enqueues reminder emails per the account's reminder schedule (configurable: 3 days before due, on the due date, then every 14 days after, up to 3 reminders).

---

## 10. Email

React Email templates rendered to HTML plus a plain-text alternative, sent through Resend.

| Template | Trigger | Recipients |
|---|---|---|
| Invite | Administrator invites a person | invitee |
| Password reset | user request or admin action | user |
| Timesheet reminder | per-user schedule | user |
| Timesheet approval requested | submission | approvers |
| Timesheet approved / changes requested | review | submitter |
| Weekly summary | Monday | opted-in users |
| Budget alert | threshold crossing | project managers and administrators |
| Invoice | send | client contacts, optional copy to sender |
| Invoice reminder | schedule or manual | client contacts |
| Payment thank-you | payment recorded | client contacts |
| Export ready | export job completes | requester |
| Import completed | import job completes | requester |

All client-facing templates use the account's invoice branding (logo, brand colour, banner) so an invoice email and the invoice PDF look like one artefact. Every email carries a plain-text part, a `List-Unsubscribe` header where applicable, and a footer identifying JH Media Group. Delivery events (delivered, bounced, complained) are recorded against `invoice_messages` via a Resend webhook, and a bounce surfaces on the invoice detail page.

DNS: SPF, DKIM, and DMARC configured for the sending domain before the first send.

---

## 11. Files and PDF

### 11.1 Storage

DigitalOcean Spaces, private bucket, S3 API.

- Uploads go **direct from the browser** to Spaces via a presigned `PUT` issued by `POST /:resource/:id/receipt`. The server never proxies file bytes.
- Presigned URLs expire in 5 minutes and are constrained by `Content-Type` and `Content-Length`.
- Downloads go through a presigned `GET`, 5-minute expiry, issued only after a permission check. Object keys are opaque UUID paths, never guessable, but the permission check is what protects them.
- Key layout: `receipts/{yyyy}/{mm}/{expense_id}/{uuid}`, `invoices/{invoice_id}/pdf/{version}.pdf`, `logos/{uuid}`, `avatars/{user_id}/{uuid}`, `exports/{job_id}/{filename}`, `backups/{yyyy-mm-dd}/…`.
- Limits: receipts 10 MB (`image/*`, `application/pdf`), invoice attachments 20 MB, logos 5 MB. Enforced in the presign constraints and re-checked on the `finalize` call, which is what actually writes the DB row.
- Uploaded images are re-encoded by the worker (stripping EXIF, generating a 320px thumbnail) so a malicious file never round-trips to another user's browser as-is.

### 11.2 PDF

The invoice PDF is generated by Playwright chromium in the worker, rendering the **same** `<InvoiceDocument>` React component the app and the pay page use, served from an internal-only route (`/internal/invoice/:id/print`, allowlisted to the worker's network identity and a signed short-lived token).

- Generated on first request and on every mutation of the invoice, cached in Spaces keyed by a content hash so a repeat download is a redirect, not a render.
- `GET /invoices/:id/pdf` returns 302 to the presigned URL when the cached version is current, or 202 with a job id when a render is needed, with the client polling or listening on SSE.
- Bulk "Download as PDF" renders in the worker, zips, uploads, and emails a link.

---

## 12. Integrations

All connections live in `integration_connections` with tokens encrypted at rest using AES-256-GCM under a key from `TALLY_ENCRYPTION_KEY` (envelope encryption; the key never leaves the environment).

### 12.1 Google Workspace SSO
OIDC through Auth.js. `hd` claim pinned and verified server-side. Provisioning is invite-only.

### 12.2 Google Calendar
Per-user OAuth (`calendar.readonly`). Selected calendars stored in `config`. Events are fetched on demand for the visible date range and cached in Redis for 5 minutes; nothing is stored in Postgres. The Calendar view overlays them, and "Track this" converts one into a time entry, carrying the event title into the notes and the event ID into `external_ref` so the same event cannot be tracked twice without a confirmation.

### 12.3 QuickBooks Online
Account-level OAuth 2.0 with refresh-token rotation.

- **Direction:** Tally is the source of truth for invoices; QuickBooks receives them. We do not import invoices from QuickBooks.
- **On invoice send** (and on payment recording), a `quickbooks-sync` job upserts the QBO Invoice, creating the Customer and the Item if needed. The QBO ID is written to `invoices.external_ref.quickbooks`.
- **Mapping:** `invoice_item_types.qbo_income_account_id` maps our item types to QBO income accounts. `clients.external_ref.quickbooks` maps to QBO Customers. Both are surfaced in the integration settings for manual correction.
- **Reconcile cron** every 4 hours compares recently changed invoices against QBO and reports drift to the integration panel rather than auto-resolving it, because silently overwriting an accountant's edit is worse than surfacing a conflict.
- **Failure handling:** 5 retries with exponential backoff, then a dead-letter row visible in settings with the QBO error text and a Retry button. A sync failure never blocks sending the invoice to the client.

### 12.4 Slack
Account-level OAuth (`chat:write`, `im:write`, `users:read.email`). Two uses: budget alerts and invoice-paid notices posted to a configured channel, and per-user timesheet reminder DMs (matched to Slack users by email). A `/tally` slash command is a Phase 5 candidate and is explicitly not in v1.

### 12.5 Stripe
Account-level Connect or direct keys. Used only for client payment of invoices through the public pay page (Checkout Session, card and ACH). The `checkout.session.completed` and `charge.refunded` webhooks are verified by signature, then create or void an `invoice_payments` row keyed by `gateway_txn_id` so a replayed webhook is a no-op. Webhook handlers are idempotent, respond within 3 seconds, and enqueue everything slow.

### 12.6 Public API
The `/api/v1` surface with personal access tokens is the integration point for Zapier and internal scripts. Rate limits apply per token. Scopes narrow capabilities but can never exceed the owning user's profile.

---

## 13. Import, export, and bulk actions

### 13.1 Imports

A three-phase pipeline, all phases recorded on `import_runs`:

1. **Upload and detect.** CSV goes to Spaces via presign. The worker reads the header row, auto-detects the mapping against known column names (including the exact headers Harvest exports), and returns a proposed mapping.
2. **Validate.** Every row is parsed and checked without writing: type coercion, referential lookups (does this client exist, this project, this task, this person), permission checks, and business rules. Returns a per-row result with field-level errors. The UI shows the first 20 plus a full error CSV download.
3. **Apply.** Rows insert inside a single transaction per 500-row chunk, with created IDs accumulated into `import_runs.created_ids`.

**Revert** deletes exactly those IDs, refusing if any has since been referenced by an invoice or an approval, and reporting which ones and why.

Import kinds in v1: time entries, expenses, projects, clients, people, tasks.

### 13.2 Exports

`POST /exports` enqueues a job. Small exports (under 5,000 rows) stream back synchronously as CSV. Larger ones generate to Spaces and email a 7-day link. Formats: CSV (default), XLSX, and JSON for the full-account export.

Every export includes a header row of human labels plus a machine-readable second sheet or sidecar describing the filters used, so an exported number can always be traced back to the query that produced it.

### 13.3 Bulk actions

A registry, `src/services/bulk/registry.ts`, where each action declares:

```ts
{
  key: 'projects.set_tasks_billable',
  domain: 'projects',
  label: 'Set tasks billable',
  description: 'Make tasks billable (or non-billable) across one or more projects. ' +
               'Re-rates hours already tracked against those tasks based on how each project bills.',
  capability: 'project:manage',
  targetSchema: z.object({ project_ids: z.array(z.string().uuid()).min(1) }),
  paramsSchema: z.object({ task_ids: z.array(z.string().uuid()), is_billable: z.boolean() }),
  preflight: async (ctx, targets, params) => Skip[],   // what will be skipped and why
  execute:  async (ctx, target, params) => Result,
  revert:   async (ctx, run) => void,                  // optional
}
```

The executor runs targets in chunks, records per-row results, streams `bulk_action.progress` events, and writes one `audit_log` row per affected entity plus one summarising the run. `preflight` is what powers the review step's skip list ("3 projects have running timers and will be flagged"), and it runs again inside the transaction so a race cannot slip past it.

The same registry drives the Settings page grid and the table bulk-action bar, so the two can never offer different actions.

---

## 14. Audit log

Every mutation writes an `audit_log` row inside the same transaction as the change. There is no code path that mutates without auditing, because the write happens in the service layer's transaction wrapper, not at each call site.

Recorded: actor (or `system` / `api` / `integration`), action string (`entity.verb`), entity type, id, and a human label captured at write time (so a deleted entity is still identifiable), the before and after JSON of changed fields only, the changed key list, request id, IP, and user agent.

Sensitive values are redacted before storage: password hashes, tokens, and secrets are replaced with `[redacted]`. Rate values **are** stored, because "who changed this cost rate and when" is exactly the question the log exists to answer.

Retention 24 months, then archived to Spaces as newline-delimited JSON and pruned. Query surface: `GET /audit-log` with filters, plus an entity-scoped history shown inline on invoice detail and person settings.

---

## 15. Observability and operations

**Logging.** pino, JSON to stdout, collected by Docker's json-file driver with rotation. Every log line carries `request_id`, `actor_id`, `route`, and `duration_ms`. Query timings above 200ms log at `warn` with the query name.

**Errors.** Sentry in both `web` and `worker`, with release tagging from the git SHA, source maps uploaded at build, and PII scrubbing on. Every API error response carries the `request_id` that appears in Sentry and the logs, and the UI offers "Copy error details" so a user can hand it over.

**Health.**
- `GET /api/health/live` - process is up. Used by Docker's healthcheck.
- `GET /api/health/ready` - Postgres reachable, Redis reachable, migrations at head. Used by the deploy script's gate.
- A `/api/health/queues` (admin-only) reports queue depths and dead-letter counts.

**Uptime.** An external check (Better Stack or UptimeRobot) hits `/api/health/ready` every minute and alerts by email and Slack.

**Backups.**
- Nightly `pg_dump --format=custom` at 04:00, gzipped, uploaded to Spaces under `backups/{date}/`. Retention: 30 daily, 12 weekly, 12 monthly.
- Weekly automated **restore verification**: the job restores the latest dump into a scratch database, runs a row-count and checksum comparison against production for the core tables, and alerts on mismatch. A backup that has never been restored is not a backup.
- DO volume snapshots weekly as a second line.
- Spaces bucket versioning on, with a lifecycle rule expiring non-current versions after 90 days.

**Recovery targets.** RPO 24 hours (nightly dump), RTO 2 hours (documented restore runbook in `docs/RUNBOOK.md`). Point-in-time recovery is a Phase 5 upgrade if the data warrants it.

**Metrics.** A small `/api/health/metrics` in Prometheus text format (request counts and latency histograms by route class, queue depths, SSE connection count, DB pool saturation) with basic-auth. Scraped only if a dashboard is later wanted; the endpoint costs nothing to ship now.

---

## 16. Harvest migration

A one-shot script, `scripts/harvest-import.mts`, runnable repeatedly and idempotently.

### 16.0 What was actually built, and why it differs (TALLY-46)

This section was written against the Harvest API. The migration was built against CSV exports, because no API credentials exist for the account (see docs/PERMISSIONS-AND-CREDENTIALS.md). §16.1 through §16.4 are kept as written: they remain the specification if a token ever arrives and a delta run becomes possible. What follows is what the shipped importer does instead.

**The source is seven files**, exported from Harvest's own report screens into `harvest exports/`: client, contact, people, project and task lists, a time report covering all history, and an expense report. Invoices are present only as PDFs, in `harvest_invoice_pack`.

**There are no Harvest ids in any of them.** The upsert key §16.1 specifies, `external_ref->'harvest'->>'id'`, cannot exist, so natural keys stand in: a client is its name, a project is its client plus its name, a person is their full name, a task is its name. Re-running is idempotent by deleting the rows the importer owns (`time_entries.source = 'import'`, and expenses by `external_ref`) and reloading them, inside one transaction. A partial load is not a state the database can end up in, which matters because the reconciliation is the only thing that can tell you the import was right and it cannot run against half a load.

**The files disagree about scope.** Current lists omit historical entities referenced by time and expense reports. Import entities from every source and archive those absent from current lists. History-only people receive an `@imported.invalid` address and no password.

**Four of the seventeen steps in §16.1 have no source and were not built:** invoice item types, invoices and lines, payments, and messages. §16.3 checks 3 and 6 depend on them and are reported as skipped rather than passed. `billed_externally` is still set, from the time report's `Invoiced?` column, so the uninvoiced report stays truthful even though the invoices behind it are not in the system.

**Two things needed a decision the data could not make:**

- Overnight entries can have an end time earlier than their start time. Validate the next-day interpretation against recorded hours and count those adjustments in the private reconciliation report.
- Possible duplicate people must be resolved privately by a human; the importer never merges identities on a guess.

**The reconciliation is a separate script,** `scripts/harvest-reconcile.mts` (`pnpm harvest:reconcile --write`), so it can be re-run against the database without re-importing. It re-reads the CSVs from scratch rather than trusting anything the importer held in memory.

### 16.1 Order and mapping

Dependencies dictate the order:

```
1. users                ← GET /v2/users            (incl. is_active=false)
2. user_rates           ← GET /v2/users/:id/billable_rates and /cost_rates
3. roles                ← GET /v2/roles
4. clients              ← GET /v2/clients
5. client_contacts      ← GET /v2/contacts
6. tasks                ← GET /v2/tasks
7. projects             ← GET /v2/projects
8. project_tasks        ← GET /v2/projects/:id/task_assignments
9. project_members      ← GET /v2/projects/:id/user_assignments
10. expense_categories  ← GET /v2/expense_categories
11. time_entries        ← GET /v2/time_entries      (paginated, all history)
12. expenses            ← GET /v2/expenses
13. invoice_item_types  ← GET /v2/invoice_item_categories
14. invoices + lines    ← GET /v2/invoices
15. invoice_payments    ← GET /v2/invoices/:id/payments
16. invoice_messages    ← GET /v2/invoices/:id/messages
17. estimates           ← skipped (out of scope; archived to JSON in Spaces)
```

Every row is upserted on `external_ref->'harvest'->>'id'`, so a re-run updates rather than duplicates and a delta run after cutover is trivial.

### 16.2 Field mapping decisions

| Harvest | Tally | Note |
|---|---|---|
| `time_entry.hours` (float) | `duration_seconds` | `round(hours × 3600)`. Verified to sum identically per project per month. |
| `time_entry.billable_rate` | `billable_rate_cents` | Snapshot preserved exactly, so historical reports match. Null becomes 0 with a `rate_missing` note. |
| `time_entry.cost_rate` | `cost_rate_cents` | Same. |
| `time_entry.is_billed` / `is_locked` | `billed_externally` | Harvest records *that* an entry was invoiced but not *which* invoice - the API exposes no entry-to-invoice link - so links cannot be reconstructed. The flag locks the record (§4.10) and keeps the uninvoiced report truthful (§4.11) without synthesising invoice rows. Same treatment for `expense.is_billed`. |
| `project.bill_by` (`Project`/`Tasks`/`People`/`none`) | `bill_by` | Direct. |
| `project.budget_by` | `budget_by` | Harvest's `project`/`project_cost`/`task`/`task_fees`/`person`/`none` maps to our six values. |
| `project.is_fixed_fee` + `fee` | `billing_type='fixed_fee'`, `fee_cents` | `fee_cadence` inferred from the project's notes and invoice cadence; flagged for manual review where ambiguous. |
| `user.roles` (string array) | `roles` + `user_roles` | Deduplicated case-insensitively. |
| `user.access_roles` | `permission_profiles` | Harvest's `administrator` / `manager` / `member` map to Administrator / Project Manager / Member. Managers are reviewed manually against the six-profile model before go-live. |
| `user.weekly_capacity` (seconds) | `weekly_capacity_seconds` | Direct. |
| `invoice.state` | `state` | `draft`/`open`/`paid`/`closed` map directly; Harvest has no `written_off`. |
| `invoice.number` | `number` | Preserved verbatim, including the `71539-LC3` style. The numbering pattern for new invoices is configured separately. |
| `expense.units` + `category.unit_price` | `units`, `total_cents` | Recomputed and asserted against Harvest's `total_cost`. |

### 16.3 Verification

The script finishes by running a reconciliation report and failing loudly on any mismatch:

1. Total tracked hours per project per month, Tally versus Harvest, must match to 0.01 hours.
2. Total billable amount per project per month must match to the cent.
3. Invoice count, total invoiced, and total paid per year must match to the cent.
4. Per-user total hours all-time must match.
5. Every non-archived Harvest project must exist and be non-archived in Tally.
6. The uninvoiced amount per client - the billable value of records where Harvest reports `is_billed = false` - must match Tally's uninvoiced report to the cent. This is the check that proves the `billed_externally` mapping worked.

The output is a markdown report committed to `docs/migration/reconciliation-{date}.md`, so cutover is a decision made on evidence.

### 16.4 Cutover

1. Run the full import into production a week before cutover. Verify.
2. Team uses both tools for three days; a diff job compares the two nightly.
3. Freeze Harvest (set every user to read-only through Harvest's own permission model).
4. Run a delta import for the frozen window.
5. Verify again, then switch the team over.
6. Keep the Harvest account read-only for 60 days, then export everything to Spaces and cancel.

---

## 17. Deployment

### 17.0 What was actually built, and why it differs (TALLY-22)

§17.1 to §17.4 were written before anything was deployed and describe a system that does not match what exists. The `Dockerfile` and the health endpoints are now real and verified; the rest of this section stays as the target. What follows is what is true.

**There is no worker, because there is no queue.** §17.1 specifies a `worker` service running `worker.js` and §17.1's note explains a BullMQ eviction policy. BullMQ was never added; it is not a dependency. Scheduled work is a cron entry calling `node ops/recurring.mjs`, which takes a row lock and is safe to run twice. Deploying the compose file as written would start a container whose command does not exist.

**The image is `node:22-bookworm-slim`, not `node:22-alpine`.** `@node-rs/argon2` is a native Rust binding shipped as prebuilt per-platform binaries. The glibc build is the well-trodden one, and password hashing is a poor thing to discover is broken in production.

**One image, five commands**, so a job can never run against a different build than the one serving traffic:

| Command | What it is |
|---|---|
| `node server.js` | the web process |
| `node ops/migrate.mjs` | migrations, run before the new containers start |
| `node ops/recurring.mjs` | the daily recurring-invoice job, from cron |
| `node ops/mail.mjs` | queued mail and overdue reminders, every five minutes from cron |
| `node ops/sweep.mjs` | nightly expired-session and idempotency-key housekeeping |

The four ops scripts are TypeScript run through `tsx`, which is a devDependency, so they are compiled with esbuild during the build stage rather than shipping the dev toolchain into the runtime. `dotenv` is aliased to a stub in that bundle: it is CommonJS, its internal `require("fs")` becomes an unsupported dynamic require inside an ESM bundle, and compiling to CommonJS instead fails because the scripts use top-level await.

**`output: "standalone"` was missing from `next.config.mjs`.** The multi-stage build §17.1 describes depends on it and could not have worked without it.

**The build required production secrets, and no longer does.** `next build` imports every route module to collect page data, which reached `src/server/env.ts` and validated an environment a build has no business needing. That meant the image could not be built without a live `DATABASE_URL` and a real `SESSION_SECRET`, so CI would have had to hold production credentials in order to compile. Validation is now skipped when `NEXT_PHASE` says a build is running, and stays eager everywhere else so a misconfigured container still dies at boot.

**An adversarial review then broke the first version of that fix, and the correction is the part worth reading.** The original comment said `NEXT_PHASE` is set by Next and therefore "cannot apply to a running server". That is false: it is an ordinary environment variable. Booting the production image with `NEXT_PHASE=phase-production-build` and **no `SESSION_SECRET` at all** produced a healthy container serving `/signin`, signing sessions with thirty-two zero bytes, a value published in the source. `NODE_ENV=production` did not prevent it, and `NODE_ENV` cannot be the discriminator either because `next build` also runs as production.

The defence is therefore not detection. **The placeholder is poisoned**: it satisfies the schema so the build compiles, and `env.SESSION_SECRET` is a getter that throws if anything reads it. Build-time code never does. A spoofed server now refuses every request that touches a session, with an error naming the misconfiguration, instead of accepting forged cookies. Verified by re-running the same spoof: sign-in returns 500 and the log names the cause, while a correctly configured container signs in normally.

**The middleware exempted `/api/health` by prefix**, so `/api/health-admin` and anything else starting with those characters would have been served without a session. The health probes are matched exactly now, and `tests/routes.test.ts` fails on any `/api` entry in the prefix list that does not end in a slash.

**Health is three endpoints, not one.** §17.4 polls `/api/health/live` and `/api/health/ready`; only `/api/health` existed, and it reported 503 when Postgres was unreachable. Used as a container healthcheck that restarts a web process which is itself fine, turning a database blip into a restart loop. They are now separate: `live` touches nothing and answers whether the process should be replaced, `ready` reaches Postgres and answers whether traffic should be sent. `/api/health` remains, behaving as `ready`. None of the three echoes the connection error any more, because they are unauthenticated and a Postgres error names the host, port and user.

**Verified, not assumed.** The image builds clean (427 MB), and against the real database all three commands were run: the web process serves `/signin` with the per-request CSP nonce, `ready` returns 200 while `live` stays 200 even when the database is unreachable, migrations report `✓ migrated`, and the recurring job completes.

**Still not built in this repository:** the production Compose integration, the reverse-proxy configuration, the CI pipeline (there is no `.github/`), and Sentry. Backups are managed at the shared-server level; their PostgreSQL restore path still needs to be inspected and verified before cutover rather than duplicated here on assumption.

**§17.3 names the wrong email provider.** It lists `RESEND_API_KEY`; the credentials doc and TALLY-19 say SendGrid. One of them is wrong and it should be settled before the key is issued.

### 17.1 Compose

```yaml
services:
  caddy:
    image: caddy:2-alpine
    ports: ["80:80", "443:443"]
    volumes: [./Caddyfile:/etc/caddy/Caddyfile:ro, caddy_data:/data, caddy_config:/config]
    depends_on: [web]
    restart: unless-stopped

  web:
    image: ghcr.io/jhmg/tally:${TAG}
    command: ["node", "server.js"]
    env_file: [.env]
    depends_on: { postgres: { condition: service_healthy }, redis: { condition: service_started } }
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:3000/api/health/live').then(r=>process.exit(r.ok?0:1))"]
      interval: 15s
    restart: unless-stopped

  worker:
    image: ghcr.io/jhmg/tally:${TAG}
    command: ["node", "worker.js"]
    env_file: [.env]
    depends_on: { postgres: { condition: service_healthy }, redis: { condition: service_started } }
    restart: unless-stopped

  postgres:
    image: postgres:16-alpine
    environment: [POSTGRES_DB=tally, POSTGRES_USER=tally]
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck: { test: ["CMD-SHELL", "pg_isready -U tally"], interval: 10s, retries: 5 }
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    command: ["redis-server", "--appendonly", "yes", "--maxmemory-policy", "noeviction"]
    volumes: [redisdata:/data]
    restart: unless-stopped
```

`maxmemory-policy noeviction` is deliberate: BullMQ jobs must never be evicted under memory pressure. Redis is a queue here, not a cache we can afford to lose.

The `Dockerfile` is multi-stage: a `deps` stage (pnpm install with a lockfile-only cache mount), a `build` stage (`next build` with `output: 'standalone'`), and a slim `runner` stage on `node:22-alpine` running as a non-root user. The worker shares the image and differs only in its command, so `web` and `worker` are always the same code.

### 17.2 Caddy

```
tally.jhmediagroup.com {
  encode zstd gzip
  header {
    Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
    X-Content-Type-Options nosniff
    X-Frame-Options DENY
    Referrer-Policy strict-origin-when-cross-origin
    Permissions-Policy "camera=(), microphone=(), geolocation=()"
  }
  @sse path /api/live
  handle @sse { reverse_proxy web:3000 { flush_interval -1 } }
  handle { reverse_proxy web:3000 }
}
```

`flush_interval -1` on the SSE route disables response buffering; without it the event stream arrives in chunks and the timer appears frozen.

### 17.3 Environment

```
TALLY_APP_URL=https://tally.jhmediagroup.com
DATABASE_URL=postgres://tally:…@postgres:5432/tally
REDIS_URL=redis://redis:6379
AUTH_SECRET=…                  AUTH_GOOGLE_ID=…       AUTH_GOOGLE_SECRET=…
AUTH_GOOGLE_HD=jhmediagroup.com
TALLY_ENCRYPTION_KEY=…         # 32 bytes base64, for integration token encryption
RESEND_API_KEY=…               EMAIL_FROM="JH Media Group <billing@jhmediagroup.com>"
SPACES_ENDPOINT=…  SPACES_BUCKET=…  SPACES_KEY=…  SPACES_SECRET=…
QBO_CLIENT_ID=…  QBO_CLIENT_SECRET=…  QBO_ENVIRONMENT=production
SLACK_CLIENT_ID=…  SLACK_CLIENT_SECRET=…
STRIPE_SECRET_KEY=…  STRIPE_WEBHOOK_SECRET=…
SENTRY_DSN=…  SENTRY_ENVIRONMENT=production
```

Secrets live in a `.env` file on the droplet, `chmod 600`, owned by the deploy user, and mirrored into GitHub Actions secrets for CI. Nothing secret is in the repository.

### 17.4 Pipeline

`push to main` →

1. `pnpm typecheck` `pnpm lint` `pnpm test:unit`
2. `pnpm test:integration` against a Postgres service container
3. `pnpm test:e2e` (Playwright, against a built app plus seeded database)
4. `docker build` and push to GHCR, tagged with the git SHA
5. SSH to the droplet: pull the image, `docker compose run --rm web node migrate.js`, then `docker compose up -d web worker`
6. Poll `/api/health/ready` for 90 seconds; roll back to the previous tag on failure

**Migrations run before the new containers start** and must be backward compatible with the currently running version, so a rollback never faces a schema it cannot read. The rule is: additive migrations ship first, the code that uses them ships second, and destructive migrations (dropping a column) ship at least one deploy later.

Deploys take under two minutes and cause a brief 503 during the container swap. With eleven internal users at business hours, that is acceptable and simpler than blue-green. If it stops being acceptable, Caddy can hold connections during a two-container rollover.

---

## 18. Security

Beyond authentication and authorization (§7):

**Transport and headers.** TLS 1.2+ only, HSTS with preload, a strict CSP (`default-src 'self'; script-src 'self' 'nonce-…'; style-src 'self' 'nonce-…'; img-src 'self' data: blob: <spaces-host>; connect-src 'self' <sentry>; frame-ancestors 'none'`), nonces generated per request in middleware. No `unsafe-inline`, no `unsafe-eval`.

**Injection.** Drizzle parameterizes everything; there is no raw string SQL outside migrations. React escapes by default and `dangerouslySetInnerHTML` is banned by an ESLint rule, with the invoice notes field rendered through a markdown renderer with a strict allowlist.

**CSRF.** `SameSite=Lax` cookies plus an origin check on every state-changing request. Bearer-token requests are exempt from the origin check by design (they are not browser-originated) and carry no cookie.

**Uploads.** Content type and size constrained in the presign, verified again on finalize, images re-encoded server-side, and everything served from a separate origin (Spaces) so a malicious file cannot execute against the app origin. `Content-Disposition: attachment` on downloads.

**Secrets.** Integration tokens encrypted at rest with AES-256-GCM. Password hashes argon2id. API tokens SHA-256. Nothing sensitive in logs; pino redaction paths cover `authorization`, `cookie`, `password`, `token`, `secret`, `access_token`, `refresh_token`.

**Multi-user isolation.** Single tenant, so there is no cross-tenant risk, but scope filters (§7.3) are tested per profile per endpoint, and 404-not-403 prevents enumeration.

**Public surfaces.** Only two: the sign-in page and `/pay/:token`. The pay token is 32 random bytes, rotates when a sent invoice is edited, and grants read plus pay on exactly one invoice. It carries `X-Robots-Tag: noindex` and is excluded from the sitemap.

**Dependencies.** Dependabot on weekly, `pnpm audit` in the pipeline failing on high or critical, and a lockfile-only install in the Docker build.

**Review gate.** Before Phase 3 ships (the phase that handles money), a full security review pass against the OWASP ASVS Level 2 checklist, recorded in `docs/SECURITY_REVIEW.md`.

---

## 19. Testing

| Layer | Tool | What it covers | Gate |
|---|---|---|---|
| **Unit** | Vitest | `src/domain/` in full: money arithmetic, duration parsing, rounding (including the per-group rule), rate resolution across all six `bill_by` and date-boundary cases, budget math for all six `budget_by` values with and without monthly reset, profitability for T&M and fixed-fee with all three allocation modes, invoice totals with two taxes and a discount, invoice numbering patterns, recurring-schedule date math including month-end and leap years, timezone day-boundary resolution. | 100% branch coverage on `src/domain/`. Non-negotiable; this is where money bugs live. |
| **Integration** | Vitest + a real Postgres container | Every service function against a real database: transactions, constraint violations surfacing as friendly errors, the running-timer unique index, the rate-overlap exclusion constraint, outbox-inside-transaction, audit rows written, idempotency replay. Plus the full permission matrix: for each of the six base profiles, every endpoint's expected status. | The permission matrix test fails the build if an endpoint has no row. |
| **API contract** | Vitest | Every route handler: schema validation, error shapes, pagination, sorting allowlists, rate limits, ETag behaviour. | |
| **E2E** | Playwright | The critical paths: sign in, start a timer, stop it, edit the entry; fill a week in Week view under both timer modes; submit and approve a timesheet; create a project with a budget and see the bar; generate an invoice from tracked time, send it, record a payment; run a profitability report and drill down twice; a bulk action end to end; offline queue and replay. Run against Chromium and WebKit, light and dark themes. | |
| **Visual** | Playwright screenshots | The invoice document (app, PDF, pay page) must be pixel-identical. Key pages in both themes. | |
| **Accessibility** | axe-core in Playwright | Zero violations on the eight main pages. | |
| **Load** | k6, occasional | Report endpoints at 10x current data volume, to know where the first wall is. | Not a build gate. |

Test data comes from a deterministic seed (`scripts/seed.ts`) that builds a realistic JHMG-shaped account: 12 people across employees and contractors, 40 active and 60 archived projects across 25 clients, 14 tasks, two years of time entries with plausible distribution, dated rate history including a mid-history raise, and 200 invoices across every state. Every test runs against a fresh database from that seed, so tests are order-independent.

---

## 20. Acceptance criteria

Back-end sign-off requires all of the following.

**Correctness**
1. `src/domain/` has 100% branch coverage and every documented formula in §4 has a test asserting the exact expected cents.
2. Reconciliation against Harvest passes all six checks in §16.3 with zero variance.
3. Rounding applies per aggregated group, never per entry, and a test proves ten 6-minute entries under 15-minute rounding produce 1.0 hours.
4. Rate snapshots never change except through an explicit re-rate, and re-rate refuses locked entries without `force`.
5. A profitability report for a closed quarter returns byte-identical JSON when run twice a week apart.

**Integrity**
6. The database refuses a second running timer for a user, and refuses overlapping rate ranges. Both are constraint violations, not application checks.
7. No event reaches a client for a transaction that rolled back.
8. Replaying an identical mutation with the same `Idempotency-Key` returns the original response and creates nothing new; a different body with the same key returns 409.
9. Every mutation has a corresponding `audit_log` row, verified by a test that mutates every entity type and asserts the row exists.

**Security**
10. For each of the six base profiles, every endpoint returns the expected status. A new endpoint without a matrix row fails the build.
11. Out-of-scope records return 404, never 403.
12. Cost rate values are absent from the serialized payload for any actor without `rates:view_cost`, verified by a test that greps the full response body.
13. CSP is enforced with no `unsafe-inline` and no `unsafe-eval`.
14. A `pnpm audit` with high or critical findings fails the build.

**Operations**
15. `/api/health/ready` correctly reports not-ready when Postgres is down, when Redis is down, and when migrations are behind head.
16. A restore from the most recent nightly backup into a scratch database succeeds and passes the row-count comparison, verified weekly by an automated job.
17. Every cron job is idempotent: running it twice in the same window produces no duplicate invoices, emails, or alerts.
18. A deploy completes in under two minutes and rolls back automatically when the readiness gate fails.
19. Migrations are backward compatible with the previous release, verified by running the previous image against the new schema in CI.

**Performance**
20. Profitability for one quarter across all projects returns in under 1 second p95 against the 10x seed.
21. `GET /projects/:id/summary` returns in under 200 ms p95.
22. `GET /search` returns in under 100 ms p95.
23. `PUT /timesheet/week` for a 10-row week completes in under 300 ms p95.
