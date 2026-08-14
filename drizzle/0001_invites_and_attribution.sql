CREATE TABLE "user_invites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" "citext" NOT NULL,
	"profile_id" uuid NOT NULL,
	"first_name" text,
	"last_name" text,
	"employment_type" text DEFAULT 'employee' NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_user_id" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_invites_tokenHash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "updated_by" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "updated_by" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "updated_by" uuid;--> statement-breakpoint
ALTER TABLE "user_invites" ADD CONSTRAINT "user_invites_profile_id_permission_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."permission_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_invites" ADD CONSTRAINT "user_invites_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_invites" ADD CONSTRAINT "user_invites_accepted_user_id_users_id_fk" FOREIGN KEY ("accepted_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_invites_email_idx" ON "user_invites" USING btree ("email");