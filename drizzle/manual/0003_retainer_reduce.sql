-- A retainer balance can be corrected downward (TALLY-13).
--
-- `retainer_transactions.amount_cents` is checked positive, so a ledger row is a
-- magnitude and the kind carries the direction. Until now the only kinds were
-- add, draw and adjust, and `adjust` could only ever add: the one caller that
-- existed was giving a draw back after a write-off.
--
-- Once a person can move money by hand, a correction downward is an ordinary
-- thing to need. A duplicate payment gets refunded; a figure entered wrong gets
-- put right. Letting `adjust` carry a negative amount would have been the
-- smaller change and it fails `retainer_transactions_positive`, which is the
-- database being right: a column of magnitudes should stay magnitudes.
--
-- So there is a fourth kind. Everything that sums the ledger treats `reduce`
-- like `draw`: `src/server/services/retainers.ts` exports `ledgerDelta` and
-- `DEBIT_KINDS`, and `scripts/invariants.mts`, `tests/invoices.test.ts`,
-- `tests/retainers.test.ts` and the seed all go through it rather than each
-- spelling out the same CASE expression.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'retainer_transactions_kind_valid'
       AND conrelid = 'public.retainer_transactions'::regclass
  ) THEN
    ALTER TABLE retainer_transactions DROP CONSTRAINT retainer_transactions_kind_valid;
  END IF;

  ALTER TABLE retainer_transactions ADD CONSTRAINT retainer_transactions_kind_valid
    CHECK (kind IN ('add', 'draw', 'adjust', 'reduce'));
END $$;
