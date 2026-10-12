set local lock_timeout = '2s';
set local statement_timeout = '60s';

-- Additive, service-only read transport. No operational rows are changed.
create function public.fireafter_read_refresh_recommendations(p_incident_id uuid,p_organization_id uuid,p_after uuid,p_limit integer)
returns jsonb language plpgsql stable security invoker set search_path = '' set statement_timeout = '15s' as $$
declare
  v_org uuid; v_remaining bigint; v_rows jsonb; v_shared jsonb := '{}';
  v_page jsonb; v_names text[]; v_name text;
begin
  if p_incident_id is null or p_organization_id is null or p_limit is null or p_limit<1 or p_limit>500 then
    raise exception 'Invalid read scope' using errcode='FB400';
  end if;
  select organization_id into v_org from public.incidents where id=p_incident_id;
  if not found then raise exception 'Missing incident' using errcode='FB404'; end if;
  if v_org<>p_organization_id then raise exception 'Organization mismatch' using errcode='FB401'; end if;
  select count(*) into v_remaining from public.recommendations
    where incident_id=p_incident_id and (p_after is null or id>p_after);
  if v_remaining>100000 then raise exception 'Read capacity exceeded' using errcode='FB413'; end if;
  select coalesce(jsonb_agg(item order by id),'[]') into v_rows from (
    select r.id,to_jsonb(r)||jsonb_build_object('asset',case when a.id is null then null else jsonb_build_object(
      'id',a.id,'incident_id',a.incident_id,'name',a.name,'asset_type',a.asset_type,'location_label',a.location_label,
      'local_or_uploaded',a.local_or_uploaded,'origin',a.origin,'source_key',a.source_key,
      'coordinates',a.properties->'coordinates','domainAssetId',a.properties->>'domainAssetId',
      'propertySourceKey',a.properties->>'sourceKey') end) as item
    from (select * from public.recommendations where incident_id=p_incident_id and (p_after is null or id>p_after)
      order by id limit p_limit) r left join public.assets a on a.id=r.asset_id
  ) page;
  if octet_length(v_rows::text)>8388608 then raise exception 'Read page capacity exceeded' using errcode='FB413'; end if;
  v_page:=v_rows;
  if jsonb_array_length(v_rows)>1 then
    for v_name in select jsonb_object_keys(v_rows->0) loop
      if v_name not in ('id','incident_id','asset_id') and not exists
        (select 1 from jsonb_array_elements(v_rows) r where not r ? v_name or r->v_name is distinct from v_rows->0->v_name)
      then v_shared:=v_shared||jsonb_build_object(v_name,v_rows->0->v_name); end if;
    end loop;
    if v_shared<>'{}' and octet_length(v_shared::text)<=1048576 then
      select array_agg(k) into v_names from jsonb_object_keys(v_shared) k;
      select jsonb_build_object('format','shared-row-fields-v1','shared',v_shared,'rows',jsonb_agg(r-v_names order by n))
        into v_page from jsonb_array_elements(v_rows) with ordinality x(r,n);
      if octet_length(v_page::text)>=octet_length(v_rows::text) then v_page:=v_rows; end if;
    end if;
  end if;
  return jsonb_build_object('format','shared-refresh-rows-v1','incidentId',p_incident_id,'remaining',v_remaining,'page',v_page);
end
$$;

create function public.fireafter_refresh_read_security_version()
returns text language sql stable security invoker set search_path = '' as $$
  select case when (p.prokind='f' and not p.prosecdef and not p.proretset and not p.proisstrict
    and not p.proleakproof and p.provolatile='s' and p.proparallel='u' and p.prorettype='jsonb'::regtype
    and p.pronargdefaults=0 and p.prosupport=0 and p.provariadic=0 and p.proallargtypes is null and p.proargmodes is null
    and p.prolang=(select oid from pg_language where lanname='plpgsql')
    and p.proconfig=array['search_path=""','statement_timeout=15s']::text[]
    and pg_get_userbyid(p.proowner)='postgres'
    and not has_function_privilege('anon',p.oid,'EXECUTE') and not has_function_privilege('authenticated',p.oid,'EXECUTE')
    and has_function_privilege('service_role',p.oid,'EXECUTE')
    and encode(sha256(convert_to(btrim(replace(p.prosrc,E'\r\n',E'\n'),E' \t\r\n'),'UTF8')),'hex')='43926ef1f7df33f3acc42f55fff569feb968a81a86a0cb23f6d94eb161b30257') is true
    then '20261008190000' else null end
  from pg_proc p where p.oid=to_regprocedure('public.fireafter_read_refresh_recommendations(uuid,uuid,uuid,integer)');
$$;

revoke all on function public.fireafter_read_refresh_recommendations(uuid,uuid,uuid,integer),
  public.fireafter_refresh_read_security_version() from public,anon,authenticated,service_role;
grant execute on function public.fireafter_read_refresh_recommendations(uuid,uuid,uuid,integer),
  public.fireafter_refresh_read_security_version() to service_role;
notify pgrst,'reload schema';
