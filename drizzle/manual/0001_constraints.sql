-- Constraints, partial indexes, and views that Drizzle's schema builder cannot
-- express. Everything here is idempotent and every lookup is qualified by
-- table, so a same-named constraint on an unrelated table cannot cause a
-- required one to be silently skipped.

-- ============================================================ rate ranges
-- No two rates of the same kind may overlap for one person. This is the whole
-- reason rates are dated ranges: a March raise must not rewrite what January
-- cost. Enforced by the database, because application-level checks lose races.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'user_rates_no_overlap' AND conrelid = 'public.user_rates'::regclass
  ) THEN
    ALTER TABLE user_rates ADD CONSTRAINT user_rates_no_overlap
      EXCLUDE USING gist (
        user_id WITH =,
        kind WITH =,
        daterange(COALESCE(starts_on, '-infinity'), COALESCE(ends_on, 'infinity'), '[]') WITH &&
      );
  END IF;
END $$;
--> statement-breakpoint

-- ================================================ referential integrity gaps
-- A time entry names both a project and a project_task. Without a composite
-- key there is nothing stopping a row that bills project A using project B's
-- task, rate, and budget. This is the single most damaging integrity hole in
-- the model, because the resulting numbers look plausible.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'project_tasks_project_id_id_key' AND conrelid = 'public.project_tasks'::regclass
  ) THEN
    ALTER TABLE project_tasks ADD CONSTRAINT project_tasks_project_id_id_key UNIQUE (project_id, id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'time_entries_task_belongs_to_project' AND conrelid = 'public.time_entries'::regclass
  ) THEN
    ALTER TABLE time_entries ADD CONSTRAINT time_entries_task_belongs_to_project
      FOREIGN KEY (project_id, project_task_id)
      REFERENCES project_tasks (project_id, id);
  END IF;

  -- Same idea for members: a project member row must belong to the project it
  -- claims, so budget-by-person cannot be attributed across projects.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'project_members_project_id_id_key' AND conrelid = 'public.project_members'::regclass
  ) THEN
    ALTER TABLE project_members ADD CONSTRAINT project_members_project_id_id_key UNIQUE (project_id, id);
  END IF;
END $$;
--> statement-breakpoint

-- ========================================================== running timers
-- Exactly one running timer per person. Starting a second one must stop the
-- first in the same transaction; the reverse order trips this index, which is
-- exactly the point.
CREATE UNIQUE INDEX IF NOT EXISTS one_running_timer_per_user
  ON time_entries (user_id)
  WHERE timer_started_at IS NOT NULL AND deleted_at IS NULL;
--> statement-breakpoint

-- ====================================================== partial hot indexes
-- Every one of these excludes rows the hot path never wants, so the index stays
-- small however much history accumulates.
CREATE INDEX IF NOT EXISTS time_entries_user_day_live_idx
  ON time_entries (user_id, spent_on DESC) WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS time_entries_project_day_live_idx
  ON time_entries (project_id, spent_on DESC) WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS time_entries_uninvoiced_idx
  ON time_entries (spent_on)
  WHERE deleted_at IS NULL AND invoice_id IS NULL AND NOT billed_externally AND is_billable;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS expenses_user_day_live_idx
  ON expenses (user_id, spent_on DESC) WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS expenses_project_day_live_idx
  ON expenses (project_id, spent_on DESC) WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS expenses_uninvoiced_idx
  ON expenses (spent_on)
  WHERE deleted_at IS NULL AND invoice_id IS NULL AND NOT billed_externally AND is_billable;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS invoices_client_live_idx
  ON invoices (client_id, issue_date DESC) WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS invoices_state_due_live_idx
  ON invoices (state, due_date) WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS recurring_next_issue_active_idx
  ON recurring_invoices (next_issue_on) WHERE state = 'active';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS project_members_live_idx
  ON project_members (user_id) WHERE archived_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS project_tasks_live_idx
  ON project_tasks (project_id) WHERE archived_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS notifications_unread_idx
  ON notifications (user_id, created_at DESC) WHERE read_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox (id) WHERE published_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sessions_live_idx ON sessions (token_hash) WHERE revoked_at IS NULL;
--> statement-breakpoint

-- ======================================================== unique by name
-- Names are unique among the living. An archived client should not block
-- reusing its name, and reviving it should not collide either.
CREATE UNIQUE INDEX IF NOT EXISTS clients_name_unique
  ON clients (lower(name)) WHERE archived_at IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS tasks_name_unique
  ON tasks (lower(name)) WHERE archived_at IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS invoices_number_unique
  ON invoices (number) WHERE deleted_at IS NULL;
