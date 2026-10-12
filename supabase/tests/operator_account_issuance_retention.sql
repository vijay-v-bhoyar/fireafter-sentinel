-- Operator-only, rollback-only rehearsal. Not executed by Node/static tests.
\set ON_ERROR_STOP on
begin;
set local lock_timeout = '2s';
set local statement_timeout = '60s';

do $$ begin
  if current_setting('fireafter.assurance_test_target', true) is distinct from 'disposable'
    or current_setting('fireafter.assurance_test_database', true) is distinct from current_database()
    or current_user is distinct from 'postgres' then
    raise exception 'Approved disposable database acknowledgement and postgres setup required';
  end if;
end $$;

create temporary table fi_retention_fixture as
select gen_random_uuid() attempt_id,
  gen_random_uuid() user_id,
  (select id from public.organizations order by id limit 1) organization_id,
  ('retention-' || gen_random_uuid()::text || '@example.invalid') email;

do $$ declare f record; begin
  select * into f from fi_retention_fixture;
  if f.organization_id is null then
    raise exception 'Disposable rehearsal requires one existing organization row';
  end if;
end $$;

insert into auth.users(id, email, raw_app_meta_data)
select user_id, email, '{}'::jsonb from fi_retention_fixture;

insert into public.operator_account_issuance_events(
  attempt_id, organization_id, user_id, account_email_hash, requested_role,
  database_role, operator_identity, event_type
)
select attempt_id, organization_id, user_id,
  encode(sha256(convert_to(email, 'UTF8')), 'hex'), 'responder',
  'incident_commander', 'retention-rehearsal-operator', 'succeeded'
from fi_retention_fixture;

delete from auth.users where id = (select user_id from fi_retention_fixture);

do $$ declare f record; v_user_id uuid; v_count integer; begin
  select * into f from fi_retention_fixture;
  select count(*), max(user_id) into v_count, v_user_id
  from public.operator_account_issuance_events
  where attempt_id = f.attempt_id and event_type = 'succeeded';
  if v_count <> 1 or v_user_id is not null then
    raise exception 'Auth deletion did not retain the succeeded audit row with a null user_id';
  end if;
end $$;

do $$ declare f record; begin
  select * into f from fi_retention_fixture;
  begin
    insert into public.operator_account_issuance_events(
      attempt_id, organization_id, user_id, account_email_hash, requested_role,
      database_role, operator_identity, event_type
    ) values (
      gen_random_uuid(), f.organization_id, null,
      encode(sha256(convert_to(f.email, 'UTF8')), 'hex'), 'responder',
      'incident_commander', 'retention-rehearsal-operator', 'succeeded'
    );
    raise exception 'Succeeded event without an Auth user was accepted';
  exception when sqlstate '23514' then null; end;
end $$;

do $$ begin
  if public.fireafter_operator_account_issuance_audit_security_version() is distinct from '20260915130000' then
    raise exception 'Issuance retention security probe did not return 20260915130000';
  end if;
end $$;

rollback;
