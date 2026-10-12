set local lock_timeout = '2s';
set local statement_timeout = '60s';

-- The allowlist is deliberately DB-owner managed. No client, including the
-- service role, can mint operator authority by writing this table.
create table public.operator_account_issuance_operators (
  user_id uuid primary key references auth.users(id) on delete restrict,
  email_hash text not null check (email_hash ~ '^[a-f0-9]{64}$'),
  label text not null default 'FireAfter operator' check (length(trim(label)) between 1 and 320),
  enabled boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
alter table public.operator_account_issuance_operators owner to postgres;
alter table public.operator_account_issuance_operators enable row level security;
revoke all on table public.operator_account_issuance_operators from public, anon, authenticated, service_role;

-- Existing rows remain auditable but cannot be used through the trusted path
-- until a new authenticated operator starts a fresh attempt.
alter table public.operator_account_issuance_attempts
  add column if not exists operator_user_id uuid references auth.users(id) on delete restrict;
alter table public.operator_account_issuance_attempts
  add column if not exists operator_identity_source text not null default 'legacy_operator_supplied'
    check (operator_identity_source in ('legacy_operator_supplied', 'authenticated_supabase_user'));
alter table public.operator_account_issuance_events
  add column if not exists operator_user_id uuid references auth.users(id) on delete restrict;
alter table public.operator_account_issuance_events
  add column if not exists operator_identity_source text not null default 'legacy_operator_supplied'
    check (operator_identity_source in ('legacy_operator_supplied', 'authenticated_supabase_user'));

create function public.fireafter_current_trusted_issuance_operator()
returns uuid
language plpgsql stable security definer
set search_path = '' set statement_timeout = '10s'
as $$
declare
  v_user_id uuid := auth.uid();
  v_email text := pg_catalog.lower(pg_catalog.btrim(auth.jwt() ->> 'email'));
begin
  if v_user_id is null or v_email is null or current_setting('request.jwt.claim.role', true) is distinct from 'authenticated' then
    raise exception 'Authenticated operator session is required' using errcode = 'FI401';
  end if;
  if not exists (
    select 1 from public.operator_account_issuance_operators o
    where o.user_id = v_user_id and o.enabled
      and o.email_hash = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_email, 'UTF8')), 'hex')
  ) then
    raise exception 'Authenticated user is not an enabled issuance operator' using errcode = 'FI403';
  end if;
  return v_user_id;
end;
$$;
alter function public.fireafter_current_trusted_issuance_operator() owner to postgres;
revoke all on function public.fireafter_current_trusted_issuance_operator() from public, anon, authenticated, service_role;

create function public.fireafter_begin_account_issuance_as_operator(
  p_attempt_id uuid, p_email text, p_organization_id uuid, p_organization_name text,
  p_requested_role text, p_existing_user_id uuid
)
returns jsonb
language plpgsql volatile security definer
set search_path = '' set lock_timeout = '2s' set statement_timeout = '20s'
as $$
declare
  v_operator_user_id uuid;
  v_bound_operator_id uuid;
  v_attempt_exists boolean := false;
  v_receipt jsonb;
begin
  v_operator_user_id := public.fireafter_current_trusted_issuance_operator();
  select true, operator_user_id into v_attempt_exists, v_bound_operator_id
    from public.operator_account_issuance_attempts where attempt_id = p_attempt_id for share;
  if v_attempt_exists and v_bound_operator_id is null then
    raise exception 'Legacy issuance attempt has no trusted operator binding; reconcile it outside this path' using errcode = 'FI409';
  end if;
  if v_attempt_exists and v_bound_operator_id is distinct from v_operator_user_id then
    raise exception 'Issuance attempt belongs to another operator' using errcode = 'FI403';
  end if;
  v_receipt := public.fireafter_begin_account_issuance(
    p_attempt_id, p_email, p_organization_id, p_organization_name,
    p_requested_role, v_operator_user_id::text, p_existing_user_id
  );
  update public.operator_account_issuance_attempts
    set operator_user_id = v_operator_user_id,
        operator_identity = v_operator_user_id::text,
        operator_identity_source = 'authenticated_supabase_user'
    where attempt_id = p_attempt_id and operator_user_id is null;
  update public.operator_account_issuance_events
    set operator_user_id = v_operator_user_id,
        operator_identity = v_operator_user_id::text,
        operator_identity_source = 'authenticated_supabase_user'
    where attempt_id = p_attempt_id and operator_user_id is null;
  return v_receipt || pg_catalog.jsonb_build_object(
    'operatorUserId', v_operator_user_id,
    'operatorIdentity', v_operator_user_id::text,
    'operatorIdentitySource', 'authenticated_supabase_user'
  );
