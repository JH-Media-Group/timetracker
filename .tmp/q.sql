select
  count(*)                                             as entries,
  count(*) filter (where billable_rate_cents > 0)      as with_billable_rate,
  count(*) filter (where billable_rate_cents = 0)      as zero_billable_rate,
  count(*) filter (where is_billable)                  as billable_flagged,
  count(*) filter (where is_billable and billable_rate_cents = 0) as billable_but_zero
from time_entries where deleted_at is null;
