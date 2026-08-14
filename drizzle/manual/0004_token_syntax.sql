-- Label and message tokens move from [name] to {{name}}.
--
-- Handlebars and Mustache spelling, which most people have seen before.
-- Harvest uses %name% and the first draft here used [name]; both work and
-- neither is recognisable on sight. These templates are read and edited by
-- people rather than parsed by anything else, so the familiar spelling wins.
--
-- Only stored overrides need rewriting. Defaults live in
-- `src/domain/invoice-config.ts` and are resolved at read time, so an account
-- that never edited a label has nothing here to change. An account that did
-- would otherwise keep a [days] that quietly stopped substituting and printed
-- itself on an invoice.
--
-- The regex is deliberately narrow: [word] only. A label that legitimately
-- contains brackets around something that is not a token, "Amount (USD) [net]"
-- say, would be caught, which is why this runs once against known content
-- rather than living in the renderer.
UPDATE settings
   SET invoice_field_labels = (
         SELECT COALESCE(jsonb_object_agg(key, regexp_replace(value #>> '{}', '\[(\w+)\]', '{{\1}}', 'g')), '{}'::jsonb)
           FROM jsonb_each(invoice_field_labels)
       )
 WHERE invoice_field_labels <> '{}'::jsonb;
--> statement-breakpoint

UPDATE settings
   SET invoice_messages = (
         SELECT COALESCE(jsonb_object_agg(key, regexp_replace(value #>> '{}', '\[(\w+)\]', '{{\1}}', 'g')), '{}'::jsonb)
           FROM jsonb_each(invoice_messages)
       )
 WHERE invoice_messages <> '{}'::jsonb;
