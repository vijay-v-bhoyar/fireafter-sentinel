set local lock_timeout = '2s';
set local statement_timeout = '60s';

-- Trigger functions are not callable successfully outside a trigger context, but
-- they still need a fixed path so their execution context cannot inherit a role path.
alter function public.fireafter_prevent_append_only_mutation() set search_path = '';

create or replace function public.fireafter_append_only_trigger_security_version()
returns text language sql stable security invoker set search_path = ''
as $$
  select case when p.prokind = 'f' and not p.prosecdef and not p.proretset
    and p.provolatile = 'v' and p.proparallel = 'u'
    and p.prorettype = 'trigger'::pg_catalog.regtype
    and p.proconfig = array['search_path=""']::text[]
    and pg_catalog.pg_get_userbyid(p.proowner) = 'postgres'
    and pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.btrim(pg_catalog.replace(p.prosrc, E'\r\n', E'\n'), E' \t\r\n'), 'UTF8')), 'hex')
      = 'd68b9d2d780419bbf87c6ff655e363e873d0f72c3c3cf5963bc4f36735828143'
    then '20260918130000'::text else null::text end
  from pg_catalog.pg_proc p
  where p.oid = pg_catalog.to_regprocedure('public.fireafter_prevent_append_only_mutation()');
$$;
alter function public.fireafter_append_only_trigger_security_version() owner to postgres;
revoke all on function public.fireafter_append_only_trigger_security_version() from public, anon, authenticated, service_role;
grant execute on function public.fireafter_append_only_trigger_security_version() to service_role;

do $$ begin
  if public.fireafter_append_only_trigger_security_version() is distinct from '20260918130000' then
    raise exception 'Append-only trigger helper hardening failed; reconcile owner, path, and reviewed body before retrying';
  end if;
end $$;
