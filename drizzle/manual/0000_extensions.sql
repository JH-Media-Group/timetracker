-- Extensions have to exist before any table that uses their types.
-- citext backs case-insensitive email columns; btree_gist backs the rate-range
-- exclusion constraint in 0001_constraints.sql.
CREATE EXTENSION IF NOT EXISTS citext;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;
