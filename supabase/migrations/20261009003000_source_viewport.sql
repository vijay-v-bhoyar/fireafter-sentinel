set local lock_timeout = '2s';
set local statement_timeout = '60s';

-- Derived read copies, not a historical backfill or replacement of source evidence.
create table public.source_map_layers (
  source_id uuid primary key references public.source_snapshots(id) on delete cascade,
  incident_id uuid not null references public.incidents(id) on delete cascade,
  revision uuid not null,
  source_key text,
  model jsonb not null check (octet_length(model::text)<=524288),
  storage jsonb check (octet_length(storage::text)<=2097152)
);
create index source_map_layers_incident_idx on public.source_map_layers(incident_id,revision);
create table public.source_map_chunks (
  source_id uuid not null references public.source_map_layers(source_id) on delete cascade,
  position integer not null check(position between 0 and 4095),
  record_count integer not null check(record_count between 1 and 64),
  west float8 not null, south float8 not null, east float8 not null, north float8 not null,
  expanded_bytes integer not null check(expanded_bytes between 2 and 4194304),
  hash text not null check(hash ~ '^[a-f0-9]{64}$'),
  gzip text not null check(octet_length(gzip)<=8388608),
  wire_bytes integer generated always as (octet_length(gzip)+512) stored,
  extent box generated always as (box(point(west,south),point(east,north))) stored,
  primary key(source_id,position),
  check(west>= -180 and east<=180 and south>= -90 and north<=90 and west<=east and south<=north)
);
create index source_map_chunks_extent_idx on public.source_map_chunks using gist(extent);
alter table public.source_map_layers enable row level security;
alter table public.source_map_chunks enable row level security;
revoke all on public.source_map_layers,public.source_map_chunks from public,anon,authenticated;
grant select,insert,update,delete on public.source_map_layers,public.source_map_chunks to service_role;

