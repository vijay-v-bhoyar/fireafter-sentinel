set local lock_timeout = '2s';
set local statement_timeout = '60s';

-- Private staging only. No operational row changes until the final transaction.
create table public.ingestion_staged_bundles (
  job_id uuid primary key references public.ingestion_jobs(id) on delete cascade,
  header jsonb not null check (jsonb_typeof(header)='object' and octet_length(header::text)<=16777216),
  counts jsonb not null default '{"asset":0,"recommendation":0,"source":0}',
  stored_bytes bigint not null default 0 check (stored_bytes between 0 and 536870912)
);
create table public.ingestion_staged_rows (
  job_id uuid not null references public.ingestion_staged_bundles(job_id) on delete cascade,
  kind text not null check (kind in ('asset','recommendation','source')),
  row_id uuid not null,
  payload jsonb,
  primary key(job_id,kind,row_id)
);
create table public.ingestion_staged_pages (
  job_id uuid not null references public.ingestion_staged_bundles(job_id) on delete cascade,
  kind text not null check (kind in ('asset','recommendation','source')),
  position integer not null check (position between 0 and 99999),
  digest text not null check (digest ~ '^[a-f0-9]{64}$'),
  primary key(job_id,kind,position)
);
alter table public.ingestion_staged_bundles enable row level security;
alter table public.ingestion_staged_rows enable row level security;
alter table public.ingestion_staged_pages enable row level security;
revoke all on public.ingestion_staged_bundles,public.ingestion_staged_rows,public.ingestion_staged_pages from public,anon,authenticated,service_role;

create function public.fireafter_staged_job(p_id uuid, p_lease uuid)
returns public.ingestion_jobs language plpgsql security definer set search_path = '' as $$
declare j public.ingestion_jobs%rowtype;
begin
  select * into j from public.ingestion_jobs where id=p_id for update;
  if not found then raise exception 'Unknown job' using errcode='FB404'; end if;
  perform 1 from public.organization_members where user_id=j.actor_id and organization_id=j.organization_id
    and role in ('analyst','incident_commander') for share;
  if not found then raise exception 'Membership revoked' using errcode='FB401'; end if;
  if p_lease is null or j.lease_id is distinct from p_lease or j.lease_until is null or j.lease_until<=clock_timestamp() or j.status<>'running' then
    raise exception 'Lease lost' using errcode='FB409';
  end if;
  return j;
end $$;

create function public.fireafter_begin_staged_ingestion(p_id uuid,p_lease uuid,p_header jsonb)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '2s' set statement_timeout = '30s' as $$
declare j public.ingestion_jobs%rowtype; h public.ingestion_staged_bundles%rowtype;
  m jsonb; ids jsonb; k text; target uuid;
  uuid_pattern constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
