set local lock_timeout = '2s';
set local statement_timeout = '60s';

-- FireAfter writes through authenticated route handlers backed by the
-- server-only service role. Browser clients retain tenant-scoped reads only.
alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.incidents enable row level security;
alter table public.source_runs enable row level security;
alter table public.source_snapshots enable row level security;
alter table public.assets enable row level security;
alter table public.recommendations enable row level security;
alter table public.responder_actions enable row level security;
alter table public.audit_events enable row level security;

revoke insert, update, delete
on table
  public.organizations,
  public.organization_members,
  public.incidents,
  public.source_runs,
  public.source_snapshots,
  public.assets,
  public.recommendations,
  public.responder_actions,
  public.audit_events
from public, anon, authenticated;

drop policy if exists "members can manage incidents" on public.incidents;
drop policy if exists "members can create actions" on public.responder_actions;

-- This service-role-only probe returns the migration version only while the
-- live database still enforces the server-owned write boundary.
create or replace function public.fireafter_server_owned_write_security_version()
returns text
language sql
stable
set search_path = ''
as $$
  with protected_tables(table_name) as (
    values
      ('organizations'),
      ('organization_members'),
      ('incidents'),
      ('source_runs'),
      ('source_snapshots'),
      ('assets'),
      ('recommendations'),
      ('responder_actions'),
      ('audit_events')
  ),
  table_controls as (
    select
      count(*) = 9 as all_tables_present,
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
      ) as browser_writes_revoked
    from protected_tables p
    join pg_catalog.pg_namespace n on n.nspname = 'public'
    join pg_catalog.pg_class c
      on c.relnamespace = n.oid
      and c.relname = p.table_name
      and c.relkind in ('r', 'p')
  ),
  policy_controls as (
    select not exists (
      select 1
      from pg_catalog.pg_policies
      where schemaname = 'public'
        and tablename in (
          'organizations',
          'organization_members',
          'incidents',
          'source_runs',
          'source_snapshots',
          'assets',
          'recommendations',
          'responder_actions',
          'audit_events'
        )
        and cmd in ('ALL', 'INSERT', 'UPDATE', 'DELETE')
        and roles && array['public'::name, 'anon'::name, 'authenticated'::name]
    ) as browser_write_policies_absent
  )
  select case
    when table_controls.all_tables_present
      and table_controls.rls_enabled
      and table_controls.browser_writes_revoked
      and policy_controls.browser_write_policies_absent
    then '20260904053500'::text
    else null::text
  end
  from table_controls
  cross join policy_controls;
$$;

revoke all
on function public.fireafter_server_owned_write_security_version()
from public, anon, authenticated;

grant execute
on function public.fireafter_server_owned_write_security_version()
to service_role;
