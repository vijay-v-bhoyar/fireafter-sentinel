-- Operator-only disposable Supabase rehearsal. All statements are rolled back.
-- Requires all migrations, a populated clone and explicit target confirmation.
\set ON_ERROR_STOP on
begin;
set local lock_timeout = '2s';
set local statement_timeout = '60s';
do $$ begin
  if current_setting('fireafter.assurance_test_target', true) is distinct from 'disposable' then
    raise exception 'Explicit disposable assurance target required';
  end if;
  if public.fireafter_server_owned_write_security_version() is distinct from '20260914070900' then
    raise exception 'Baseline effective write controls not verified';
  end if;
end $$;

do $$
declare
  role_name text;
  table_name text;
  column_name text;
  privilege_name text;
  statement text;
begin
  foreach role_name in array array['anon', 'authenticated'] loop
    execute format('set local role %I', role_name);
    foreach table_name in array array['organizations', 'organization_members', 'incidents',
      'source_runs', 'source_snapshots', 'assets', 'recommendations', 'responder_actions', 'audit_events'] loop
      column_name := case when table_name = 'organization_members' then 'organization_id' else 'id' end;
      foreach statement in array array[
        format('delete from public.%I where false', table_name),
        format('update public.%I set %I = %I where false', table_name, column_name, column_name),
        format('insert into public.%I (%I) select null::uuid where false', table_name, column_name),
        format('truncate table public.%I cascade', table_name)
      ] loop
        begin
          execute statement;
          raise exception 'Unexpected operational write privilege: % on %', role_name, table_name;
        exception when insufficient_privilege then null;
        end;
      end loop;
    end loop;
    begin
      perform public.fireafter_server_owned_write_security_version();
      raise exception 'Browser executed security probe';
    exception when insufficient_privilege then null;
    end;
    reset role;
  end loop;
  set local role service_role;
  if public.fireafter_server_owned_write_security_version() is distinct from '20260914070900' then
    raise exception 'Service role cannot attest write controls';
  end if;
  reset role;

  -- The deliberate exception rolls each grant back in its own subtransaction.
  foreach role_name in array array['public', 'anon', 'authenticated'] loop
    foreach table_name in array array['organizations', 'organization_members', 'incidents',
      'source_runs', 'source_snapshots', 'assets', 'recommendations', 'responder_actions', 'audit_events'] loop
      column_name := case when table_name = 'organization_members' then 'organization_id' else 'id' end;
      foreach privilege_name in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
        begin
          execute format('grant %s on table public.%I to %I', privilege_name, table_name, role_name);
          if public.fireafter_server_owned_write_security_version() is not null then
            raise exception 'Table grant drift missed: % % %', role_name, table_name, privilege_name;
          end if;
          raise exception using errcode = 'ZX001', message = 'rollback tested grant';
        exception when sqlstate 'ZX001' then null;
        end;
      end loop;
      foreach privilege_name in array array['INSERT', 'UPDATE', 'REFERENCES'] loop
        begin
          execute format('grant %s (%I) on table public.%I to %I', privilege_name, column_name, table_name, role_name);
          if public.fireafter_server_owned_write_security_version() is not null then
            raise exception 'Column grant drift missed: % % %', role_name, table_name, privilege_name;
          end if;
          raise exception using errcode = 'ZX001', message = 'rollback tested grant';
        exception when sqlstate 'ZX001' then null;
        end;
      end loop;
    end loop;
  end loop;
end $$;

savepoint controls;
alter table public.assets disable row level security;
do $$ begin
  if public.fireafter_server_owned_write_security_version() is not null then raise exception 'RLS drift missed'; end if;
end $$;
rollback to savepoint controls;
create policy fa09_test_write on public.assets for update to authenticated using (true);
do $$ begin
  if public.fireafter_server_owned_write_security_version() is not null then raise exception 'Policy drift missed'; end if;
end $$;
rollback to savepoint controls;
grant execute on function public.fireafter_server_owned_write_security_version() to public;
do $$ begin
  if public.fireafter_server_owned_write_security_version() is not null then raise exception 'Probe grant drift missed'; end if;
end $$;
rollback to savepoint controls;
alter role authenticated bypassrls;
do $$ begin
  if public.fireafter_server_owned_write_security_version() is not null then raise exception 'Role drift missed'; end if;
end $$;
rollback to savepoint controls;
revoke update on public.assets from service_role;
do $$ begin
  if pg_catalog.has_table_privilege('service_role', 'public.assets', 'UPDATE') then
    raise exception 'Service-loss fixture retains inherited UPDATE; prepare an isolated role fixture before this test';
  end if;
  if public.fireafter_server_owned_write_security_version() is not null then raise exception 'Service write loss missed'; end if;
end $$;
rollback to savepoint controls;
do $$ begin
  if public.fireafter_server_owned_write_security_version() is distinct from '20260914070900' then raise exception 'Drift recovery failed'; end if;
end $$;
rollback;
