set local lock_timeout = '2s';
set local statement_timeout = '60s';

create or replace function public.fireafter_claim_scheduled_refreshes(
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

  insert into public.scheduled_refresh_leases (incident_id)
  select i.id from public.incidents i
  on conflict on constraint scheduled_refresh_leases_pkey do nothing;

  update public.scheduled_refresh_leases as lease
  set attempt_id = null, worker_id = null, lease_until = null,
      last_outcome = 'expired', updated_at = v_now
  where lease.attempt_id is not null and lease.lease_until <= v_now;

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
        and p.prosrc like '%on conflict on constraint scheduled_refresh_leases_pkey do nothing%'
        and p.prosrc like '%where lease.attempt_id is not null and lease.lease_until <= v_now%'
        and not pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
        and not pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
        and pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE'))
    and (select count(*) = 1 from pg_catalog.pg_proc p
      where p.oid = pg_catalog.to_regprocedure('public.fireafter_settle_scheduled_refresh(uuid,uuid,text,boolean)')
        and p.prosecdef and p.prorettype = 'void'::regtype
        and not pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
        and not pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
        and pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE'))
    then '20261002000000'::text else null::text end;
$$;
alter function public.fireafter_scheduled_refresh_security_version() owner to postgres;
revoke all on function public.fireafter_scheduled_refresh_security_version() from public, anon, authenticated, service_role;
grant execute on function public.fireafter_scheduled_refresh_security_version() to service_role;

do $$
begin
  if public.fireafter_scheduled_refresh_security_version() is distinct from '20261002000000' then
    raise exception 'Scheduled refresh claim-fix migration postcondition failed';
  end if;
end;
$$;
