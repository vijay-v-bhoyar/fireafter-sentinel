set local lock_timeout = '2s';
set local statement_timeout = '60s';

-- Expand-only sidecar. No historical backfill: a validated publication is required.
create table public.asset_map_points (
  asset_id uuid primary key references public.assets(id) on delete cascade,
  incident_id uuid not null references public.incidents(id) on delete cascade,
  revision uuid not null,
  available boolean not null,
  longitude double precision,
  latitude double precision,
  name text not null,
  asset_type text not null,
  location point generated always as (point(longitude, latitude)) stored,
  check ((available and longitude between -180 and 180 and latitude between -90 and 90
    and longitude is not null and latitude is not null and length(name)<=512 and length(asset_type)<=64)
    or (not available and longitude is null and latitude is null))
);
create index asset_map_points_incident_idx on public.asset_map_points(incident_id,revision);
create index asset_map_points_location_idx on public.asset_map_points using gist(location) where available;
alter table public.asset_map_points enable row level security;
revoke all on public.asset_map_points from public,anon,authenticated;
grant select,insert,update,delete on public.asset_map_points to service_role;

create function public.fireafter_index_asset_point() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare m jsonb; c jsonb; v_available boolean;
begin
  -- An old writer or an unaccompanied row edit invalidates the projection.
  delete from public.asset_map_points where asset_id=new.id;
  m:=new.properties->'mapReadModel'; c:=new.properties->'coordinates';
  if m->>'version' is distinct from '2026-10-08-asset-view-v1' or jsonb_typeof(m->'available') is distinct from 'boolean'
    or coalesce(m->>'revision','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then return new; end if;
  if tg_op='UPDATE' and old.properties->'mapReadModel'=m and
    (to_jsonb(old)-'created_at') is distinct from (to_jsonb(new)-'created_at') then return new; end if;
  v_available:=(m->>'available')::boolean;
  if v_available then
    if jsonb_typeof(c) is distinct from 'array' then return new; end if;
    if jsonb_array_length(c)<>2 or jsonb_typeof(c->0) is distinct from 'number' or jsonb_typeof(c->1) is distinct from 'number'
      then return new; end if;
  end if;
  insert into public.asset_map_points(asset_id,incident_id,revision,available,longitude,latitude,name,asset_type)
    values (new.id,new.incident_id,(m->>'revision')::uuid,v_available,
      case when v_available then (c->>0)::double precision end,case when v_available then (c->>1)::double precision end,new.name,new.asset_type);
  return new;
end $$;
create trigger fireafter_asset_point_index after insert or update on public.assets
  for each row execute function public.fireafter_index_asset_point();
revoke all on function public.fireafter_index_asset_point() from public,anon,authenticated,service_role;

create function public.fireafter_read_asset_viewport(p_incident_id text,p_actor_id uuid,p_organization_id uuid,p_role text,
  p_revision uuid,p_bbox double precision[],p_zoom integer)
returns jsonb language plpgsql stable security invoker set search_path = '' set statement_timeout = '10s' as $$
declare
  v_incident public.incidents; v_ids uuid[]; v_asset_ids uuid[]; v_manifest jsonb; v_total integer; v_indexed integer;
  v_located integer; v_matched integer; v_items jsonb; v_revision uuid; v_map_ids uuid[]; v_clustered boolean;
begin
  if p_incident_id is null or length(p_incident_id) not between 1 and 256 or p_actor_id is null or p_organization_id is null
    or p_role is null or p_role not in ('incident_commander','analyst') or p_revision is null or p_zoom is null or p_zoom not between 0 and 20
    or p_bbox is null or array_ndims(p_bbox)<>1 or array_lower(p_bbox,1)<>1 or array_length(p_bbox,1)<>4
    or exists (select 1 from unnest(p_bbox) x where x is null or x in ('NaN'::float8,'Infinity'::float8,'-Infinity'::float8))
    or p_bbox[1]< -180 or p_bbox[3]>180 or p_bbox[2]< -90 or p_bbox[4]>90
    or p_bbox[3]-p_bbox[1]<0.000001 or p_bbox[4]-p_bbox[2]<0.000001 then
    raise exception 'Invalid map view' using errcode='MV400';
  end if;
  select array_agg(id) into v_ids from public.incidents where id::text=p_incident_id or selected_fire->>'domainIncidentId'=p_incident_id;
  if coalesce(array_length(v_ids,1),0)=0 then raise exception 'Missing incident' using errcode='MV404'; end if;
  if array_length(v_ids,1)<>1 then raise exception 'Ambiguous incident' using errcode='MV409'; end if;
  select * into v_incident from public.incidents where id=v_ids[1];
  if v_incident.organization_id<>p_organization_id or not exists (select 1 from public.organization_members
    where user_id=p_actor_id and organization_id=p_organization_id and role=p_role) then
    raise exception 'Map access denied' using errcode='MV403';
  end if;
  v_manifest:=v_incident.selected_fire->'inventoryManifest';
  if v_manifest->>'version' is distinct from '2026-09-13-inventory-v1'
    or v_manifest->>'revision' is distinct from p_revision::text
    or jsonb_typeof(v_manifest->'assetIds') is distinct from 'array'
    or v_incident.selected_fire->'mapReadContext'->>'version' is distinct from '2026-10-08-asset-view-v1'
    or (v_incident.selected_fire->'mapReadContext'->'locationContext') is distinct from coalesce(v_incident.location_context,'null'::jsonb) then
    raise exception 'Map publication changed or unavailable' using errcode='MV409';
  end if;
  v_revision:=p_revision; v_total:=jsonb_array_length(v_manifest->'assetIds');
  if v_total>100000 then raise exception 'Map capacity exceeded' using errcode='MV409'; end if;
  select coalesce(array_agg(id::uuid order by id::uuid),'{}'::uuid[]) into v_asset_ids from jsonb_array_elements_text(v_manifest->'assetIds') id;
  if (select count(distinct x) from unnest(v_asset_ids) x)<>v_total then raise exception 'Invalid membership' using errcode='MV409'; end if;
  -- Verify exact generation membership once, then spatial reads use only the
  -- indexed incident/revision. Avoid a large parameter-array predicate per row.
  select count(*),count(*) filter(where available),coalesce(array_agg(asset_id order by asset_id),'{}'::uuid[])
    into v_indexed,v_located,v_map_ids from public.asset_map_points
    where incident_id=v_incident.id and revision=v_revision;
  if v_indexed<>v_total or v_map_ids is distinct from v_asset_ids then raise exception 'Incomplete map index' using errcode='MV409'; end if;
  select count(*) into v_matched from public.asset_map_points
    where incident_id=v_incident.id and revision=v_revision and available
      and location <@ box(point(p_bbox[1],p_bbox[2]),point(p_bbox[3],p_bbox[4]))
      and longitude between p_bbox[1] and p_bbox[3] and latitude between p_bbox[2] and p_bbox[4];
  -- A small screen-space grid keeps count markers distinct on a phone. A cell
  -- containing exactly one record retains its exact coordinate; dense cells
  -- remain grouped even when fewer than 200 total records are in view.
  select coalesce(jsonb_agg(case when n=1 then jsonb_build_object('kind','point','id',id,'name',name,'type',asset_type,
      'coordinates',jsonb_build_array(lon,lat)) else jsonb_build_object('kind','cluster','id','c'||x||'-'||y,'count',n,
      'coordinates',jsonb_build_array(p_bbox[1]+(x+0.5)/4*(p_bbox[3]-p_bbox[1]),p_bbox[2]+(y+0.5)/4*(p_bbox[4]-p_bbox[2]))) end order by x,y),'[]'::jsonb),
    coalesce(bool_or(n>1),false) into v_items,v_clustered
  from (select least(3,floor((longitude-p_bbox[1])/(p_bbox[3]-p_bbox[1])*4))::integer x,
    least(3,floor((latitude-p_bbox[2])/(p_bbox[4]-p_bbox[2])*4))::integer y,count(*) n,avg(longitude) lon,avg(latitude) lat,
    min(asset_id::text) id,min(name) name,min(asset_type) asset_type
    from public.asset_map_points where incident_id=v_incident.id and revision=v_revision and available
      and location <@ box(point(p_bbox[1],p_bbox[2]),point(p_bbox[3],p_bbox[4]))
      and longitude between p_bbox[1] and p_bbox[3] and latitude between p_bbox[2] and p_bbox[4] group by x,y) groups;
  return jsonb_build_object('version','2026-10-08-asset-view-v1','incidentId',p_incident_id,'revision',v_revision,'bbox',p_bbox,'zoom',p_zoom,
    'totalStored',v_total,'totalLocated',v_located,'withheld',v_total-v_located,'inView',v_matched,'mode',case when v_clustered then 'clusters' else 'points' end,'items',v_items);
end $$;
revoke all on function public.fireafter_read_asset_viewport(text,uuid,uuid,text,uuid,double precision[],integer) from public,anon,authenticated,service_role;
grant execute on function public.fireafter_read_asset_viewport(text,uuid,uuid,text,uuid,double precision[],integer) to service_role;
notify pgrst,'reload schema';