--> statement-breakpoint

-- ============================================= unique across nullable columns
-- Postgres treats NULLs as distinct, so a plain UNIQUE containing a nullable
-- column does not prevent duplicates: two client-wide retainers (project_id
-- NULL) would both be allowed, and so would two account-scope integrations.
-- NULLS NOT DISTINCT is the fix, and it needs Postgres 15 or later.
CREATE UNIQUE INDEX IF NOT EXISTS retainers_client_project_unique
  ON retainers (client_id, project_id) NULLS NOT DISTINCT;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS integration_connections_unique
  ON integration_connections (provider, scope, user_id) NULLS NOT DISTINCT;
--> statement-breakpoint

-- ========================================= deferrable line item positions
-- Reordering lines inside one transaction moves several rows through positions
-- that collide in the middle of the update. Deferring the check to commit lets
-- the reorder happen in any order and still guarantees a clean result.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'invoice_line_items_position_unique' AND conrelid = 'public.invoice_line_items'::regclass
  ) THEN
    ALTER TABLE invoice_line_items ADD CONSTRAINT invoice_line_items_position_unique
      UNIQUE (invoice_id, position) DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
--> statement-breakpoint

-- ========================================================= check constraints
-- Enum-like columns are text for schema flexibility, but the set of legal
-- values is a domain invariant, not a preference. Enforcing it here means a
-- typo in a service is a failed insert rather than a row nobody can interpret.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'budget_one_kind' AND conrelid = 'public.projects'::regclass) THEN
    ALTER TABLE projects ADD CONSTRAINT budget_one_kind
      CHECK (budget_seconds IS NULL OR budget_fee_cents IS NULL);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_billing_type_valid' AND conrelid = 'public.projects'::regclass) THEN
    ALTER TABLE projects ADD CONSTRAINT projects_billing_type_valid
      CHECK (billing_type IN ('time_and_materials', 'fixed_fee', 'non_billable'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_bill_by_valid' AND conrelid = 'public.projects'::regclass) THEN
    ALTER TABLE projects ADD CONSTRAINT projects_bill_by_valid
      CHECK (bill_by IN ('project', 'tasks', 'people', 'none'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_budget_by_valid' AND conrelid = 'public.projects'::regclass) THEN
    ALTER TABLE projects ADD CONSTRAINT projects_budget_by_valid
      CHECK (budget_by IN ('project_hours', 'project_fees', 'task_hours', 'task_fees', 'person_hours', 'none'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_fee_cadence_valid' AND conrelid = 'public.projects'::regclass) THEN
    ALTER TABLE projects ADD CONSTRAINT projects_fee_cadence_valid
      CHECK (fee_cadence IS NULL OR fee_cadence IN ('single', 'monthly'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_report_visibility_valid' AND conrelid = 'public.projects'::regclass) THEN
    ALTER TABLE projects ADD CONSTRAINT projects_report_visibility_valid
      CHECK (report_visibility IN ('managers', 'everyone'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_tasks_budget_one_kind' AND conrelid = 'public.project_tasks'::regclass) THEN
    ALTER TABLE project_tasks ADD CONSTRAINT project_tasks_budget_one_kind
      CHECK (budget_seconds IS NULL OR budget_fee_cents IS NULL);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'time_entries_duration_non_negative' AND conrelid = 'public.time_entries'::regclass) THEN
    ALTER TABLE time_entries ADD CONSTRAINT time_entries_duration_non_negative
      CHECK (duration_seconds >= 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'time_entries_source_valid' AND conrelid = 'public.time_entries'::regclass) THEN
    ALTER TABLE time_entries ADD CONSTRAINT time_entries_source_valid
      CHECK (source IN ('web', 'api', 'import', 'calendar', 'slack'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_rates_kind_valid' AND conrelid = 'public.user_rates'::regclass) THEN
    ALTER TABLE user_rates ADD CONSTRAINT user_rates_kind_valid
      CHECK (kind IN ('billable', 'cost'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_rates_range_ordered' AND conrelid = 'public.user_rates'::regclass) THEN
    ALTER TABLE user_rates ADD CONSTRAINT user_rates_range_ordered
      CHECK (starts_on IS NULL OR ends_on IS NULL OR starts_on <= ends_on);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_employment_type_valid' AND conrelid = 'public.users'::regclass) THEN
    ALTER TABLE users ADD CONSTRAINT users_employment_type_valid
      CHECK (employment_type IN ('employee', 'contractor'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'expenses_reimbursement_state_valid' AND conrelid = 'public.expenses'::regclass) THEN
    ALTER TABLE expenses ADD CONSTRAINT expenses_reimbursement_state_valid
      CHECK (reimbursement_state IS NULL OR reimbursement_state IN ('pending', 'approved', 'paid'));
  END IF;

  -- A non-reimbursable expense has no reimbursement state to be in.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'expenses_reimbursement_coherent' AND conrelid = 'public.expenses'::regclass) THEN
    ALTER TABLE expenses ADD CONSTRAINT expenses_reimbursement_coherent
      CHECK (is_reimbursable OR reimbursement_state IS NULL);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_state_valid' AND conrelid = 'public.invoices'::regclass) THEN
    ALTER TABLE invoices ADD CONSTRAINT invoices_state_valid
      CHECK (state IN ('draft', 'open', 'paid', 'written_off', 'closed'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_dates_ordered' AND conrelid = 'public.invoices'::regclass) THEN
    ALTER TABLE invoices ADD CONSTRAINT invoices_dates_ordered
      CHECK (due_date >= issue_date);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'settings_singleton' AND conrelid = 'public.settings'::regclass) THEN
    ALTER TABLE settings ADD CONSTRAINT settings_singleton CHECK (id = 1);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoice_payments_positive' AND conrelid = 'public.invoice_payments'::regclass) THEN
    ALTER TABLE invoice_payments ADD CONSTRAINT invoice_payments_positive
      CHECK (amount_cents > 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'retainer_transactions_positive' AND conrelid = 'public.retainer_transactions'::regclass) THEN
    ALTER TABLE retainer_transactions ADD CONSTRAINT retainer_transactions_positive
      CHECK (amount_cents > 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'retainer_transactions_kind_valid' AND conrelid = 'public.retainer_transactions'::regclass) THEN
    ALTER TABLE retainer_transactions ADD CONSTRAINT retainer_transactions_kind_valid
      CHECK (kind IN ('add', 'draw', 'adjust'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'submissions_state_valid' AND conrelid = 'public.timesheet_submissions'::regclass) THEN
    ALTER TABLE timesheet_submissions ADD CONSTRAINT submissions_state_valid
      CHECK (state IN ('submitted', 'approved', 'changes_requested'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'submissions_period_ordered' AND conrelid = 'public.timesheet_submissions'::regclass) THEN
    ALTER TABLE timesheet_submissions ADD CONSTRAINT submissions_period_ordered
      CHECK (period_end >= period_start);
  END IF;

  -- An account-scope integration has no user; a user-scope one must have one.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'integration_scope_coherent' AND conrelid = 'public.integration_connections'::regclass) THEN
    ALTER TABLE integration_connections ADD CONSTRAINT integration_scope_coherent
      CHECK ((scope = 'account' AND user_id IS NULL) OR (scope = 'user' AND user_id IS NOT NULL));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sessions_expiry_ordered' AND conrelid = 'public.sessions'::regclass) THEN
    ALTER TABLE sessions ADD CONSTRAINT sessions_expiry_ordered
      CHECK (absolute_expires_at >= expires_at);
  END IF;
END $$;
--> statement-breakpoint

-- ============================================================ search indexes
-- Backs GET /search. Trigram rather than tsvector: the command palette is
-- prefix and substring matching over short names, which trigram does well and
-- full-text search does badly ("Example Client 28" should match mid-word).
CREATE INDEX IF NOT EXISTS clients_name_trgm ON clients USING gin (name gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS projects_name_trgm ON projects USING gin (name gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS tasks_name_trgm ON tasks USING gin (name gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS invoices_number_trgm ON invoices USING gin (number gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS users_name_trgm ON users USING gin ((first_name || ' ' || last_name) gin_trgm_ops);
--> statement-breakpoint

-- ============================================================ reporting view
-- Readability only. The report services compose their own aggregation so the
-- division by 3600 happens once, at the end (see BACKEND_PRD 3.6).
CREATE OR REPLACE VIEW time_entry_facts AS
SELECT
  te.id, te.user_id, te.project_id, te.project_task_id, pt.task_id,
  p.client_id, te.spent_on, te.is_billable, te.duration_seconds,
  te.invoice_id, te.approval_id, te.billed_externally,
  (te.duration_seconds * te.billable_rate_cents) / 3600 AS billable_cents,
  (te.duration_seconds * te.cost_rate_cents)     / 3600 AS cost_cents,
  p.billing_type, p.archived_at IS NOT NULL AS project_archived
FROM time_entries te
JOIN project_tasks pt ON pt.id = te.project_task_id
JOIN projects p       ON p.id = te.project_id
WHERE te.deleted_at IS NULL AND te.timer_started_at IS NULL;