create function public.fireafter_index_source_chunks() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare m jsonb; s jsonb; c jsonb; headers jsonb; storage jsonb;
begin
  delete from public.source_map_layers where source_id=new.id;
  m:=new.raw_payload->'sourceMapReadModel';
  if m->>'version' is distinct from '2026-10-09-source-view-v1'
    or coalesce(m->>'revision','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or m->'projection'->>'id' is distinct from new.id::text
    or m->'projection'->>'incident_id' is distinct from new.incident_id::text then return new; end if;
  if tg_op='UPDATE' and old.raw_payload->'sourceMapReadModel'=m and
    (to_jsonb(old)-'created_at') is distinct from (to_jsonb(new)-'created_at') then return new; end if;
  if new.raw_payload->>'rawPayloadEncoding'='gzip-spatial-json-v1' then
    s:=new.raw_payload->'rawPayloadSpatial';
    if jsonb_typeof(s->'chunks') is distinct from 'array' then raise exception 'Invalid source chunk index' using errcode='MV409'; end if;
    if jsonb_array_length(s->'chunks')>4096 then raise exception 'Source chunk capacity' using errcode='MV409'; end if;
    select coalesce(jsonb_agg(value-'gzip' order by ord),'[]') into headers from jsonb_array_elements(s->'chunks') with ordinality t(value,ord);
    storage:=jsonb_build_object('rawPayloadEncoding',new.raw_payload->'rawPayloadEncoding','rawPayloadBytes',new.raw_payload->'rawPayloadBytes',
      'rawPayloadHash',new.raw_payload->'rawPayloadHash','rawPayloadSpatial',jsonb_set(s,'{chunks}',headers));
  end if;
  insert into public.source_map_layers values(new.id,new.incident_id,(m->>'revision')::uuid,new.source_key,m,storage);
  if storage is not null then
    for c in select value from jsonb_array_elements(s->'chunks') loop
      insert into public.source_map_chunks(source_id,position,record_count,west,south,east,north,expanded_bytes,hash,gzip)
        values(new.id,(c->>'position')::integer,(c->>'count')::integer,(c->'bounds'->>0)::float8,(c->'bounds'->>1)::float8,
          (c->'bounds'->>2)::float8,(c->'bounds'->>3)::float8,(c->>'bytes')::integer,c->>'hash',c->>'gzip');
    end loop;
  end if;
  return new;
end $$;
create trigger fireafter_source_chunk_index after insert or update on public.source_snapshots
  for each row execute function public.fireafter_index_source_chunks();
revoke all on function public.fireafter_index_source_chunks() from public,anon,authenticated,service_role;

create function public.fireafter_read_source_viewport(p_incident_id text,p_actor_id uuid,p_organization_id uuid,p_role text,
  p_revision uuid,p_bbox float8[],p_zoom integer,p_layer text)
returns jsonb language plpgsql stable security invoker set search_path = '' set statement_timeout = '10s' as $$
declare
  incident public.incidents; manifest jsonb; incident_ids uuid[]; expected_ids uuid[]; indexed_ids uuid[];
  layer public.source_map_layers; layer_ids uuid[]; headers jsonb; chunks jsonb; result jsonb;
  matched integer; records integer; expanded bigint; wire bigint; mode text;
begin
  if p_incident_id is null or length(p_incident_id) not between 1 and 256 or p_actor_id is null or p_organization_id is null
    or p_role is null or p_role not in ('incident_commander','analyst') or p_revision is null or p_zoom is null or p_zoom not between 0 and 20
    or p_layer is null or p_layer not in ('tiger-roads','3dhp-flowlines','usgs-pwfdf')
    or p_bbox is null or array_ndims(p_bbox)<>1 or array_lower(p_bbox,1)<>1 or array_length(p_bbox,1)<>4
    or exists(select 1 from unnest(p_bbox) x where x is null or x in ('NaN'::float8,'Infinity'::float8,'-Infinity'::float8))
    or p_bbox[1]< -180 or p_bbox[3]>180 or p_bbox[2]< -90 or p_bbox[4]>90
    or p_bbox[3]-p_bbox[1]<0.000001 or p_bbox[4]-p_bbox[2]<0.000001 then
    raise exception 'Invalid source view' using errcode='MV400';
  end if;
  select array_agg(id) into incident_ids from public.incidents where id::text=p_incident_id or selected_fire->>'domainIncidentId'=p_incident_id;
  if coalesce(array_length(incident_ids,1),0)=0 then raise exception 'Missing incident' using errcode='MV404'; end if;
  if array_length(incident_ids,1)<>1 then raise exception 'Ambiguous incident' using errcode='MV409'; end if;
  select * into incident from public.incidents where id=incident_ids[1];
  if incident.organization_id<>p_organization_id or not exists(select 1 from public.organization_members
    where user_id=p_actor_id and organization_id=p_organization_id and role=p_role) then
    raise exception 'Source view access denied' using errcode='MV403';
  end if;
  manifest:=incident.selected_fire->'inventoryManifest';
  if manifest->>'version' is distinct from '2026-09-13-inventory-v1' or manifest->>'revision' is distinct from p_revision::text
    or jsonb_typeof(manifest->'sourceSnapshotIds') is distinct from 'array'
    or incident.selected_fire->'mapReadContext'->>'version' is distinct from '2026-10-08-asset-view-v1'
    or (incident.selected_fire->'mapReadContext'->'locationContext') is distinct from coalesce(incident.location_context,'null'::jsonb) then
    raise exception 'Source publication changed or unavailable' using errcode='MV409';
  end if;
  if jsonb_array_length(manifest->'sourceSnapshotIds')>128 then raise exception 'Source count capacity' using errcode='MV409'; end if;
  select coalesce(array_agg(id::uuid order by id::uuid),'{}'::uuid[]) into expected_ids from jsonb_array_elements_text(manifest->'sourceSnapshotIds') id;
  if (select count(distinct x) from unnest(expected_ids) x)<>cardinality(expected_ids) then raise exception 'Invalid source membership' using errcode='MV409'; end if;
  select coalesce(array_agg(source_id order by source_id),'{}'::uuid[]) into indexed_ids from public.source_map_layers where incident_id=incident.id and revision=p_revision;
  if expected_ids is distinct from indexed_ids then raise exception 'Incomplete source index' using errcode='MV409'; end if;
  select array_agg(source_id) into layer_ids from public.source_map_layers where incident_id=incident.id and revision=p_revision and source_key=p_layer;
  if coalesce(cardinality(layer_ids),0)>1 then raise exception 'Ambiguous source layer' using errcode='MV409'; end if;
  select * into layer from public.source_map_layers where source_id=layer_ids[1];
  mode:='unavailable'; matched:=0; records:=0; expanded:=0; wire:=0; chunks:='[]';
  if layer.storage is not null then
    -- Compare all compact headers before the spatial query, without reading gzip data.
    select coalesce(jsonb_agg(jsonb_build_object('position',position,'count',record_count,'bounds',jsonb_build_array(west,south,east,north),
      'bytes',expanded_bytes,'hash',hash) order by position),'[]') into headers from public.source_map_chunks where source_id=layer.source_id;
    if headers is distinct from layer.storage->'rawPayloadSpatial'->'chunks' then raise exception 'Incomplete source chunks' using errcode='MV409'; end if;
    select count(*),coalesce(sum(record_count),0),coalesce(sum(expanded_bytes),0),coalesce(sum(wire_bytes),0)
      into matched,records,expanded,wire from public.source_map_chunks where source_id=layer.source_id
      and extent && box(point(p_bbox[1],p_bbox[2]),point(p_bbox[3],p_bbox[4]))
      and west<=p_bbox[3] and east>=p_bbox[1] and south<=p_bbox[4] and north>=p_bbox[2];
    mode:=case when expanded>8388608 or wire>2097152 or records>4096 then 'zoom_required' else 'ready' end;
    if mode='ready' then
      select coalesce(jsonb_agg(jsonb_build_object('position',position,'count',record_count,'bounds',jsonb_build_array(west,south,east,north),
        'bytes',expanded_bytes,'hash',hash,'gzip',gzip) order by position),'[]') into chunks from public.source_map_chunks where source_id=layer.source_id
        and extent && box(point(p_bbox[1],p_bbox[2]),point(p_bbox[3],p_bbox[4]))
        and west<=p_bbox[3] and east>=p_bbox[1] and south<=p_bbox[4] and north>=p_bbox[2];
    end if;
  end if;
  result:=jsonb_build_object('version','2026-10-09-source-view-v1','incidentId',p_incident_id,'revision',p_revision,'bbox',p_bbox,'zoom',p_zoom,'layer',p_layer,
    'sourceRowId',layer.source_id,'incidentRowId',incident.id,'model',layer.model,'storage',layer.storage,'mode',mode,
    'candidateChunks',matched,'candidateRecords',records,'compressedBytes',wire,'chunks',chunks);
  if octet_length(result::text)>6291456 then raise exception 'Source view response capacity' using errcode='MV409'; end if;
  return result;
end $$;
revoke all on function public.fireafter_read_source_viewport(text,uuid,uuid,text,uuid,float8[],integer,text) from public,anon,authenticated,service_role;
grant execute on function public.fireafter_read_source_viewport(text,uuid,uuid,text,uuid,float8[],integer,text) to service_role;
notify pgrst,'reload schema';
