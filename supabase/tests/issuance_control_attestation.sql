-- Operator-only populated disposable rehearsal. NOT run by offline tests.
\set ON_ERROR_STOP on
begin;
set local lock_timeout = '2s';
set local statement_timeout = '60s';
do $$ begin
  if current_setting('fireafter.assurance_test_target', true) is distinct from 'disposable'
    or current_setting('fireafter.assurance_test_database', true) is distinct from current_database()
    or current_user is distinct from 'postgres' or session_user is distinct from 'postgres' then
    raise exception 'Named approved disposable database and postgres setup required';
  end if;
  if public.fireafter_operator_account_issuance_audit_security_version() is distinct from '20260914150000' then
    raise exception 'Baseline issuance controls failed; inspect exact catalog definitions without weakening the oracle';
  end if;
end $$;

-- Catalog changes require an idle disposable clone, never a target serving traffic.
lock table public.operator_account_issuance_events, public.operator_account_issuance_attempts,
  public.operator_account_membership_versions, public.organization_members in access exclusive mode;

do $fa20_capability$ begin
  begin
    alter role authenticated bypassrls;
    if public.fireafter_operator_account_issuance_audit_security_version() is not null then
      raise exception 'Role drift missed during capability preflight';
    end if;
    raise exception using errcode = 'ZX001', message = 'rollback capability drift';
  exception
    when insufficient_privilege then
      raise exception using errcode = '42501', message =
        'Rehearsal capability unavailable: use an approved disposable postgres session authorized to ALTER ROLE authenticated BYPASSRLS. PostgreSQL 17 requires superuser or appropriate CREATEROLE, BYPASSRLS and role ADMIN authority. Do not elevate production privileges or skip this case.';
    when sqlstate 'ZX001' then null;
  end;
  if public.fireafter_operator_account_issuance_audit_security_version() is distinct from '20260914150000' then
    raise exception 'Capability preflight did not restore baseline controls';
  end if;
end $fa20_capability$;

create temporary view fa20_rehearsal_rows as
  select 'operator_account_issuance_events'::text as table_name, to_jsonb(r) as row_data
    from public.operator_account_issuance_events r
  union all select 'operator_account_issuance_attempts', to_jsonb(r)
    from public.operator_account_issuance_attempts r
  union all select 'operator_account_membership_versions', to_jsonb(r)
    from public.operator_account_membership_versions r
  union all select 'organization_members', to_jsonb(r)
    from public.organization_members r;
revoke all on table pg_temp.fa20_rehearsal_rows from public, anon, authenticated, service_role;
create temporary table fa20_rehearsal_before on commit drop as
  select table_name, row_data from pg_temp.fa20_rehearsal_rows;
revoke all on table pg_temp.fa20_rehearsal_before from public, anon, authenticated, service_role;
do $$ begin
  if (select count(distinct table_name) from pg_temp.fa20_rehearsal_before) <> 4 then
    raise exception 'Populated rehearsal required: restore approved issuance history, coordinated attempts, membership generations and memberships. Empty tables do not prove history preservation.';
  end if;
end $$;

set local role service_role;
do $$ begin
  if public.fireafter_operator_account_issuance_audit_security_version() is distinct from '20260914150000' then
    raise exception 'Service cannot attest issuance controls';
  end if;
end $$;
reset role;

