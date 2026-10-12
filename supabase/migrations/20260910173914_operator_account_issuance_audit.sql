set local lock_timeout = '2s';
set local statement_timeout = '60s';

create table if not exists public.operator_account_issuance_events (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  user_id uuid references auth.users(id) on delete set null,
  account_email_hash text not null check (account_email_hash ~ '^[0-9a-f]{64}$'),
  requested_role text not null check (requested_role in ('reviewer', 'responder', 'viewer')),
  database_role text not null check (database_role in ('analyst', 'incident_commander', 'viewer')),
  operator_identity text not null check (length(trim(operator_identity)) between 1 and 320),
  event_type text not null check (event_type in ('started', 'succeeded', 'failed')),
  failure_code text check (failure_code is null or failure_code = 'account_issuance_failed'),
  created_at timestamptz not null default now(),
  check ((event_type = 'failed') = (failure_code is not null)),
  check (event_type <> 'succeeded' or user_id is not null),
  unique (attempt_id, event_type)
);

create index if not exists operator_account_issuance_events_org_created_idx
  on public.operator_account_issuance_events (organization_id, created_at desc);

create unique index if not exists operator_account_issuance_events_one_terminal_idx
  on public.operator_account_issuance_events (attempt_id)
  where event_type in ('succeeded', 'failed');

alter table public.operator_account_issuance_events enable row level security;

revoke all on table public.operator_account_issuance_events from public, anon, authenticated;
grant insert on table public.operator_account_issuance_events to service_role;

-- This read-only service-role probe keeps readiness honest when the issuer's
-- append-only audit table has not been applied or its client boundary drifts.
create or replace function public.fireafter_operator_account_issuance_audit_security_version()
returns text
language sql
stable
set search_path = ''
as $$
  with table_controls as (
    select
      count(c.oid) = 1 as table_present,
      bool_and(c.relrowsecurity) as rls_enabled,
      bool_and(
        not pg_catalog.has_table_privilege(
          'anon',
          pg_catalog.format('%I.%I', n.nspname, c.relname),
          'INSERT,UPDATE,DELETE'
        )
        and not pg_catalog.has_table_privilege(
          'authenticated',
          pg_catalog.format('%I.%I', n.nspname, c.relname),
          'INSERT,UPDATE,DELETE'
        )
      ) as browser_writes_revoked,
      bool_and(
        pg_catalog.has_table_privilege(
          'service_role',
          pg_catalog.format('%I.%I', n.nspname, c.relname),
          'INSERT'
        )
      ) as service_insert_granted
    from pg_catalog.pg_namespace n
    left join pg_catalog.pg_class c
      on c.relnamespace = n.oid
      and c.relname = 'operator_account_issuance_events'
      and c.relkind in ('r', 'p')
    where n.nspname = 'public'
  )
  select case
    when table_controls.table_present
      and table_controls.rls_enabled
      and table_controls.browser_writes_revoked
      and table_controls.service_insert_granted
    then '20260910173914'::text
    else null::text
  end
  from table_controls;
$$;

revoke all
on function public.fireafter_operator_account_issuance_audit_security_version()
from public, anon, authenticated;

grant execute
on function public.fireafter_operator_account_issuance_audit_security_version()
to service_role;
