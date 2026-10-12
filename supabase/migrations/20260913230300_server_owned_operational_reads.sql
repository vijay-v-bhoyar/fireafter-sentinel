set local lock_timeout = '2s';
set local statement_timeout = '60s';

-- Raw operational rows contain private nested evidence. Browser identities use
-- server-authorized projections. Membership self-read remains unchanged.
revoke select on table
  public.incidents, public.source_runs, public.source_snapshots, public.assets,
  public.recommendations, public.responder_actions, public.audit_events
from public, anon, authenticated;

-- Table revocation does not remove separately granted column privileges.
do $$
declare
  table_name text;
  column_names text;
begin
  foreach table_name in array array['incidents', 'source_runs', 'source_snapshots',
    'assets', 'recommendations', 'responder_actions', 'audit_events'] loop
    select string_agg(format('%I', a.attname), ', ' order by a.attnum)
      into column_names
    from pg_catalog.pg_attribute a
    where a.attrelid = format('public.%I', table_name)::regclass
      and a.attnum > 0 and not a.attisdropped;
    if column_names is null then raise exception 'Operational read boundary is incomplete'; end if;
    execute format('revoke select (%s) on table public.%I from public, anon, authenticated', column_names, table_name);
  end loop;
end;
$$;

grant select on table
  public.incidents, public.source_runs, public.source_snapshots, public.assets,
  public.recommendations, public.responder_actions, public.audit_events
to service_role;

create or replace function public.fireafter_server_owned_read_security_version()
returns text
language sql
stable
set search_path = ''
as $$
  select case when count(*) = 7
    and bool_and(c.relrowsecurity)
    and bool_and(not pg_catalog.has_any_column_privilege('anon', c.oid, 'SELECT'))
    and bool_and(not pg_catalog.has_any_column_privilege('authenticated', c.oid, 'SELECT'))
    and bool_and(pg_catalog.has_table_privilege('service_role', c.oid, 'SELECT'))
  then '20260913230300'::text else null::text end
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
    and c.relname in ('incidents', 'source_runs', 'source_snapshots', 'assets',
      'recommendations', 'responder_actions', 'audit_events');
$$;

revoke all on function public.fireafter_server_owned_read_security_version() from public, anon, authenticated;
grant execute on function public.fireafter_server_owned_read_security_version() to service_role;

-- Inherited grants must be reconciled explicitly; never attest partial denial.
do $$
begin
  if public.fireafter_server_owned_read_security_version() is distinct from '20260913230300' then
    raise exception 'Operational read boundary remains unverified; inspect inherited grants and RLS before retrying';
  end if;
end;
$$;
