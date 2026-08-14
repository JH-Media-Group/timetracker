-- Item types: an external reference, and the three types an account starts with.
--
-- `invoice_item_types` has existed since the first migration, carries the two
-- default-role flags and a foreign key from `invoice_line_items`, and until now
-- had no service, no route and no rows. Every line in the system pointed at an
-- empty table. This is the third instance of storage designed and never
-- connected (TALLY-33), which is why the connecting work ships with it.

-- Every other imported entity carries an external reference. Without one the
-- Harvest import cannot recognise a type it created on an earlier run, and a
-- second run would duplicate all three.
ALTER TABLE "invoice_item_types"
  ADD COLUMN IF NOT EXISTS "external_ref" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint

-- Seeded here rather than in the seed script because an account with no
-- services default has invoice lines that cannot say what they are, and
-- `pnpm db:invariants` treats that as broken. A migration runs everywhere; the
-- seed script does not run in production.
--
-- The names and the two default roles are Harvest's, so an imported invoice
-- lands on a type that already means the right thing.
INSERT INTO "invoice_item_types" ("id", "name", "is_default_for_expenses", "is_default_for_services")
VALUES
  (gen_random_uuid(), 'Service', false, true),
  (gen_random_uuid(), 'Product', true, false),
  (gen_random_uuid(), 'Direct Costs', false, false)
ON CONFLICT ("name") DO NOTHING;
--> statement-breakpoint

-- Existing lines get a type by origin: an expense line is a Product, everything
-- else is a Service. Deliberate rather than left null, because null is what the
-- defaults exist to prevent, and a line on a sent invoice with no type would
-- render a blank Item Type column the moment TALLY-31 switches it on.
UPDATE "invoice_line_items" li
   SET "item_type_id" = (SELECT id FROM "invoice_item_types" WHERE "is_default_for_services" LIMIT 1)
 WHERE li."item_type_id" IS NULL;
