ALTER TABLE "api_tokens" ADD COLUMN "oauth_client_id" text;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "resource" text;--> statement-breakpoint
ALTER TABLE "oauth_authorization_codes" ADD COLUMN "resource" text;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_oauth_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("oauth_client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE no action ON UPDATE no action;