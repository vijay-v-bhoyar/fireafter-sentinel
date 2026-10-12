-- Additive, service-only job/checkpoint storage. Existing bundle fencing remains authoritative.
set local lock_timeout = '2s';
set local statement_timeout = '60s';

create table public.ingestion_jobs (
  id uuid primary key,
  actor_id uuid not null references auth.users(id),
  organization_id uuid not null references public.organizations(id),
  incident_key text not null check (length(incident_key) between 1 and 256),
  kind text not null check (kind in ('create','refresh')),
  seed jsonb not null,
  stage text not null default 'initialize',
  status text not null default 'queued' check (status in ('queued','running','failed','completed')),
  lease_id uuid,
  lease_until timestamptz,
  attempts integer not null default 0,
  progress jsonb not null default '{}',
  error_code text,
  dispatch_after timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
create unique index ingestion_one_active_county on public.ingestion_jobs(organization_id, incident_key)
  where status in ('queued','running');
create table public.ingestion_checkpoints (
  job_id uuid not null references public.ingestion_jobs(id),
  key text not null check (key ~ '^[a-zA-Z0-9:_-]{1,80}$'),
  part integer not null check (part between -1 and 1023),
  value jsonb not null check (octet_length(value::text) <= 786432),
  primary key(job_id,key,part)
);
create table public.ingestion_commit_receipts (
  job_id uuid not null references public.ingestion_jobs(id),
  phase text not null check (phase in ('initial','final')),
  incident_id uuid not null references public.incidents(id),
  revision uuid not null,
  committed_at timestamptz not null default clock_timestamp(),
  primary key(job_id,phase)
);
alter table public.ingestion_jobs enable row level security;
alter table public.ingestion_checkpoints enable row level security;
alter table public.ingestion_commit_receipts enable row level security;
revoke all on public.ingestion_jobs, public.ingestion_checkpoints, public.ingestion_commit_receipts from public, anon, authenticated, service_role;
grant select on public.ingestion_jobs, public.ingestion_checkpoints, public.ingestion_commit_receipts to service_role;
create trigger ingestion_receipts_append_only before update or delete on public.ingestion_commit_receipts
  for each row execute function public.fireafter_prevent_append_only_mutation();
create trigger ingestion_receipts_no_truncate before truncate on public.ingestion_commit_receipts
  for each statement execute function public.fireafter_prevent_append_only_mutation();
alter table public.ingestion_commit_receipts enable always trigger ingestion_receipts_append_only;
alter table public.ingestion_commit_receipts enable always trigger ingestion_receipts_no_truncate;

create function public.fireafter_dispatch_ingestion(p_id uuid)
returns boolean language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
begin
  update public.ingestion_jobs set dispatch_after=clock_timestamp()+interval '3 minutes'
    where id=p_id and status in ('queued','running') and dispatch_after<=clock_timestamp();
  return found;
end $$;

create function public.fireafter_resume_ingestion(p_id uuid, p_actor uuid, p_org uuid)
returns void language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare j public.ingestion_jobs%rowtype;
begin
  perform 1 from public.organization_members where user_id=p_actor and organization_id=p_org
    and role in ('analyst','incident_commander') for share;
  if not found then raise exception 'Membership required' using errcode='FB401'; end if;
  select * into j from public.ingestion_jobs where id=p_id and actor_id=p_actor and organization_id=p_org for update;
  if not found then raise exception 'Unknown operation' using errcode='FB404'; end if;
  if j.status='failed' then
    if j.error_code is distinct from 'step_attempts_exhausted' then
      raise exception 'Evidence or authority changed; review before starting a new operation' using errcode='FB409';
    end if;
    update public.ingestion_jobs set status='queued',attempts=0,error_code=null,lease_id=null,lease_until=null,
      dispatch_after=clock_timestamp(),updated_at=clock_timestamp() where id=p_id;
  end if;
end $$;

create function public.fireafter_enqueue_ingestion(p_id uuid, p_actor uuid, p_org uuid, p_incident text, p_kind text, p_seed jsonb)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare j public.ingestion_jobs%rowtype;
begin
  if p_id is null or p_actor is null or p_org is null or p_kind not in ('create','refresh')
    or jsonb_typeof(p_seed) is distinct from 'object' or octet_length(p_seed::text) > 65536 then
    raise exception 'Invalid job' using errcode='FB400';
  end if;
  perform 1 from public.organization_members where user_id=p_actor and organization_id=p_org
    and role in ('analyst','incident_commander') for share;
  if not found then raise exception 'Membership required' using errcode='FB401'; end if;
  perform pg_catalog.pg_advisory_xact_lock(71007, pg_catalog.hashtext(p_org::text));
  select * into j from public.ingestion_jobs where id=p_id;
  if found then
    if j.actor_id<>p_actor or j.organization_id<>p_org or j.incident_key<>p_incident or j.kind<>p_kind then
      raise exception 'Operation scope mismatch' using errcode='FB408';
    end if;
    return to_jsonb(j);
  end if;
  select * into j from public.ingestion_jobs where organization_id=p_org and incident_key=p_incident and status in ('queued','running');
  if found then
    if j.actor_id<>p_actor then raise exception 'County has an active operation' using errcode='FB409'; end if;
    return to_jsonb(j);
  end if;
  if (select count(*) from public.ingestion_jobs where organization_id=p_org and status in ('queued','running')) >= 10 then
    raise exception 'Organization job capacity reached' using errcode='FB409';
  end if;
  insert into public.ingestion_jobs(id,actor_id,organization_id,incident_key,kind,seed)
    values(p_id,p_actor,p_org,p_incident,p_kind,p_seed) returning * into j;
  return to_jsonb(j);
end $$;

create function public.fireafter_claim_ingestion(p_id uuid, p_lease uuid)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare j public.ingestion_jobs%rowtype;
begin
  if p_lease is null then raise exception 'Lease required' using errcode='FB400'; end if;
  select * into j from public.ingestion_jobs where id=p_id for update;
  if not found or j.status in ('completed','failed') then return null; end if;
  if j.lease_until>clock_timestamp() then return null; end if;
  perform 1 from public.organization_members where user_id=j.actor_id and organization_id=j.organization_id
    and role in ('analyst','incident_commander') for share;
  if not found then
    update public.ingestion_jobs set status='failed',error_code='FB401',updated_at=clock_timestamp() where id=p_id;
    return null;
  end if;
  if j.attempts >= 4 then
    update public.ingestion_jobs set status='failed',error_code='step_attempts_exhausted',updated_at=clock_timestamp() where id=p_id;
    return null;
  end if;
  update public.ingestion_jobs set status='running',lease_id=p_lease,lease_until=clock_timestamp()+interval '180 seconds',
    attempts=attempts+1,updated_at=clock_timestamp() where id=p_id returning * into j;
  return to_jsonb(j);
end $$;

create function public.fireafter_checkpoint_ingestion(p_id uuid, p_lease uuid, p_key text, p_part integer, p_value jsonb)
returns void language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
begin
  perform 1 from public.ingestion_jobs where id=p_id and lease_id=p_lease and lease_until>clock_timestamp() and status='running' for update;
  if not found then raise exception 'Lease lost' using errcode='FB409'; end if;
  if p_value is null then raise exception 'Checkpoint required' using errcode='FB400'; end if;
  insert into public.ingestion_checkpoints(job_id,key,part,value) values(p_id,p_key,p_part,p_value)
    on conflict(job_id,key,part) do update set value=excluded.value;
end $$;

create function public.fireafter_advance_ingestion(p_id uuid, p_lease uuid, p_stage text, p_progress jsonb, p_error text)
returns void language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
begin
  if length(p_stage)>80 or jsonb_typeof(p_progress) is distinct from 'object' or octet_length(p_progress::text)>4096 then
    raise exception 'Invalid progress' using errcode='FB400';
  end if;
  if p_stage='done' and not exists(select 1 from public.ingestion_commit_receipts where job_id=p_id and phase='final') then
    raise exception 'Final receipt required' using errcode='FB400';
  end if;
  update public.ingestion_jobs set stage=p_stage, progress=p_progress, error_code=p_error,
    status=case when p_error is not null then 'failed' when p_stage='done' then 'completed' else 'queued' end,
    lease_id=null,lease_until=null,attempts=0,updated_at=clock_timestamp()
    where id=p_id and lease_id=p_lease and lease_until>clock_timestamp() and status='running';
  if not found then raise exception 'Lease lost' using errcode='FB409'; end if;
  if p_stage='done' and p_error is null then
    -- Commit receipts and audit history remain. Large transfer/terrain scratch
    -- checkpoints are no longer needed once the final commit is confirmed.
    delete from public.ingestion_checkpoints where job_id=p_id and key not like 'source:%';
    delete from public.ingestion_checkpoints c using public.ingestion_jobs old,public.ingestion_jobs current_job
      where current_job.id=p_id and c.job_id=old.id and old.id<>p_id
        and old.organization_id=current_job.organization_id and old.incident_key=current_job.incident_key
        and old.status='completed' and old.updated_at<current_job.created_at;
  end if;
end $$;

create function public.fireafter_note_ingestion_error(p_id uuid, p_lease uuid, p_code text)
returns void language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
begin
  if p_code is null or p_code !~ '^[A-Za-z0-9_]{1,80}$' then raise exception 'Invalid error code' using errcode='FB400'; end if;
  update public.ingestion_jobs set error_code=p_code,updated_at=clock_timestamp()
    where id=p_id and lease_id=p_lease and lease_until>clock_timestamp() and status='running';
end $$;

-- The checkpointed payload is assembled inside Postgres. A small commit request
-- atomically writes both the existing fenced bundle and its recovery receipt.
create function public.fireafter_commit_ingestion(p_id uuid, p_lease uuid, p_phase text)
returns uuid language plpgsql security definer set search_path = '' set lock_timeout = '2s' set statement_timeout = '30s' as $$
declare j public.ingestion_jobs%rowtype; m jsonb; b bytea; v jsonb; target uuid; part_count integer;
begin
  if p_phase not in ('initial','final') then raise exception 'Invalid phase' using errcode='FB400'; end if;
  select * into j from public.ingestion_jobs where id=p_id for update;
  if not found then raise exception 'Unknown job' using errcode='FB404'; end if;
  perform 1 from public.organization_members where user_id=j.actor_id and organization_id=j.organization_id
    and role in ('analyst','incident_commander') for share;
  if not found then raise exception 'Membership revoked' using errcode='FB401'; end if;
  select incident_id into target from public.ingestion_commit_receipts where job_id=p_id and phase=p_phase;
  if found then return target; end if;
  if j.lease_id is distinct from p_lease or j.lease_until<=clock_timestamp() or j.status<>'running'
    or j.stage <> 'commit:' || p_phase then raise exception 'Lease/stage lost' using errcode='FB409'; end if;
  select value into m from public.ingestion_checkpoints where job_id=p_id and key='commit:'||p_phase and part=-1;
  if m is null or m->>'encoding'<>'base64-json' or (m->>'bytes')::bigint>67108864 then
    raise exception 'Commit manifest missing' using errcode='FB400';
  end if;
  select string_agg(pg_catalog.decode(value->>'data','base64'), ''::bytea order by part),count(*) into b,part_count
    from public.ingestion_checkpoints where job_id=p_id and key='commit:'||p_phase and part>=0 and part<(m->>'parts')::integer;
  if part_count<>(m->>'parts')::integer or octet_length(b)<>(m->>'bytes')::integer
    or pg_catalog.encode(pg_catalog.sha256(b),'hex')<>m->>'hash' then
    raise exception 'Commit checkpoint incomplete' using errcode='FB400';
  end if;
  v:=pg_catalog.convert_from(b,'UTF8')::jsonb;
  target:=(v->'incident'->>'id')::uuid;
  if (v->'organization'->>'id')::uuid is distinct from j.organization_id
    or (v->'write'->>'actorId')::uuid is distinct from j.actor_id
    or v->'incident'->'selected_fire'->>'domainIncidentId' is distinct from j.incident_key
    or (j.seed->>'targetId' is not null and target::text is distinct from j.seed->>'targetId') then
    raise exception 'Commit scope mismatch' using errcode='FB401';
  end if;
  perform public.fireafter_commit_bundle(j.actor_id,(v->'write'->>'expectedRevision')::uuid,v->'write'->>'operation',
    v->'organization',v->'incident',v->'sourceSnapshots',v->'assets',v->'recommendations','[]'::jsonb,v->'auditEvents');
  insert into public.ingestion_commit_receipts(job_id,phase,incident_id,revision)
    values(p_id,p_phase,target,(v->'incident'->'selected_fire'->'inventoryManifest'->>'revision')::uuid);
  return target;
end $$;

revoke all on function public.fireafter_note_ingestion_error(uuid,uuid,text),public.fireafter_resume_ingestion(uuid,uuid,uuid),public.fireafter_dispatch_ingestion(uuid), public.fireafter_enqueue_ingestion(uuid,uuid,uuid,text,text,jsonb),
 public.fireafter_claim_ingestion(uuid,uuid), public.fireafter_checkpoint_ingestion(uuid,uuid,text,integer,jsonb),
 public.fireafter_advance_ingestion(uuid,uuid,text,jsonb,text),public.fireafter_commit_ingestion(uuid,uuid,text)
 from public,anon,authenticated;
grant execute on function public.fireafter_note_ingestion_error(uuid,uuid,text),public.fireafter_resume_ingestion(uuid,uuid,uuid),public.fireafter_dispatch_ingestion(uuid), public.fireafter_enqueue_ingestion(uuid,uuid,uuid,text,text,jsonb),
 public.fireafter_claim_ingestion(uuid,uuid),public.fireafter_checkpoint_ingestion(uuid,uuid,text,integer,jsonb),
 public.fireafter_advance_ingestion(uuid,uuid,text,jsonb,text),public.fireafter_commit_ingestion(uuid,uuid,text) to service_role;

notify pgrst, 'reload schema';