end;
$$;

create function public.fireafter_get_account_issuance_as_operator(p_attempt_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = '' set statement_timeout = '20s'
as $$
declare
  v_operator_user_id uuid;
  v_bound_operator_id uuid;
  v_receipt jsonb;
begin
  v_operator_user_id := public.fireafter_current_trusted_issuance_operator();
  select operator_user_id into v_bound_operator_id from public.operator_account_issuance_attempts
    where attempt_id = p_attempt_id for share;
  if not found then raise exception 'Issuance intent missing' using errcode = 'FI404'; end if;
  if v_bound_operator_id is null then raise exception 'Legacy issuance attempt has no trusted operator binding' using errcode = 'FI409'; end if;
  if v_bound_operator_id is distinct from v_operator_user_id then
    raise exception 'Issuance attempt belongs to another operator' using errcode = 'FI403';
  end if;
  v_receipt := public.fireafter_get_account_issuance(p_attempt_id);
  return v_receipt || pg_catalog.jsonb_build_object(
    'operatorUserId', v_operator_user_id,
    'operatorIdentity', v_operator_user_id::text,
    'operatorIdentitySource', 'authenticated_supabase_user'
  );
end;
$$;

create function public.fireafter_advance_account_issuance_as_operator(
  p_attempt_id uuid, p_user_id uuid, p_phase text
)
returns jsonb
language plpgsql volatile security definer
set search_path = '' set lock_timeout = '2s' set statement_timeout = '20s'
as $$
declare
  v_operator_user_id uuid;
  v_bound_operator_id uuid;
  v_receipt jsonb;
begin
  v_operator_user_id := public.fireafter_current_trusted_issuance_operator();
  select operator_user_id into v_bound_operator_id from public.operator_account_issuance_attempts
    where attempt_id = p_attempt_id for share;
  if not found then raise exception 'Issuance intent missing' using errcode = 'FI404'; end if;
  if v_bound_operator_id is null then raise exception 'Legacy issuance attempt has no trusted operator binding' using errcode = 'FI409'; end if;
  if v_bound_operator_id is distinct from v_operator_user_id then
    raise exception 'Issuance attempt belongs to another operator' using errcode = 'FI403';
  end if;
  v_receipt := public.fireafter_advance_account_issuance(p_attempt_id, p_user_id, p_phase);
  update public.operator_account_issuance_attempts
    set operator_user_id = v_operator_user_id,
        operator_identity = v_operator_user_id::text,
        operator_identity_source = 'authenticated_supabase_user'
    where attempt_id = p_attempt_id;
  update public.operator_account_issuance_events
    set operator_user_id = v_operator_user_id,
        operator_identity = v_operator_user_id::text,
        operator_identity_source = 'authenticated_supabase_user'
    where attempt_id = p_attempt_id and operator_user_id is null;
  return v_receipt || pg_catalog.jsonb_build_object(
    'operatorUserId', v_operator_user_id,
    'operatorIdentity', v_operator_user_id::text,
    'operatorIdentitySource', 'authenticated_supabase_user'
  );
end;
$$;

alter function public.fireafter_begin_account_issuance_as_operator(uuid,text,uuid,text,text,uuid) owner to postgres;
alter function public.fireafter_get_account_issuance_as_operator(uuid) owner to postgres;
alter function public.fireafter_advance_account_issuance_as_operator(uuid,uuid,text) owner to postgres;
revoke all on function public.fireafter_get_account_issuance(uuid),
  public.fireafter_begin_account_issuance(uuid,text,uuid,text,text,text,uuid),
  public.fireafter_advance_account_issuance(uuid,uuid,text) from public, anon, authenticated, service_role;
revoke all on function public.fireafter_begin_account_issuance_as_operator(uuid,text,uuid,text,text,uuid),
  public.fireafter_get_account_issuance_as_operator(uuid),
  public.fireafter_advance_account_issuance_as_operator(uuid,uuid,text) from public, anon, service_role;
grant execute on function public.fireafter_begin_account_issuance_as_operator(uuid,text,uuid,text,text,uuid),
  public.fireafter_get_account_issuance_as_operator(uuid),
  public.fireafter_advance_account_issuance_as_operator(uuid,uuid,text) to authenticated;

-- Readiness probes the live wrapper boundary, not just the existence of this file.
create or replace function public.fireafter_operator_account_issuance_audit_security_version()
returns text language sql stable security invoker set search_path = ''
as $$
  with table_controls as (
    select count(*) = 1 and bool_and(c.relkind = 'r' and c.relrowsecurity and c.relowner = 'postgres'::regrole
      and not pg_catalog.has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      and not pg_catalog.has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      and not pg_catalog.has_table_privilege('service_role', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      and not pg_catalog.has_any_column_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')
      and not pg_catalog.has_any_column_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')
      and not pg_catalog.has_any_column_privilege('service_role', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')) valid
    from pg_catalog.pg_class c where c.oid = pg_catalog.to_regclass('public.operator_account_issuance_operators')
  ), column_controls as (
    select count(*) = 4 and bool_and(not a.attisdropped and a.atttypid = pg_catalog.to_regtype('pg_catalog.' || r.type_name)
      and a.attnotnull = r.required) valid
    from (values ('operator_account_issuance_attempts','operator_user_id','uuid',false),
      ('operator_account_issuance_attempts','operator_identity_source','text',true),
      ('operator_account_issuance_events','operator_user_id','uuid',false),
      ('operator_account_issuance_events','operator_identity_source','text',true)) r(table_name,column_name,type_name,required)
    join pg_catalog.pg_attribute a on a.attrelid = pg_catalog.to_regclass('public.' || r.table_name)
      and a.attname = r.column_name and a.attnum > 0
  ), helper_controls as (
    select count(*) = 1 and bool_and(p.proowner = 'postgres'::regrole and p.prosecdef
      and p.proconfig = array['search_path=""','statement_timeout=10s']::text[]
      and p.prosrc like '%auth.uid()%' and p.prosrc like '%auth.jwt()%'
      and not pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
      and not pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and not pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')) valid
    from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('public.fireafter_current_trusted_issuance_operator()')
  ), wrapper_controls as (
    select count(*) = 3 and bool_and(p.proowner = 'postgres'::regrole and p.prosecdef
      and p.proconfig in (array['search_path=""','lock_timeout=2s','statement_timeout=20s']::text[], array['search_path=""','statement_timeout=20s']::text[])
      and p.prosrc like '%fireafter_current_trusted_issuance_operator%'
      and pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and not pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
      and not pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')) valid
    from (values ('public.fireafter_begin_account_issuance_as_operator(uuid,text,uuid,text,text,uuid)'),
      ('public.fireafter_get_account_issuance_as_operator(uuid)'),
      ('public.fireafter_advance_account_issuance_as_operator(uuid,uuid,text)')) r(signature)
    join pg_catalog.pg_proc p on p.oid = pg_catalog.to_regprocedure(r.signature)
  ), legacy_controls as (
    select count(*) = 3 and bool_and(not pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')) valid
    from (values ('public.fireafter_get_account_issuance(uuid)'),
      ('public.fireafter_begin_account_issuance(uuid,text,uuid,text,text,text,uuid)'),
      ('public.fireafter_advance_account_issuance(uuid,uuid,text)')) r(signature)
    join pg_catalog.pg_proc p on p.oid = pg_catalog.to_regprocedure(r.signature)
  ), probe_controls as (
    select count(*) = 1 and bool_and(p.proowner = 'postgres'::regrole and not p.prosecdef
      and p.proconfig = array['search_path=""']::text[]
      and not pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
      and not pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')) valid
    from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('public.fireafter_operator_account_issuance_audit_security_version()')
  )
  select case when table_controls.valid and column_controls.valid and helper_controls.valid
    and wrapper_controls.valid and legacy_controls.valid and probe_controls.valid
    then '20260915120000'::text else null::text end
  from table_controls cross join column_controls cross join helper_controls cross join wrapper_controls
    cross join legacy_controls cross join probe_controls;
$$;
alter function public.fireafter_operator_account_issuance_audit_security_version() owner to postgres;
revoke all on function public.fireafter_operator_account_issuance_audit_security_version() from public, anon, authenticated, service_role;
grant execute on function public.fireafter_operator_account_issuance_audit_security_version() to service_role;

do $$ begin
  if public.fireafter_operator_account_issuance_audit_security_version() is distinct from '20260915120000' then
    raise exception 'Trusted operator issuance controls not verified; review allowlist, wrappers and effective grants before retrying';
  end if;
end $$;
