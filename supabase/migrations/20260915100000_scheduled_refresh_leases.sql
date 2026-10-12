set local lock_timeout = '2s';
set local statement_timeout = '60s';

-- Candidate only: apply after the populated disposable rehearsal in the
-- matching migration plan. This state is separate from incidents.last_refresh:
-- failed attempts must not make a stale incident appear fresh.
create table if not exists public.scheduled_refresh_leases (
  incident_id uuid primary key references public.incidents(id) on delete cascade,
  attempt_id uuid unique,
  worker_id text,
  lease_until timestamptz,
  last_attempt_at timestamptz,
  next_attempt_at timestamptz,
  last_succeeded_at timestamptz,
  failure_count integer not null default 0 check (failure_count between 0 and 31),
  last_outcome text not null default 'never' check (last_outcome in ('never', 'succeeded', 'failed', 'expired')),
  updated_at timestamptz not null default clock_timestamp(),
  check ((attempt_id is null and worker_id is null and lease_until is null)
    or (attempt_id is not null and worker_id is not null and lease_until is not null))
);

alter table public.scheduled_refresh_leases owner to postgres;
alter table public.scheduled_refresh_leases enable row level security;
revoke all on table public.scheduled_refresh_leases from public, anon, authenticated, service_role;
create index if not exists scheduled_refresh_leases_due_idx
  on public.scheduled_refresh_leases (next_attempt_at, last_attempt_at, incident_id);

create or replace function public.fireafter_seed_scheduled_refresh_lease()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.scheduled_refresh_leases (incident_id)
  values (new.id)
  on conflict (incident_id) do nothing;
  return new;
end;
$$;
alter function public.fireafter_seed_scheduled_refresh_lease() owner to postgres;
revoke all on function public.fireafter_seed_scheduled_refresh_lease() from public, anon, authenticated, service_role;
drop trigger if exists incidents_seed_scheduled_refresh_lease on public.incidents;
create trigger incidents_seed_scheduled_refresh_lease
after insert on public.incidents
for each row execute function public.fireafter_seed_scheduled_refresh_lease();
alter table public.incidents enable always trigger incidents_seed_scheduled_refresh_lease;

create function public.fireafter_claim_scheduled_refreshes(
  p_limit integer,
  p_worker_id text,
  p_lease_seconds integer
)
returns table (incident_id uuid, domain_incident_id text, attempt_id uuid)
language plpgsql
volatile
security definer
called on null input
parallel unsafe
set search_path = ''
set lock_timeout = '2s'
set statement_timeout = '15s'
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_limit is null or p_limit < 1 or p_limit > 20
    or p_worker_id is null or p_worker_id !~ '^[A-Za-z0-9._:-]{1,128}$'
    or p_lease_seconds is null or p_lease_seconds < 60 or p_lease_seconds > 900 then
    raise exception 'Scheduled refresh claim fields are invalid' using errcode = 'FR400';
  end if;

  -- Backfill state for incidents created before this migration without making
  -- the incident write path depend on a repair script or an in-memory cache.
  insert into public.scheduled_refresh_leases (incident_id)
  select i.id from public.incidents i
  on conflict (incident_id) do nothing;

  update public.scheduled_refresh_leases
  set attempt_id = null, worker_id = null, lease_until = null,
      last_outcome = 'expired', updated_at = v_now
  where attempt_id is not null and lease_until <= v_now;

  return query
  with candidates as (
    select s.incident_id
    from public.scheduled_refresh_leases s
    join public.incidents i on i.id = s.incident_id
    where s.attempt_id is null
      and (s.next_attempt_at is null or s.next_attempt_at <= v_now)
      and lower(i.id::text) <> 'incident-custom-custom-hartford'
      and lower(coalesce(i.selected_fire->>'domainIncidentId', '')) <> 'incident-custom-custom-hartford'
      and lower(pg_catalog.to_jsonb(i)::text) not like '%live db test%'
      and lower(pg_catalog.to_jsonb(i)::text) not like '%supabase connectivity smoke test%'
      and lower(pg_catalog.to_jsonb(i)::text) not like '%fireafter api smoke%'
      and lower(pg_catalog.to_jsonb(i)::text) not like '%fireafter browser smoke%'
      and lower(pg_catalog.to_jsonb(i)::text) not like '%heuristic burn-scar scoring is active%'
      and lower(pg_catalog.to_jsonb(i)::text) not similar to '%"(fireafternonoperational|fireafter_non_operational|nonoperational|non_operational)"[[:space:]]*:[[:space:]]*true%'
    order by s.next_attempt_at nulls first, s.last_attempt_at nulls first,
      i.last_refresh nulls first, s.incident_id
    for update of s skip locked
    limit p_limit
  ), claimed as (
    update public.scheduled_refresh_leases s
    set attempt_id = pg_catalog.gen_random_uuid(), worker_id = p_worker_id,
        lease_until = v_now + pg_catalog.make_interval(secs => p_lease_seconds),
        last_attempt_at = v_now, updated_at = v_now
    from candidates c
    where s.incident_id = c.incident_id
    returning s.incident_id, s.attempt_id
  )
  select c.incident_id,
    coalesce(nullif(i.selected_fire->>'domainIncidentId', ''), c.incident_id::text),
    c.attempt_id
  from claimed c
  join public.incidents i on i.id = c.incident_id
  order by c.incident_id;
