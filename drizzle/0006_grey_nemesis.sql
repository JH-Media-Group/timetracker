CREATE TABLE "oauth_authorization_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"client_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"scopes" text[] NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_authorization_codes_codeHash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE TABLE "oauth_clients" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"client_name" text NOT NULL,
	"redirect_uris" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_clients_clientId_unique" UNIQUE("client_id")
);
--> statement-breakpoint
ALTER TABLE "oauth_authorization_codes" ADD CONSTRAINT "oauth_authorization_codes_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_authorization_codes" ADD CONSTRAINT "oauth_authorization_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;