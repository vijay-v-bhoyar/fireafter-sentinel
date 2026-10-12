set local lock_timeout = '2s';
set local statement_timeout = '60s';

-- Read-only, service-only export context. No table, row, trigger or RLS changes.
create function public.fireafter_export_read_fence(p_incident_id text,p_actor_id uuid,p_organization_id uuid,p_role text,p_expected text,p_include_row boolean)
returns jsonb language plpgsql stable security invoker set search_path = '' set statement_timeout = '15s' set timezone = 'UTC' as $$
declare
  v_id uuid; v_ids uuid[]; v_row jsonb; v_fingerprint text;
begin
  if p_incident_id is null or length(p_incident_id)<1 or length(p_incident_id)>256 or p_actor_id is null
    or p_organization_id is null or p_role is null or p_role not in ('incident_commander','analyst') or p_include_row is null
    or (p_expected is not null and p_expected !~ '^[0-9a-f]{64}$') then
    raise exception 'Invalid export context' using errcode='FB400';
  end if;
  if p_incident_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then v_id:=p_incident_id::uuid; end if;
  select array_agg(i.id) into v_ids from public.incidents i
    where i.id=v_id or i.selected_fire->>'domainIncidentId'=p_incident_id;
  if coalesce(array_length(v_ids,1),0)=0 then raise exception 'Missing incident' using errcode='FB404'; end if;
  if array_length(v_ids,1)<>1 then raise exception 'Ambiguous incident' using errcode='FB409'; end if;
  select to_jsonb(i) into v_row from public.incidents i where i.id=v_ids[1];
  if v_row->>'organization_id' is distinct from p_organization_id::text or not exists
    (select 1 from public.organization_members m where m.user_id=p_actor_id and m.organization_id=p_organization_id and m.role=p_role) then
    raise exception 'Export access denied' using errcode='FB403';
  end if;
  if octet_length(v_row::text)>16777216 then raise exception 'Export context capacity exceeded' using errcode='FB413'; end if;
  v_fingerprint:=encode(sha256(convert_to(v_row::text,'UTF8')),'hex');
  if p_expected is not null and p_expected<>v_fingerprint then raise exception 'Export context changed' using errcode='FB409'; end if;
  return jsonb_build_object('version','20261008210000','incidentId',v_ids[1],'fingerprint',v_fingerprint,
    'row',case when p_include_row then v_row else null end);
end
$$;

create function public.fireafter_export_read_security_version()
returns text language sql stable security invoker set search_path = '' as $$
  select case when (p.prokind='f' and not p.prosecdef and not p.proretset and not p.proisstrict
    and not p.proleakproof and p.provolatile='s' and p.proparallel='u' and p.prorettype='jsonb'::regtype
    and p.pronargdefaults=0 and p.prosupport=0 and p.provariadic=0 and p.proallargtypes is null and p.proargmodes is null
    and p.prolang=(select oid from pg_language where lanname='plpgsql')
    and p.proconfig=array['search_path=""','statement_timeout=15s','TimeZone=UTC']::text[]
    and pg_get_userbyid(p.proowner)='postgres'
    and not has_function_privilege('anon',p.oid,'EXECUTE') and not has_function_privilege('authenticated',p.oid,'EXECUTE')
    and has_function_privilege('service_role',p.oid,'EXECUTE')
    and encode(sha256(convert_to(btrim(replace(p.prosrc,E'\r\n',E'\n'),E' \t\r\n'),'UTF8')),'hex')='01c8a11b5275806adcf441364ccff802119fa5a1502f496e60d812874f074af6') is true
    then '20261008210000' else null end
  from pg_proc p where p.oid=to_regprocedure('public.fireafter_export_read_fence(text,uuid,uuid,text,text,boolean)');
$$;

revoke all on function public.fireafter_export_read_fence(text,uuid,uuid,text,text,boolean),
  public.fireafter_export_read_security_version() from public,anon,authenticated,service_role;
grant execute on function public.fireafter_export_read_fence(text,uuid,uuid,text,text,boolean),
  public.fireafter_export_read_security_version() to service_role;
notify pgrst,'reload schema';
