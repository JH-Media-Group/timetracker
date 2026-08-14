CREATE TABLE "api_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"label" text NOT NULL,
	"token_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_tokens_tokenHash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor_id" uuid,
	"actor_kind" text DEFAULT 'user' NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"entity_label" text,
	"before" jsonb,
	"after" jsonb,
	"diff_keys" text[],
	"request_id" text,
	"ip" "inet",
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bulk_action_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_id" uuid NOT NULL,
	"action_key" text NOT NULL,
	"params" jsonb NOT NULL,
	"target_count" integer NOT NULL,
	"succeeded" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"state" text DEFAULT 'running' NOT NULL,
	"revert_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "client_contacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"first_name" text,
	"last_name" text,
	"title" text,
	"email" "citext",
	"phone_office" text,
	"phone_mobile" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"external_ref" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"payment_term" text DEFAULT 'net_15' NOT NULL,
	"payment_term_days" integer,
	"tax_percent" numeric(6, 3),
	"tax2_percent" numeric(6, 3),
	"discount_percent" numeric(6, 3),
	"invoice_prefix" text,
	"archived_at" timestamp with time zone,
	"external_ref" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "departments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "departments_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "expense_categories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"unit_name" text,
	"unit_price_cents" bigint,
	"archived_at" timestamp with time zone,
	"external_ref" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"spent_on" date NOT NULL,
	"units" numeric(12, 2),
	"total_cents" bigint NOT NULL,
	"notes" text,
	"is_billable" boolean DEFAULT true NOT NULL,
	"is_reimbursable" boolean DEFAULT false NOT NULL,
	"reimbursement_state" text,
	"reimbursed_at" timestamp with time zone,
	"receipt_key" text,
	"receipt_filename" text,
	"receipt_content_type" text,
	"receipt_bytes" integer,
	"billed_externally" boolean DEFAULT false NOT NULL,
	"invoice_id" uuid,
	"approval_id" uuid,
	"rates_locked_at" timestamp with time zone,
	"external_ref" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "export_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"format" text DEFAULT 'csv' NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"row_count" integer,
	"object_key" text,
	"download_name" text,
	"content" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"key" text PRIMARY KEY NOT NULL,
	"actor_id" uuid,
	"route" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_status" smallint,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"filename" text,
	"object_key" text,
	"mapping" jsonb,
	"row_count" integer,
	"inserted" integer,
	"skipped" integer,
	"failed" integer,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_ids" uuid[],
	"reverted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"scope" text DEFAULT 'account' NOT NULL,
	"user_id" uuid,
	"external_account_id" text,
	"access_token_enc" "bytea",
	"refresh_token_enc" "bytea",
	"expires_at" timestamp with time zone,
	"granted_scopes" text[],
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"last_error" text,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_attachments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"invoice_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"filename" text NOT NULL,
	"content_type" text,
	"bytes" integer,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_item_types" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"is_default_for_expenses" boolean DEFAULT false NOT NULL,
	"is_default_for_services" boolean DEFAULT false NOT NULL,
	"qbo_income_account_id" text,
	"archived_at" timestamp with time zone,
	CONSTRAINT "invoice_item_types_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "invoice_line_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"invoice_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"item_type_id" uuid,
	"project_id" uuid,
	"description" text NOT NULL,
	"quantity" numeric(12, 2) DEFAULT '1' NOT NULL,
	"unit_price_cents" bigint DEFAULT 0 NOT NULL,
	"amount_cents" bigint DEFAULT 0 NOT NULL,
	"is_taxed" boolean DEFAULT true NOT NULL,
	"is_taxed2" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"invoice_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"subject" text,
	"body" text,
	"recipients" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attached_pdf" boolean DEFAULT true NOT NULL,
	"provider_message_id" text,
	"sent_by" uuid,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opened_at" timestamp with time zone,
	"delivery_state" text DEFAULT 'queued' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"invoice_id" uuid NOT NULL,
	"amount_cents" bigint NOT NULL,
	"paid_at" timestamp with time zone NOT NULL,
	"method" text,
	"reference" text,
	"notes" text,
	"gateway" text,
	"gateway_txn_id" text,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"recorded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_payments_gatewayTxnId_unique" UNIQUE("gateway_txn_id")
);
--> statement-breakpoint
CREATE TABLE "invoice_projects" (
	"invoice_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	CONSTRAINT "invoice_projects_invoice_id_project_id_pk" PRIMARY KEY("invoice_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"number" text NOT NULL,
	"subject" text,
	"notes" text,
	"po_number" text,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"issue_date" date NOT NULL,
	"due_date" date NOT NULL,
	"payment_term" text,
	"state" text DEFAULT 'draft' NOT NULL,
	"subtotal_cents" bigint DEFAULT 0 NOT NULL,
	"discount_percent" numeric(6, 3),
	"discount_cents" bigint DEFAULT 0 NOT NULL,
	"tax_percent" numeric(6, 3),
	"tax_cents" bigint DEFAULT 0 NOT NULL,
	"tax2_percent" numeric(6, 3),
	"tax2_cents" bigint DEFAULT 0 NOT NULL,
	"total_cents" bigint DEFAULT 0 NOT NULL,
	"paid_cents" bigint DEFAULT 0 NOT NULL,
	"show_total_hours" boolean DEFAULT false NOT NULL,
	"pay_token" text,
	"sent_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"recurring_invoice_id" uuid,
	"retainer_draw_cents" bigint DEFAULT 0 NOT NULL,
	"external_ref" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "invoices_payToken_unique" UNIQUE("pay_token")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"entity_type" text,
	"entity_id" uuid,
	"url" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"topic" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "permission_profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"is_base" boolean DEFAULT false NOT NULL,
	"base_key" text,
	"capabilities" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "permission_profiles_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "project_members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"is_manager" boolean DEFAULT false NOT NULL,
	"hourly_rate_cents" bigint,
	"budget_seconds" integer,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_tags" (
	"project_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	CONSTRAINT "project_tags_project_id_tag_id_pk" PRIMARY KEY("project_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "project_tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"is_billable" boolean DEFAULT true NOT NULL,
	"hourly_rate_cents" bigint,
	"budget_seconds" integer,
	"budget_fee_cents" bigint,
	"archived_at" timestamp with time zone,
	"external_ref" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"name" text NOT NULL,
	"code" text,
	"billing_type" text NOT NULL,
	"bill_by" text DEFAULT 'none' NOT NULL,
	"hourly_rate_cents" bigint,
	"fee_cents" bigint,
	"fee_cadence" text,
	"budget_by" text DEFAULT 'none' NOT NULL,
	"budget_seconds" integer,
	"budget_fee_cents" bigint,
	"budget_resets_monthly" boolean DEFAULT false NOT NULL,
	"budget_alert_percent" numeric(5, 2),
	"currency" char(3),
	"starts_on" date,
	"ends_on" date,
	"notes" text,
	"report_visibility" text DEFAULT 'managers' NOT NULL,
	"archived_at" timestamp with time zone,
	"external_ref" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recurring_invoices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"subject" text,
	"template" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"frequency" text NOT NULL,
	"interval" integer DEFAULT 1 NOT NULL,
	"day_of_month" integer,
	"day_of_week" integer,
	"starts_on" date NOT NULL,
	"ends_on" date,
	"occurrences_remaining" integer,
	"next_issue_on" date,
	"send_automatically" boolean DEFAULT false NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"last_issued_on" date,
	"external_ref" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "retainer_transactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"retainer_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"balance_after_cents" bigint NOT NULL,
	"invoice_id" uuid,
	"note" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "retainers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"project_id" uuid,
	"balance_cents" bigint DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "roles_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "saved_reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"config" jsonb NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"schedule" jsonb,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"user_agent" text,
	"ip" "inet",
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"absolute_expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_tokenHash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"company_name" text NOT NULL,
	"company_address" text,
	"logo_key" text,
	"tax_id" text,
	"base_currency" char(3) DEFAULT 'USD' NOT NULL,
	"timezone" text DEFAULT 'America/New_York' NOT NULL,
	"week_starts_on" smallint DEFAULT 1 NOT NULL,
	"fiscal_year_start_month" smallint DEFAULT 1 NOT NULL,
	"timer_mode" text DEFAULT 'start_end' NOT NULL,
	"time_display" text DEFAULT 'decimal' NOT NULL,
	"rounding_minutes" smallint DEFAULT 0 NOT NULL,
	"rounding_mode" text DEFAULT 'nearest' NOT NULL,
	"require_notes" text DEFAULT 'never' NOT NULL,
	"allow_future_dates" boolean DEFAULT true NOT NULL,
	"flag_missing_below_seconds" integer,
	"lock_timesheets_after_days" integer,
	"project_notes_visibility" text DEFAULT 'managers' NOT NULL,
	"modules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"invoice_defaults" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"invoice_appearance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"invoice_messages" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"invoice_field_labels" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"invoice_number_pattern" text DEFAULT '{seq:5}' NOT NULL,
	"invoice_next_seq" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tags_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"default_hourly_rate_cents" bigint,
	"is_default_billable" boolean DEFAULT true NOT NULL,
	"is_common" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"external_ref" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "time_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"project_task_id" uuid NOT NULL,
	"spent_on" date NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"times_are_inferred" boolean DEFAULT false NOT NULL,
	"duration_seconds" integer DEFAULT 0 NOT NULL,
	"timer_started_at" timestamp with time zone,
	"notes" text,
	"is_billable" boolean NOT NULL,
	"billable_rate_cents" bigint DEFAULT 0 NOT NULL,
	"cost_rate_cents" bigint DEFAULT 0 NOT NULL,
	"rates_locked_at" timestamp with time zone,
	"billed_externally" boolean DEFAULT false NOT NULL,
	"invoice_id" uuid,
	"approval_id" uuid,
	"needs_review" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT 'web' NOT NULL,
	"external_ref" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "timesheet_submissions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"state" text DEFAULT 'submitted' NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"total_seconds" integer DEFAULT 0 NOT NULL,
	"flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"amended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_departments" (
	"user_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	CONSTRAINT "user_departments_user_id_department_id_pk" PRIMARY KEY("user_id","department_id")
);
--> statement-breakpoint
CREATE TABLE "user_managed_users" (
	"manager_id" uuid NOT NULL,
	"managed_id" uuid NOT NULL,
	CONSTRAINT "user_managed_users_manager_id_managed_id_pk" PRIMARY KEY("manager_id","managed_id")
);
--> statement-breakpoint
CREATE TABLE "user_pinned_projects" (
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"pinned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_pinned_projects_user_id_project_id_pk" PRIMARY KEY("user_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "user_rates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"starts_on" date,
	"ends_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	CONSTRAINT "user_roles_user_id_role_id_pk" PRIMARY KEY("user_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" "citext" NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"avatar_key" text,
	"employee_id" text,
	"timezone" text DEFAULT 'America/New_York' NOT NULL,
	"weekly_capacity_seconds" integer DEFAULT 144000 NOT NULL,
	"employment_type" text DEFAULT 'employee' NOT NULL,
	"is_owner" boolean DEFAULT false NOT NULL,
	"profile_id" uuid NOT NULL,
	"auto_assign_projects" boolean DEFAULT false NOT NULL,
	"theme" text DEFAULT 'system' NOT NULL,
	"notification_prefs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"password_hash" text,
	"started_on" date,
	"ended_on" date,
	"archived_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"external_ref" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bulk_action_runs" ADD CONSTRAINT "bulk_action_runs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_contacts" ADD CONSTRAINT "client_contacts_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_category_id_expense_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."expense_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_approval_id_timesheet_submissions_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."timesheet_submissions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_runs" ADD CONSTRAINT "export_runs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_attachments" ADD CONSTRAINT "invoice_attachments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_attachments" ADD CONSTRAINT "invoice_attachments_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_item_type_id_invoice_item_types_id_fk" FOREIGN KEY ("item_type_id") REFERENCES "public"."invoice_item_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_messages" ADD CONSTRAINT "invoice_messages_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_messages" ADD CONSTRAINT "invoice_messages_sent_by_users_id_fk" FOREIGN KEY ("sent_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_projects" ADD CONSTRAINT "invoice_projects_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_projects" ADD CONSTRAINT "invoice_projects_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_recurring_invoice_id_recurring_invoices_id_fk" FOREIGN KEY ("recurring_invoice_id") REFERENCES "public"."recurring_invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_tags" ADD CONSTRAINT "project_tags_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_tags" ADD CONSTRAINT "project_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_tasks" ADD CONSTRAINT "project_tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_tasks" ADD CONSTRAINT "project_tasks_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_invoices" ADD CONSTRAINT "recurring_invoices_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retainer_transactions" ADD CONSTRAINT "retainer_transactions_retainer_id_retainers_id_fk" FOREIGN KEY ("retainer_id") REFERENCES "public"."retainers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retainer_transactions" ADD CONSTRAINT "retainer_transactions_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retainer_transactions" ADD CONSTRAINT "retainer_transactions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retainers" ADD CONSTRAINT "retainers_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retainers" ADD CONSTRAINT "retainers_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_reports" ADD CONSTRAINT "saved_reports_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_project_task_id_project_tasks_id_fk" FOREIGN KEY ("project_task_id") REFERENCES "public"."project_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_approval_id_timesheet_submissions_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."timesheet_submissions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_submissions" ADD CONSTRAINT "timesheet_submissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_submissions" ADD CONSTRAINT "timesheet_submissions_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_departments" ADD CONSTRAINT "user_departments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_departments" ADD CONSTRAINT "user_departments_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_managed_users" ADD CONSTRAINT "user_managed_users_manager_id_users_id_fk" FOREIGN KEY ("manager_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_managed_users" ADD CONSTRAINT "user_managed_users_managed_id_users_id_fk" FOREIGN KEY ("managed_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_pinned_projects" ADD CONSTRAINT "user_pinned_projects_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_pinned_projects" ADD CONSTRAINT "user_pinned_projects_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_rates" ADD CONSTRAINT "user_rates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_rates" ADD CONSTRAINT "user_rates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_profile_id_permission_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."permission_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_created_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit_log" USING btree ("actor_id","created_at");--> statement-breakpoint
CREATE INDEX "client_contacts_client_idx" ON "client_contacts" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "clients_archived_at_idx" ON "clients" USING btree ("archived_at");--> statement-breakpoint
CREATE INDEX "expenses_invoice_idx" ON "expenses" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "invoice_line_items_invoice_idx" ON "invoice_line_items" USING btree ("invoice_id","position");--> statement-breakpoint
CREATE INDEX "invoice_payments_invoice_idx" ON "invoice_payments" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "notifications_user_created_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "project_members_unique" ON "project_members" USING btree ("project_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_tasks_unique" ON "project_tasks" USING btree ("project_id","task_id");--> statement-breakpoint
CREATE INDEX "projects_client_idx" ON "projects" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "projects_archived_at_idx" ON "projects" USING btree ("archived_at");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "time_entries_invoice_idx" ON "time_entries" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "timesheet_submissions_unique" ON "timesheet_submissions" USING btree ("user_id","period_start");--> statement-breakpoint
CREATE INDEX "timesheet_submissions_state_idx" ON "timesheet_submissions" USING btree ("state","period_start");--> statement-breakpoint
CREATE INDEX "user_rates_lookup_idx" ON "user_rates" USING btree ("user_id","kind","starts_on");--> statement-breakpoint
CREATE INDEX "users_archived_at_idx" ON "users" USING btree ("archived_at");