begin
  j:=public.fireafter_staged_job(p_id,p_lease);
  if j.stage<>'prepare:final' then raise exception 'Stage changed' using errcode='FB409'; end if;
  if jsonb_typeof(p_header) is distinct from 'object' or octet_length(p_header::text)>16777216
    or p_header->>'version' is distinct from 'staged-ingestion-v1'
    or coalesce(p_header->>'rowsDigest','') !~ '^[a-f0-9]{64}$'
    or p_header->'write'->>'operation' not in ('create','refresh')
    or p_header->'write'->>'operation' is null
    or jsonb_typeof(p_header->'auditEvents') is distinct from 'array'
    or jsonb_array_length(p_header->'auditEvents') not between 1 and 2
    or coalesce(p_header->'incident'->>'id','') !~* uuid_pattern then
    raise exception 'Invalid staged header' using errcode='FB400';
  end if;
  target:=(p_header->'incident'->>'id')::uuid;
  if (p_header->'organization'->>'id')::uuid is distinct from j.organization_id
    or (p_header->'incident'->>'organization_id')::uuid is distinct from j.organization_id
    or (p_header->'write'->>'organizationId')::uuid is distinct from j.organization_id
    or (p_header->'write'->>'actorId')::uuid is distinct from j.actor_id
    or p_header->'incident'->'selected_fire'->>'domainIncidentId' is distinct from j.incident_key
    or (j.seed->>'targetId' is not null and target::text is distinct from j.seed->>'targetId') then
    raise exception 'Staged scope mismatch' using errcode='FB401';
  end if;
  select * into h from public.ingestion_staged_bundles where job_id=p_id;
  if found then
    if h.header is distinct from p_header then raise exception 'Staged input changed' using errcode='FB409'; end if;
    return h.counts;
  end if;
  m:=p_header->'incident'->'selected_fire'->'inventoryManifest';
  if m->>'version' is distinct from '2026-09-13-inventory-v1'
    or coalesce(m->>'revision','') !~* uuid_pattern then raise exception 'Invalid manifest' using errcode='FB400'; end if;
  insert into public.ingestion_staged_bundles(job_id,header) values(p_id,p_header);
  foreach k in array array['asset','recommendation','source'] loop
    ids:=m->case k when 'asset' then 'assetIds' when 'recommendation' then 'recommendationIds' else 'sourceSnapshotIds' end;
    if jsonb_typeof(ids) is distinct from 'array' or jsonb_array_length(ids)>100000
      or exists(select 1 from jsonb_array_elements(ids) e(value)
        where jsonb_typeof(value) is distinct from 'string' or coalesce(value #>> '{}','') !~* uuid_pattern) then
      raise exception 'Invalid membership' using errcode='FB400';
    end if;
    insert into public.ingestion_staged_rows(job_id,kind,row_id)
      select p_id,k,value::uuid from jsonb_array_elements_text(ids) e(value);
  end loop;
  return '{"asset":0,"recommendation":0,"source":0}'::jsonb;
exception when data_exception or integrity_constraint_violation then
  raise exception 'Invalid staged identities' using errcode='FB400';
end $$;

create function public.fireafter_stage_ingestion_rows(p_id uuid,p_lease uuid,p_kind text,p_position integer,p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '2s' set statement_timeout = '30s' as $$
declare j public.ingestion_jobs%rowtype; h public.ingestion_staged_bundles%rowtype;
  d text; previous_digest text; target uuid; n integer; b bigint; changed integer;
begin
  j:=public.fireafter_staged_job(p_id,p_lease);
  if j.stage<>'prepare:final' then raise exception 'Stage changed' using errcode='FB409'; end if;
  select * into h from public.ingestion_staged_bundles where job_id=p_id;
  if not found then raise exception 'Staged header missing' using errcode='FB400'; end if;
  if p_kind is null or p_kind not in ('asset','recommendation','source') or p_position is null
    or p_position not between 0 and 99999 or jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'Invalid staged page' using errcode='FB400';
  end if;
  n:=jsonb_array_length(p_rows); b:=octet_length(p_rows::text);
  if n not between 1 and 256 or b>33554432 then raise exception 'Staged page capacity exceeded' using errcode='FB400'; end if;
  d:=encode(sha256(convert_to(p_rows::text,'UTF8')),'hex');
  select digest into previous_digest from public.ingestion_staged_pages where job_id=p_id and kind=p_kind and position=p_position;
  if found then
    if previous_digest is distinct from d then raise exception 'Staged page changed' using errcode='FB409'; end if;
    return h.counts;
  end if;
  if p_position is distinct from (h.counts->>p_kind)::integer then raise exception 'Staged page out of sequence' using errcode='FB409'; end if;
  target:=(h.header->'incident'->>'id')::uuid;
  if exists(select 1 from jsonb_array_elements(p_rows) e(value)
    where jsonb_typeof(value) is distinct from 'object'
      or jsonb_typeof(value->'id') is distinct from 'string'
      or jsonb_typeof(value->'incident_id') is distinct from 'string'
      or coalesce(value->>'id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or coalesce(value->>'incident_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or (value->>'incident_id')::uuid is distinct from target)
    or (select count(distinct (value->>'id')::uuid) from jsonb_array_elements(p_rows) e(value))<>n then
    raise exception 'Invalid staged row scope' using errcode='FB400';
  end if;
  update public.ingestion_staged_rows s set payload=e.value from jsonb_array_elements(p_rows) e(value)
    where s.job_id=p_id and s.kind=p_kind and s.row_id=(e.value->>'id')::uuid and s.payload is null;
  get diagnostics changed = row_count;
  if changed<>n then raise exception 'Rows missing from manifest or already staged' using errcode='FB400'; end if;
  insert into public.ingestion_staged_pages values(p_id,p_kind,p_position,d);
  update public.ingestion_staged_bundles set counts=jsonb_set(counts,array[p_kind],to_jsonb(p_position+n)),stored_bytes=stored_bytes+b
    where job_id=p_id returning counts into h.counts;
  return h.counts;
exception when data_exception or integrity_constraint_violation then
  raise exception 'Invalid staged fields or capacity' using errcode='FB400';
end $$;

create function public.fireafter_commit_staged_ingestion(p_id uuid,p_lease uuid)
returns uuid language plpgsql security definer set search_path = '' set lock_timeout = '2s' set statement_timeout = '30s' as $$
declare j public.ingestion_jobs%rowtype; h jsonb; target uuid; minimal_incident jsonb; stripe integer;
begin
  -- Recovery receipts still require current membership, but not an expired lease.
  select * into j from public.ingestion_jobs where id=p_id for update;
  if not found then raise exception 'Unknown job' using errcode='FB404'; end if;
  perform 1 from public.organization_members where user_id=j.actor_id and organization_id=j.organization_id
    and role in ('analyst','incident_commander') for share;
  if not found then raise exception 'Membership revoked' using errcode='FB401'; end if;
  select incident_id into target from public.ingestion_commit_receipts where job_id=p_id and phase='final';
  if found then return target; end if;
  j:=public.fireafter_staged_job(p_id,p_lease);
  if j.stage<>'commit:final' then raise exception 'Stage changed' using errcode='FB409'; end if;
  select header into h from public.ingestion_staged_bundles where job_id=p_id;
  if h is null or exists(select 1 from public.ingestion_staged_rows where job_id=p_id and payload is null) then
    raise exception 'Staged inventory incomplete' using errcode='FB400';
  end if;
  target:=(h->'incident'->>'id')::uuid;
  if exists(select 1 from public.ingestion_staged_rows r where r.job_id=p_id and r.kind='recommendation'
    and (jsonb_typeof(r.payload->'asset_id') is distinct from 'string'
      or not exists(select 1 from public.ingestion_staged_rows a where a.job_id=p_id and a.kind='asset'
        and a.row_id=(r.payload->>'asset_id')::uuid))) then
    raise exception 'Recommendation outside staged assets' using errcode='FB400';
  end if;
  -- Match the existing fence lock order before taking all child/audit stripes.
  -- The unchanged fence below rechecks authority and expected revision.
  perform 1 from public.organizations where id=j.organization_id for no key update;
  perform pg_advisory_xact_lock(34000,hashtext(target::text));
  perform 1 from public.incidents where id=target for update;
  for stripe in select distinct (hashtext(id)&63) from (
    select row_id::text as id from public.ingestion_staged_rows where job_id=p_id
    union all select lower(value->>'id') from jsonb_array_elements(h->'auditEvents') e(value)) all_ids order by 1 loop
    perform pg_advisory_xact_lock(34001,stripe);
  end loop;
  if exists(select 1 from public.ingestion_staged_rows s join public.assets a on a.id=s.row_id
      where s.job_id=p_id and s.kind='asset' and a.incident_id is distinct from target)
    or exists(select 1 from public.ingestion_staged_rows s join public.recommendations r on r.id=s.row_id
      where s.job_id=p_id and s.kind='recommendation' and r.incident_id is distinct from target)
    or exists(select 1 from public.ingestion_staged_rows s join public.source_snapshots r on r.id=s.row_id
      where s.job_id=p_id and s.kind='source' and r.incident_id is distinct from target) then
    raise exception 'Cannot move another incident child' using errcode='FB400';
  end if;
  minimal_incident:=jsonb_set(h->'incident','{selected_fire,inventoryManifest}',
    (h->'incident'->'selected_fire'->'inventoryManifest')||'{"assetIds":[],"recommendationIds":[],"sourceSnapshotIds":[]}'::jsonb);
  -- The temporary empty membership is never externally visible. The same
  -- transaction writes all rows, restores exact membership, and saves a receipt.
  perform public.fireafter_commit_bundle(j.actor_id,(h->'write'->>'expectedRevision')::uuid,h->'write'->>'operation',
    h->'organization',minimal_incident,'[]','[]','[]','[]',h->'auditEvents');
  insert into public.assets(id,incident_id,name,asset_type,location_label,source,source_key,source_url,source_feature_id,
    source_feature_ids,geometry_geojson,origin,coverage_status,confidence_reason,confidence,local_or_uploaded,properties)
    select r.id,r.incident_id,r.name,r.asset_type,r.location_label,r.source,r.source_key,r.source_url,r.source_feature_id,
      coalesce(r.source_feature_ids,'{}'),r.geometry_geojson,r.origin,coalesce(r.coverage_status,'not_available'),
      r.confidence_reason,r.confidence,r.local_or_uploaded,coalesce(r.properties,'{}')
    from public.ingestion_staged_rows s cross join lateral jsonb_populate_record(null::public.assets,s.payload) r
    where s.job_id=p_id and s.kind='asset'
    on conflict(id) do update set incident_id=excluded.incident_id,name=excluded.name,asset_type=excluded.asset_type,
      location_label=excluded.location_label,source=excluded.source,source_key=excluded.source_key,source_url=excluded.source_url,
      source_feature_id=excluded.source_feature_id,source_feature_ids=excluded.source_feature_ids,geometry_geojson=excluded.geometry_geojson,
      origin=excluded.origin,coverage_status=excluded.coverage_status,confidence_reason=excluded.confidence_reason,
      confidence=excluded.confidence,local_or_uploaded=excluded.local_or_uploaded,properties=excluded.properties;
  insert into public.source_snapshots(id,incident_id,source_key,source_url,source_name,fetched_at,source_updated_at,status,stale,
    freshness_label,coverage_status,warnings,derived_signals,raw_payload)
    select r.id,r.incident_id,r.source_key,r.source_url,r.source_name,r.fetched_at,r.source_updated_at,r.status,r.stale,
      r.freshness_label,coalesce(r.coverage_status,'not_available'),coalesce(r.warnings,'{}'),coalesce(r.derived_signals,'{}'),coalesce(r.raw_payload,'{}')
    from public.ingestion_staged_rows s cross join lateral jsonb_populate_record(null::public.source_snapshots,s.payload) r
    where s.job_id=p_id and s.kind='source';
  insert into public.recommendations(id,incident_id,asset_id,final_score,score_100,risk_level,confidence_level,recommended_action,
    reason_codes,limitations,changed_since_last_refresh,score_breakdown,evidence,metric_status,source_snapshot_ids)
    select r.id,r.incident_id,r.asset_id,r.final_score,r.score_100,r.risk_level,r.confidence_level,r.recommended_action,
      coalesce(r.reason_codes,'{}'),coalesce(r.limitations,'{}'),r.changed_since_last_refresh,r.score_breakdown,
      coalesce(r.evidence,'[]'),coalesce(r.metric_status,'{}'),coalesce(r.source_snapshot_ids,'{}')
    from public.ingestion_staged_rows s cross join lateral jsonb_populate_record(null::public.recommendations,s.payload) r
    where s.job_id=p_id and s.kind='recommendation'
    on conflict(id) do update set incident_id=excluded.incident_id,asset_id=excluded.asset_id,final_score=excluded.final_score,
      score_100=excluded.score_100,risk_level=excluded.risk_level,confidence_level=excluded.confidence_level,recommended_action=excluded.recommended_action,
      reason_codes=excluded.reason_codes,limitations=excluded.limitations,changed_since_last_refresh=excluded.changed_since_last_refresh,
      score_breakdown=excluded.score_breakdown,evidence=excluded.evidence,metric_status=excluded.metric_status,source_snapshot_ids=excluded.source_snapshot_ids;
  update public.incidents set selected_fire=h->'incident'->'selected_fire' where id=target;
  insert into public.ingestion_commit_receipts(job_id,phase,incident_id,revision)
    values(p_id,'final',target,(h->'incident'->'selected_fire'->'inventoryManifest'->>'revision')::uuid);
  delete from public.ingestion_staged_bundles where job_id=p_id;
  return target;
exception when data_exception or integrity_constraint_violation then
  raise exception 'Invalid staged fields or conflicting identities' using errcode='FB400';
end $$;

revoke all on function public.fireafter_staged_job(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.fireafter_begin_staged_ingestion(uuid,uuid,jsonb),
  public.fireafter_stage_ingestion_rows(uuid,uuid,text,integer,jsonb),public.fireafter_commit_staged_ingestion(uuid,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.fireafter_begin_staged_ingestion(uuid,uuid,jsonb),
  public.fireafter_stage_ingestion_rows(uuid,uuid,text,integer,jsonb),public.fireafter_commit_staged_ingestion(uuid,uuid) to service_role;

create function public.fireafter_staged_ingestion_security_version()
returns text language sql stable security invoker set search_path = '' as $$
  with expected(signature,result_type,settings,body_hash,service_execute) as (values
    ('public.fireafter_staged_job(uuid,uuid)','public.ingestion_jobs',array['search_path=""']::text[],
      '17bf53fa6bc554a749547bb6c833ca8caf4a294eb2a982d6a2ad65c1dc142786',false),
    ('public.fireafter_begin_staged_ingestion(uuid,uuid,jsonb)','jsonb',array['search_path=""','lock_timeout=2s','statement_timeout=30s']::text[],
      'f8b3913888fe99b9d271e5be149b06d8029ebc5a1f458e9c468d59cdde095b8e',true),
    ('public.fireafter_stage_ingestion_rows(uuid,uuid,text,integer,jsonb)','jsonb',array['search_path=""','lock_timeout=2s','statement_timeout=30s']::text[],
      '34ce2ee04265690bee973d7b9a4b2b566a2599836ad649b6df644dbf84e8c61d',true),
    ('public.fireafter_commit_staged_ingestion(uuid,uuid)','uuid',array['search_path=""','lock_timeout=2s','statement_timeout=30s']::text[],
      '75329baf0287b4d48126f946428a2dd1dc6497481238c3a6e0d80694500f4816',true),
    ('public.fireafter_commit_bundle(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb)','void',array['search_path=""','lock_timeout=2s','statement_timeout=30s']::text[],
      'fe543da2cee605072d697b0747b77b413c97e6108fc0adf0917ff0da967261c2',true),
    ('public.fireafter_persist_bundle(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb)','void',array['search_path=public']::text[],
      '8da7cbfdbdec493d6df5322aada6c599de0748964649f91dccbb3b7af3295b8b',false)
  ), functions_ok as (
    select count(*)=6 and bool_and((p.prokind='f' and p.prosecdef and not p.proretset and not p.proisstrict
      and not p.proleakproof and p.provolatile='v' and p.proparallel='u' and p.prorettype=to_regtype(e.result_type)
      and p.pronargdefaults=0 and p.prosupport=0 and p.provariadic=0 and p.proallargtypes is null and p.proargmodes is null
      and p.prolang=(select oid from pg_language where lanname='plpgsql') and p.proconfig=e.settings
      and pg_get_userbyid(p.proowner)='postgres'
      and not has_function_privilege('anon',p.oid,'EXECUTE') and not has_function_privilege('authenticated',p.oid,'EXECUTE')
      and has_function_privilege('service_role',p.oid,'EXECUTE')=e.service_execute
      and encode(sha256(convert_to(btrim(replace(p.prosrc,E'\r\n',E'\n'),E' \t\r\n'),'UTF8')),'hex')=e.body_hash) is true) as ok
    from expected e left join pg_proc p on p.oid=to_regprocedure(e.signature)
  ), tables_ok as (
    select count(*)=3 and bool_and((c.relrowsecurity and pg_get_userbyid(c.relowner)='postgres'
      and not has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      and not has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      and not has_table_privilege('service_role',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) is true) as ok
    from (values ('public.ingestion_staged_bundles'),('public.ingestion_staged_rows'),('public.ingestion_staged_pages')) t(name)
    left join pg_class c on c.oid=to_regclass(t.name)
  ) select case when f.ok and t.ok then '20261008111654' else null end from functions_ok f,tables_ok t;
$$;
revoke all on function public.fireafter_staged_ingestion_security_version() from public,anon,authenticated;
grant execute on function public.fireafter_staged_ingestion_security_version() to service_role;
notify pgrst,'reload schema';
