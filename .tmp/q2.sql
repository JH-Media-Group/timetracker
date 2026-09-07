select 'people with a billable rate row' as fact,
       count(distinct user_id) filter (where kind='billable') as n
from user_rates
union all
select 'active people', count(*) from users where archived_at is null
union all
select 'projects billBy=people (active)', count(*) from projects where archived_at is null and bill_by='people'
union all
select 'projects billBy=project (active)', count(*) from projects where archived_at is null and bill_by='project'
union all
select 'active T&M projects with no project rate', count(*) from projects
  where archived_at is null and billing_type='time_and_materials' and bill_by='project' and hourly_rate_cents is null;
