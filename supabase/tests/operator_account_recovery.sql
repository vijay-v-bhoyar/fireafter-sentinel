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

create temporary table fi_fixture as select gen_random_uuid() attempt_id, gen_random_uuid() org_id,
  gen_random_uuid() user_id, gen_random_uuid() operator_id,
  ('fi-' || gen_random_uuid()::text || '@example.invalid') email,
  ('operator-' || gen_random_uuid()::text || '@example.invalid') operator_email;
grant select on pg_temp.fi_fixture to service_role, anon, authenticated;

-- The operator identity is a separately managed Auth user and DB-owner allowlist row.
insert into auth.users(id,email,raw_app_meta_data)
select operator_id,operator_email,'{}'::jsonb from pg_temp.fi_fixture;
insert into public.operator_account_issuance_operators(user_id,email_hash,label)
select operator_id,encode(sha256(convert_to(lower(operator_email),'UTF8')),'hex'),'Disposable rehearsal operator'
from pg_temp.fi_fixture;

set local role service_role;
do $$ declare f record; begin
  select * into f from pg_temp.fi_fixture;
  begin
    perform public.fireafter_begin_account_issuance(f.attempt_id,f.email,f.org_id,'Disposable FI','responder','spoofed',null);
    raise exception 'Retired service coordinator accepted';
  exception when insufficient_privilege then null; end;
  begin
    perform public.fireafter_begin_account_issuance_as_operator(f.attempt_id,f.email,f.org_id,'Disposable FI','responder',null);
    raise exception 'Service role accepted trusted operator wrapper';
  exception when insufficient_privilege then null; end;
  begin
    perform 1 from public.operator_account_issuance_operators;
    raise exception 'Direct service allowlist read accepted';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

set local role authenticated;
do $$ declare f record; r jsonb; begin
  select * into f from pg_temp.fi_fixture;
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub',f.operator_id::text,'email',f.operator_email,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.role','authenticated',true);
  r := public.fireafter_begin_account_issuance_as_operator(f.attempt_id,f.email,f.org_id,'Disposable FI','responder',null);
  if r->>'claimed' <> 'true' or r->>'state' <> 'auth_pending'
    or r->>'operatorUserId' <> f.operator_id::text
    or r->>'operatorIdentity' <> f.operator_id::text
    or r->>'operatorIdentitySource' <> 'authenticated_supabase_user' then
    raise exception 'Trusted dispatch was not claimed with canonical operator identity';
  end if;
  r := public.fireafter_begin_account_issuance_as_operator(f.attempt_id,f.email,f.org_id,'Never rename','responder',null);
  if r->>'claimed' <> 'false' then raise exception 'Duplicate trusted dispatch'; end if;
  begin
    perform public.fireafter_begin_account_issuance_as_operator(gen_random_uuid(),f.email,f.org_id,'Disposable FI','responder',null);
    raise exception 'Pending email exclusion failed';
  exception when sqlstate 'FI409' then null; end;
  begin
    perform public.fireafter_advance_account_issuance_as_operator(f.attempt_id,f.user_id,'membership');
    raise exception 'Missing Auth outcome accepted';
  exception when sqlstate 'FI409' then null; end;
  r := public.fireafter_get_account_issuance_as_operator(f.attempt_id);
  if r->>'operatorUserId' <> f.operator_id::text then raise exception 'Trusted status lost operator binding'; end if;
end $$;
reset role;

-- Explicit test setup simulates the separately committed Auth provider metadata.
-- Actual cross-service, session and concurrent-transaction proof is separate.
insert into auth.users(id,email,raw_app_meta_data)
select user_id,email,jsonb_build_object('fireafter_issuance_attempt_id',attempt_id::text,
  'fireafter_issuance_email_hash',encode(sha256(convert_to(email,'UTF8')),'hex'),
  'fireafter_role','incident_commander') from pg_temp.fi_fixture;

set local role authenticated;
do $$ declare f record; r jsonb; begin
  select * into f from pg_temp.fi_fixture;
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub',f.operator_id::text,'email',f.operator_email,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.role','authenticated',true);
  r := public.fireafter_advance_account_issuance_as_operator(f.attempt_id,f.user_id,'membership');
  if r->>'state' <> 'membership_committed' then raise exception 'Membership not committed'; end if;
  r := public.fireafter_advance_account_issuance_as_operator(f.attempt_id,f.user_id,'succeeded');
  if r->>'state' <> 'succeeded' or r->>'completedAt' is null then raise exception 'Success not committed'; end if;
  perform public.fireafter_advance_account_issuance_as_operator(f.attempt_id,f.user_id,'succeeded');
end $$;
reset role;
do $$ declare f record; begin
  select * into f from pg_temp.fi_fixture;
  if (select count(*) from public.operator_account_issuance_events where attempt_id=f.attempt_id and event_type='succeeded') <> 1 then raise exception 'Duplicate terminal receipt'; end if;
  if (select count(*) from public.operator_account_issuance_events where attempt_id=f.attempt_id and operator_user_id=f.operator_id and operator_identity_source='authenticated_supabase_user') <> 2 then raise exception 'Canonical operator ledger binding missing'; end if;
  if (select name from public.organizations where id=f.org_id) <> 'Disposable FI' then raise exception 'Existing organization renamed'; end if;
end $$;

set local role authenticated;
do $$ declare f record; begin
  select * into f from pg_temp.fi_fixture;
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub',gen_random_uuid()::text,'email','not-allowlisted@example.invalid','role','authenticated')::text,true);
  perform set_config('request.jwt.claim.role','authenticated',true);
  begin
    perform public.fireafter_get_account_issuance_as_operator(f.attempt_id);
    raise exception 'Cross-operator status accepted';
  exception when sqlstate 'FI403' then null; end;
end $$;
reset role;
set local role anon;
do $$ declare f record; begin
  select * into f from pg_temp.fi_fixture;
  begin
    perform public.fireafter_get_account_issuance_as_operator(f.attempt_id);
    raise exception 'Anonymous trusted status accepted';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
-- A grant followed by revoke must leave a tombstone even inside this transaction.
do $$ declare a uuid := gen_random_uuid(); o uuid := gen_random_uuid(); u uuid := gen_random_uuid();
  e text := 'fi-aba-' || gen_random_uuid()::text || '@example.invalid'; begin
  perform public.fireafter_begin_account_issuance(a,e,o,'Disposable ABA','responder','fixture operator',null);
  insert into auth.users(id,email,raw_app_meta_data) values(u,e,jsonb_build_object(
    'fireafter_issuance_attempt_id',a::text,'fireafter_issuance_email_hash',encode(sha256(convert_to(e,'UTF8')),'hex'),
    'fireafter_role','incident_commander'));
  insert into public.organization_members(organization_id,user_id,role) values(o,u,'viewer');
  delete from public.organization_members where organization_id=o and user_id=u;
  begin
    perform public.fireafter_advance_account_issuance(a,u,'membership');
    raise exception 'Grant/revoke ABA was accepted';
  exception when sqlstate 'FI409' then null; end;
  if exists(select 1 from public.organization_members where organization_id=o and user_id=u) then raise exception 'Revoked member restored'; end if;
end $$;
rollback;
