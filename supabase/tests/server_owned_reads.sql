-- Operator-only rehearsal on a disposable, fully migrated Supabase database.
-- Set fireafter.assurance_test_target=disposable in this session before running.
-- No production command or credential is embedded. All drift is rolled back.
\set ON_ERROR_STOP on
begin;
do $$
begin
  if current_setting('fireafter.assurance_test_target', true) is distinct from 'disposable' then
    raise exception 'Explicit disposable assurance target required';
  end if;
  if public.fireafter_server_owned_read_security_version() is distinct from '20260913230300' then
    raise exception 'Baseline read controls are not verified';
  end if;
end;
$$;

do $$
declare
  role_name text;
  table_name text;
begin
  foreach role_name in array array['anon', 'authenticated'] loop
    execute format('set local role %I', role_name);
    foreach table_name in array array['incidents', 'source_runs', 'source_snapshots',
      'assets', 'recommendations', 'responder_actions', 'audit_events'] loop
      begin
        execute format('select * from public.%I limit 1', table_name);
        raise exception 'Unexpected raw table read: %', table_name;
      exception when insufficient_privilege then null;
      end;
      begin
        execute format('select id from public.%I limit 1', table_name);
        raise exception 'Unexpected raw column read: %', table_name;
      exception when insufficient_privilege then null;
      end;
    end loop;
    begin
      perform public.fireafter_server_owned_read_security_version();
      raise exception 'Browser role executed the read-security probe';
    exception when insufficient_privilege then null;
    end;
    reset role;
  end loop;
  set local role service_role;
  foreach table_name in array array['incidents', 'source_runs', 'source_snapshots',
    'assets', 'recommendations', 'responder_actions', 'audit_events'] loop
    execute format('select * from public.%I limit 1', table_name);
  end loop;
  if public.fireafter_server_owned_read_security_version() is distinct from '20260913230300' then
    raise exception 'Service read probe failed';
  end if;
  reset role;
  if not pg_catalog.has_table_privilege('authenticated', 'public.organization_members', 'SELECT') then
    raise exception 'Membership self-read grant was lost';
  end if;
end;
$$;

savepoint read_drift;
grant select on public.assets to public;
do $$ begin
  if public.fireafter_server_owned_read_security_version() is not null then raise exception 'PUBLIC grant drift was missed'; end if;
end $$;
rollback to savepoint read_drift;
grant select (properties) on public.assets to authenticated;
do $$ begin
  if public.fireafter_server_owned_read_security_version() is not null then raise exception 'Column grant drift was missed'; end if;
end $$;
rollback to savepoint read_drift;
revoke select on public.assets from service_role;
do $$ begin
  if public.fireafter_server_owned_read_security_version() is not null then raise exception 'Service grant loss was missed'; end if;
end $$;
rollback to savepoint read_drift;
alter table public.assets disable row level security;
do $$ begin
  if public.fireafter_server_owned_read_security_version() is not null then raise exception 'RLS drift was missed'; end if;
end $$;
rollback;