do $$ declare role_name text; table_name text; privilege_name text; statement text; begin
  foreach role_name in array array['anon','authenticated'] loop
    execute format('set local role %I', role_name);
    foreach table_name in array array['operator_account_issuance_events','operator_account_issuance_attempts','operator_account_membership_versions'] loop
      begin
        execute format('select * from public.%I where false', table_name);
        raise exception 'Browser read allowed';
      exception when insufficient_privilege then null; end;
      begin
        execute format('delete from public.%I where false', table_name);
        raise exception 'Browser mutation allowed';
      exception when insufficient_privilege then null; end;
    end loop;
    begin
      perform public.fireafter_operator_account_issuance_audit_security_version();
      raise exception 'Browser probe execution allowed';
    exception when insufficient_privilege then null; end;
    reset role;
  end loop;
  foreach role_name in array array['public','anon','authenticated','service_role'] loop
    foreach table_name in array array['operator_account_issuance_events','operator_account_issuance_attempts','operator_account_membership_versions'] loop
      foreach privilege_name in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] loop
        if privilege_name = 'INSERT' and role_name = 'service_role' and table_name = 'operator_account_issuance_events' then continue; end if;
        begin
          execute format('grant %s on public.%I to %I', privilege_name, table_name, role_name);
          if public.fireafter_operator_account_issuance_audit_security_version() is not null then raise exception 'Table privilege drift missed'; end if;
          raise exception using errcode = 'ZX001', message = 'rollback tested grant';
        exception when sqlstate 'ZX001' then null; end;
      end loop;
      foreach privilege_name in array array['SELECT','INSERT','UPDATE','REFERENCES'] loop
        if privilege_name = 'INSERT' and role_name = 'service_role' and table_name = 'operator_account_issuance_events' then continue; end if;
        begin
          execute format('grant %s (%I) on public.%I to %I', privilege_name,
            case when table_name = 'operator_account_membership_versions' then 'generation' else 'attempt_id' end, table_name, role_name);
          if public.fireafter_operator_account_issuance_audit_security_version() is not null then raise exception 'Column privilege drift missed'; end if;
          raise exception using errcode = 'ZX001', message = 'rollback tested column grant';
        exception when sqlstate 'ZX001' then null; end;
      end loop;
    end loop;
  end loop;

  foreach statement in array array[
    'create rule fa20_drop_audit as on insert to public.operator_account_issuance_events do instead nothing',
    'create rule fa20_drop_membership as on update to public.organization_members do instead nothing',
    'alter table public.operator_account_issuance_events disable row level security',
    'alter table public.operator_account_issuance_attempts disable row level security',
    'alter table public.operator_account_membership_versions disable row level security',
    'alter table public.operator_account_issuance_events alter column event_type drop not null',
    'drop index public.operator_account_issuance_events_one_terminal_idx',
    'drop index public.operator_account_issuance_one_pending_email',
    'alter table public.organization_members disable trigger fireafter_account_membership_generation',
    'alter table public.organization_members enable trigger fireafter_account_membership_generation',
    'alter table public.organization_members disable trigger fireafter_account_membership_no_truncate',
    'alter function public.fireafter_begin_account_issuance(uuid,text,uuid,text,text,text,uuid) reset all',
    'alter function public.fireafter_advance_account_issuance(uuid,uuid,text) security invoker',
    'alter function public.fireafter_get_account_issuance(uuid) strict',
    'grant execute on function public.fireafter_track_account_membership() to service_role',
    'grant execute on function public.fireafter_advance_account_issuance(uuid,uuid,text) to authenticated',
    'grant execute on function public.fireafter_operator_account_issuance_audit_security_version() to public',
    'revoke insert on public.operator_account_issuance_events from service_role'
  ] loop
    begin
      execute statement;
      if public.fireafter_operator_account_issuance_audit_security_version() is not null then raise exception 'Catalog drift missed: %', statement; end if;
      raise exception using errcode = 'ZX001', message = 'rollback tested catalog drift';
    exception when sqlstate 'ZX001' then null; end;
  end loop;

  for statement in select format('alter table public.operator_account_issuance_attempts drop constraint %I', c.conname)
    from pg_catalog.pg_constraint c where c.conrelid = 'public.operator_account_issuance_attempts'::regclass
      and c.contype = 'c' and pg_catalog.pg_get_constraintdef(c.oid) like '%completed_at%'
  loop
    begin
      execute statement;
      if public.fireafter_operator_account_issuance_audit_security_version() is not null then raise exception 'Lifecycle check removal missed'; end if;
      raise exception using errcode = 'ZX001', message = 'rollback tested lifecycle drift';
    exception when sqlstate 'ZX001' then null; end;
  end loop;
end $$;

do $fa20_restore$ begin
  if public.fireafter_operator_account_issuance_audit_security_version() is distinct from '20260914150000' then
    raise exception 'Final issuance controls differ from baseline';
  end if;
  if exists (
    (select table_name, row_data from pg_temp.fa20_rehearsal_before
      except all select table_name, row_data from pg_temp.fa20_rehearsal_rows)
    union all
    (select table_name, row_data from pg_temp.fa20_rehearsal_rows
      except all select table_name, row_data from pg_temp.fa20_rehearsal_before)
  ) then
    raise exception 'Rehearsal changed retained issuance history or membership rows';
  end if;
end $fa20_restore$;

-- Real new/existing issuance, same-email/ABA/late-response races and Auth/JWT
-- validation are separate acceptance, not replaced by these catalog mutations.
rollback;
\echo 'Catalog drift and row restoration passed; real Auth, concurrency, recovery and hosted acceptance remain required.'