end;
$$;
alter function public.fireafter_claim_scheduled_refreshes(integer,text,integer) owner to postgres;
revoke all on function public.fireafter_claim_scheduled_refreshes(integer,text,integer) from public, anon, authenticated, service_role;
grant execute on function public.fireafter_claim_scheduled_refreshes(integer,text,integer) to service_role;

create function public.fireafter_settle_scheduled_refresh(
  p_incident_id uuid,
  p_attempt_id uuid,
  p_worker_id text,
  p_succeeded boolean
)
returns void
language plpgsql
volatile
security definer
called on null input
parallel unsafe
set search_path = ''
set lock_timeout = '2s'
set statement_timeout = '15s'
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_updated integer;
begin
  if p_incident_id is null or p_attempt_id is null
    or p_worker_id is null or p_worker_id !~ '^[A-Za-z0-9._:-]{1,128}$'
    or p_succeeded is null then
    raise exception 'Scheduled refresh settlement fields are invalid' using errcode = 'FR400';
  end if;

  if p_succeeded then
    update public.scheduled_refresh_leases
    set attempt_id = null, worker_id = null, lease_until = null,
        next_attempt_at = null, last_succeeded_at = v_now,
        failure_count = 0, last_outcome = 'succeeded', updated_at = v_now
    where incident_id = p_incident_id and attempt_id = p_attempt_id
      and worker_id = p_worker_id and lease_until > v_now;
  else
    update public.scheduled_refresh_leases
    set attempt_id = null, worker_id = null, lease_until = null,
        next_attempt_at = v_now + pg_catalog.make_interval(secs =>
          least(86400, (30 * pg_catalog.power(2::numeric, least(failure_count, 10)))::integer)),
        failure_count = least(31, failure_count + 1), last_outcome = 'failed',
        updated_at = v_now
    where incident_id = p_incident_id and attempt_id = p_attempt_id
      and worker_id = p_worker_id and lease_until > v_now;
  end if;
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    raise exception 'Scheduled refresh lease is no longer owned' using errcode = 'FR409';
  end if;
end;
$$;
alter function public.fireafter_settle_scheduled_refresh(uuid,uuid,text,boolean) owner to postgres;
revoke all on function public.fireafter_settle_scheduled_refresh(uuid,uuid,text,boolean) from public, anon, authenticated, service_role;
grant execute on function public.fireafter_settle_scheduled_refresh(uuid,uuid,text,boolean) to service_role;

create or replace function public.fireafter_scheduled_refresh_security_version()
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select case when
    exists (select 1 from pg_catalog.pg_class c
      where c.oid = pg_catalog.to_regclass('public.scheduled_refresh_leases')
        and c.relkind = 'r' and c.relrowsecurity
        and pg_catalog.pg_get_userbyid(c.relowner) = 'postgres'
        and not pg_catalog.has_table_privilege('anon', c.oid, 'SELECT')
        and not pg_catalog.has_table_privilege('authenticated', c.oid, 'SELECT')
        and not pg_catalog.has_table_privilege('service_role', c.oid, 'SELECT'))
    and (select count(*) = 1 from pg_catalog.pg_proc p
      where p.oid = pg_catalog.to_regprocedure('public.fireafter_claim_scheduled_refreshes(integer,text,integer)')
        and p.prosecdef and p.prorettype = 'record'::regtype
        and not pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
        and not pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
        and pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE'))
    and (select count(*) = 1 from pg_catalog.pg_proc p
      where p.oid = pg_catalog.to_regprocedure('public.fireafter_settle_scheduled_refresh(uuid,uuid,text,boolean)')
        and p.prosecdef and p.prorettype = 'void'::regtype
        and not pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
        and not pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
        and pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE'))
    then '20260915100000'::text else null::text end;
$$;
alter function public.fireafter_scheduled_refresh_security_version() owner to postgres;
revoke all on function public.fireafter_scheduled_refresh_security_version() from public, anon, authenticated, service_role;
grant execute on function public.fireafter_scheduled_refresh_security_version() to service_role;

do $$
begin
  if public.fireafter_scheduled_refresh_security_version() is distinct from '20260915100000' then
    raise exception 'Scheduled refresh lease controls are not verified; reconcile table, routines and effective grants';
  end if;
end;
$$;
