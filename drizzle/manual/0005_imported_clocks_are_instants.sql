-- Imported clock times mean local wall time, not UTC (TALLY-57).
--
-- `scripts/harvest-import.mts` built each entry's clock with
-- `Date.UTC(y, mo - 1, d, hour, minute)`, so a session Harvest recorded as
-- starting at 09:00 was stored as 09:00Z. Read in New York, where every one of
-- the 56 imported people sits, that displays as 04:00 or 05:00 depending on the
-- season, and 987 entries land on the day before their own `spent_on`.
--
-- `started_at` and `ended_at` are `timestamptz`: they are instants, which is
-- also what the running timer records. So the fix belongs in the data, not in
-- the formatter. This re-reads each stored value as the wall clock it always
-- meant and resolves it against the account's zone.
--
-- `AT TIME ZONE 'UTC'` drops the offset and yields the naive wall clock that was
-- written; the second `AT TIME ZONE` interprets that wall clock in New York and
-- returns an instant. Postgres applies the offset in force on each row's own
-- date, so entries either side of a daylight-saving boundary shift by the right
-- amount rather than a constant four or five hours.
--
-- Scoped to `source = 'import'`. Entries created in the app already carry true
-- instants and must not be touched.
--
-- Nothing here changes `spent_on`, `duration_seconds`, or any rate, so every
-- reconciliation check is unaffected: they compare days, hours and money, none
-- of which this reads.

UPDATE time_entries
SET started_at = ((started_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/New_York'),
    ended_at   = CASE
                   WHEN ended_at IS NULL THEN NULL
                   ELSE ((ended_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/New_York')
                 END
WHERE source = 'import'
  AND started_at IS NOT NULL;
