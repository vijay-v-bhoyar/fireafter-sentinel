set local lock_timeout = '2s';
set local statement_timeout = '60s';

-- Forward candidate only: apply through an operator-approved transaction.
-- Table revocation also removes corresponding direct column grants. Inherited
-- privileges are not rewritten; the final effective check rejects them.
revoke insert, update, delete, truncate, references, trigger on table
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

create or replace function public.fireafter_server_owned_write_security_version()
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  with protected_tables(table_name) as (
    values ('organizations'), ('organization_members'), ('incidents'),
      ('source_runs'), ('source_snapshots'), ('assets'), ('recommendations'),
      ('responder_actions'), ('audit_events')
  ), table_controls as (
    select count(*) = 9 as all_tables_present,
      bool_and(c.relrowsecurity) as rls_enabled,
      bool_and(
        not pg_catalog.has_table_privilege('anon', c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        and not pg_catalog.has_table_privilege('authenticated', c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        and not pg_catalog.has_any_column_privilege('anon', c.oid, 'INSERT,UPDATE,REFERENCES')
        and not pg_catalog.has_any_column_privilege('authenticated', c.oid, 'INSERT,UPDATE,REFERENCES')
      ) as browser_writes_revoked,
      bool_and(
        pg_catalog.has_table_privilege('service_role', c.oid, 'SELECT')
        and pg_catalog.has_table_privilege('service_role', c.oid, 'INSERT')
        and pg_catalog.has_table_privilege('service_role', c.oid, 'UPDATE')
        and pg_catalog.has_table_privilege('service_role', c.oid, 'DELETE')
      ) as service_access_available
    from protected_tables t
    join pg_catalog.pg_namespace n on n.nspname = 'public'
    join pg_catalog.pg_class c on c.relnamespace = n.oid
      and c.relname = t.table_name and c.relkind in ('r', 'p')
  ), policy_controls as (
    select not exists (
      select 1 from pg_catalog.pg_policies p
      join protected_tables t on t.table_name = p.tablename
      where p.schemaname = 'public'
        and p.cmd in ('ALL', 'INSERT', 'UPDATE', 'DELETE')
        and p.roles && array['public'::name, 'anon'::name, 'authenticated'::name]
    ) as browser_write_policies_absent
  ), role_controls as (
    select count(*) = 2 and bool_and(
      not r.rolsuper and not r.rolbypassrls and not r.rolcreaterole
      and not r.rolcreatedb and not r.rolreplication
      and not pg_catalog.pg_has_role(r.oid, 'service_role', 'MEMBER')
    ) as browser_roles_restricted
    from pg_catalog.pg_roles r where r.rolname in ('anon', 'authenticated')
  ), probe_controls as (
    select count(*) = 1 and bool_and(
      p.proowner = 'postgres'::regrole and not p.prosecdef
      and p.proconfig = array['search_path=""']::text[]
      and not pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
      and not pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')
    ) as probe_restricted
    from pg_catalog.pg_proc p
    where p.oid = pg_catalog.to_regprocedure('public.fireafter_server_owned_write_security_version()')
  )
  select case when table_controls.all_tables_present
    and table_controls.rls_enabled and table_controls.browser_writes_revoked
    and table_controls.service_access_available
    and policy_controls.browser_write_policies_absent
    and role_controls.browser_roles_restricted and probe_controls.probe_restricted
    then '20260914070900'::text else null::text end
  from table_controls cross join policy_controls cross join role_controls cross join probe_controls;
$$;

alter function public.fireafter_server_owned_write_security_version() owner to postgres;
revoke all on function public.fireafter_server_owned_write_security_version() from public, anon, authenticated, service_role;
grant execute on function public.fireafter_server_owned_write_security_version() to service_role;

do $$
begin
  if public.fireafter_server_owned_write_security_version() is distinct from '20260914070900' then
    raise exception 'Effective operational write controls are not verified; inspect grants, roles, RLS and probe configuration before retrying';
  end if;
end;
$$;
