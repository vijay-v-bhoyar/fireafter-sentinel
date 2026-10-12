-- Sentinel-only logical dispatch, immutable private stage output and lease-fenced completion.
create table public.sentinel_dispatch_attempts (
 id uuid primary key,organization_id uuid not null,incident_id uuid not null,mode text not null,run_id uuid not null,
 sequence integer not null check(sequence between 1 and 4),created_at timestamptz not null,
 unique(run_id,sequence),foreign key(organization_id,incident_id,mode,run_id) references public.sentinel_runs(organization_id,incident_id,mode,id)
);
create table public.sentinel_dispatch_receipts (
 attempt_id uuid primary key references public.sentinel_dispatch_attempts(id),runtime_run_id text not null check(runtime_run_id ~ '^[A-Za-z0-9_-]{1,200}$'),created_at timestamptz not null
);
create table public.sentinel_worker_outputs (
 organization_id uuid not null,incident_id uuid not null,mode text not null,run_id uuid not null,
 sequence integer not null check(sequence between 0 and 20),kind text not null check(kind in ('context','search','extract','evidence','claims','changes')),
 frame text not null check(octet_length(frame)<=1048576),payload jsonb not null check(jsonb_typeof(payload)='object'),payload_hash text not null check(payload_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null,fence bigint not null,
 primary key(run_id,sequence),foreign key(organization_id,incident_id,mode,run_id) references public.sentinel_runs(organization_id,incident_id,mode,id)
);
alter table public.sentinel_dispatch_attempts enable row level security;
alter table public.sentinel_dispatch_receipts enable row level security;
alter table public.sentinel_worker_outputs enable row level security;
revoke all on public.sentinel_dispatch_attempts,public.sentinel_dispatch_receipts,public.sentinel_worker_outputs from public,anon,authenticated,service_role;
create trigger sentinel_dispatch_attempts_immutable before update or delete on public.sentinel_dispatch_attempts for each row execute function public.sentinel_reject_evidence_mutation();
create trigger sentinel_dispatch_receipts_immutable before update or delete on public.sentinel_dispatch_receipts for each row execute function public.sentinel_reject_evidence_mutation();
create trigger sentinel_worker_outputs_immutable before update or delete on public.sentinel_worker_outputs for each row execute function public.sentinel_reject_evidence_mutation();

create function public.sentinel_worker_locator(p_run_id uuid) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.sentinel_runs%rowtype;
begin
 select * into r from public.sentinel_runs where dispatch_id=p_run_id;
 if not found then raise exception 'Run unavailable' using errcode='42501';end if;
 r:=public.sentinel_lock_worker_run(r.organization_id,r.incident_id,r.mode,r.id);
 return public.sentinel_run_view(r);
end;$$;

create function public.sentinel_dispatch_state(p_run_id uuid) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.sentinel_runs%rowtype;a public.sentinel_dispatch_attempts%rowtype;runtime_id text;
begin
 perform public.sentinel_worker_locator(p_run_id);
 select * into r from public.sentinel_runs where dispatch_id=p_run_id;
 select * into a from public.sentinel_dispatch_attempts where run_id=p_run_id order by sequence desc limit 1;
 if found then select runtime_run_id into runtime_id from public.sentinel_dispatch_receipts where attempt_id=a.id;end if;
 return jsonb_build_object('run',public.sentinel_run_view(r),'attemptId',a.id,'runtimeRunId',runtime_id);
end;$$;

create function public.sentinel_claim_dispatch(p_run_id uuid,p_attempt_id uuid,p_expected_attempt uuid,p_runtime_terminal boolean) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.sentinel_runs%rowtype;a public.sentinel_dispatch_attempts%rowtype;stamp timestamptz;seq integer:=1;
begin
 if p_attempt_id is null or p_runtime_terminal is null then raise exception 'Invalid dispatch' using errcode='22023';end if;
 perform public.sentinel_worker_locator(p_run_id);select * into r from public.sentinel_runs where dispatch_id=p_run_id for update;
 stamp:=date_trunc('milliseconds',clock_timestamp());
 if r.status not in ('queued','retrieving','interpreting','validating') or r.deadline_at<=stamp or r.lease_until>stamp then return null;end if;
 select * into a from public.sentinel_dispatch_attempts where run_id=p_run_id order by sequence desc limit 1;
 if a.id is distinct from p_expected_attempt then return null;end if;
 if a.id is not null then
  if a.sequence>=4 or a.created_at+interval '15 seconds'>stamp then return null;end if;
  if exists(select 1 from public.sentinel_dispatch_receipts where attempt_id=a.id) and not p_runtime_terminal then return null;end if;
  seq:=a.sequence+1;
 end if;
 insert into public.sentinel_dispatch_attempts values(p_attempt_id,r.organization_id,r.incident_id,r.mode,r.id,seq,stamp);
 return jsonb_build_object('attemptId',p_attempt_id,'dispatchId',r.dispatch_id);
end;$$;

create function public.sentinel_ack_dispatch(p_run_id uuid,p_attempt_id uuid,p_runtime_run_id text) returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
declare previous text;
begin
 if p_runtime_run_id is null or p_runtime_run_id !~ '^[A-Za-z0-9_-]{1,200}$' then raise exception 'Invalid runtime identity' using errcode='22023';end if;
 perform public.sentinel_worker_locator(p_run_id);
 if not exists(select 1 from public.sentinel_dispatch_attempts where run_id=p_run_id and id=p_attempt_id) then raise exception 'Dispatch unavailable' using errcode='42501';end if;
 select runtime_run_id into previous from public.sentinel_dispatch_receipts where attempt_id=p_attempt_id;
 if found then if previous<>p_runtime_run_id then raise exception 'Dispatch conflict' using errcode='23505';end if;return true;end if;
 insert into public.sentinel_dispatch_receipts values(p_attempt_id,p_runtime_run_id,clock_timestamp());return true;
end;$$;

create function public.sentinel_read_worker(p_org uuid,p_incident uuid,p_mode text,p_run uuid,p_owner uuid,p_fence bigint) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.sentinel_runs%rowtype;s public.sentinel_incident_state%rowtype;cfg jsonb;versions jsonb;assets jsonb;outputs jsonb;claims jsonb;clock_at timestamptz;
begin
 r:=public.sentinel_lock_worker_run(p_org,p_incident,p_mode,p_run);perform public.sentinel_assert_lease(r,p_owner,p_fence,clock_timestamp());
 select * into s from public.sentinel_incident_state where organization_id=p_org and incident_id=p_incident and mode=p_mode;
 if s.current_source_config_revision is distinct from r.source_config_revision then raise exception 'Configuration changed' using errcode='40001';end if;
 select configuration into cfg from public.sentinel_source_configs where organization_id=p_org and incident_id=p_incident and mode=p_mode and id=r.source_config_revision;
 perform public.sentinel_source_config_hash(cfg);
 select coalesce((configuration->>'evaluationAt')::timestamptz,clock_timestamp()) into clock_at from public.sentinel_policies where organization_id=p_org and incident_id=p_incident and mode=p_mode and id=s.current_policy_revision;
 if p_mode<>'live' and clock_at is null then raise exception 'Scenario clock unavailable' using errcode='22023';end if;
 select coalesce(jsonb_agg(jsonb_build_object('documentId',d.document_id,'versionId',v.id,'previousVersionId',m.previous_version_id,'markerId',m.id,'hasComparison',exists(select 1 from public.sentinel_changes ch where ch.organization_id=p_org and ch.incident_id=p_incident and ch.mode=p_mode and ch.marker_id=m.id),
   'current',public.sentinel_read_document_version(r.created_by,p_org,p_incident,p_mode,v.id),'previous',case when old.id is null then null else public.sentinel_read_document_version(r.created_by,p_org,p_incident,p_mode,old.id) end) order by d.document_id),'[]') into versions
 from public.sentinel_document_heads d join public.sentinel_document_versions v on v.organization_id=d.organization_id and v.incident_id=d.incident_id and v.mode=d.mode and v.id=d.version_id
 left join lateral(select x.* from public.sentinel_source_change_markers x where x.organization_id=d.organization_id and x.incident_id=d.incident_id and x.mode=d.mode and x.version_id=v.id order by x.created_at desc,x.id desc limit 1)m on true
 left join public.sentinel_document_versions old on old.organization_id=d.organization_id and old.incident_id=d.incident_id and old.mode=d.mode and old.id=m.previous_version_id
 where d.organization_id=p_org and d.incident_id=p_incident and d.mode=p_mode and v.source_config_revision=r.source_config_revision
 and (p_mode='live' or (v.retrieved_at<=clock_at and (old.id is null or old.retrieved_at<=clock_at)))
 and exists(select 1 from jsonb_array_elements(cfg->'sources') e where e->>'documentId'=d.document_id::text and e->>'contentPermission'='full_text')
 and v.content_permission='full_text' and (old.id is null or old.content_permission='full_text');
 select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'name',a.name) order by a.id),'[]') into assets from public.assets a
 where a.incident_id=p_incident and not a.local_or_uploaded and a.id in (
 select (t->>'assetId')::uuid from public.sentinel_constraints c cross join lateral jsonb_array_elements(c.configuration->'tasks')t
 where c.organization_id=p_org and c.incident_id=p_incident and c.mode=p_mode and c.id=s.current_constraint_revision);
 select coalesce(jsonb_agg(c.body-'scope'-'runId'-'createdAt' order by c.claim_sequence),'[]') into claims from public.sentinel_claims c
 join public.sentinel_document_heads h on h.organization_id=c.organization_id and h.incident_id=c.incident_id and h.mode=c.mode and h.version_id=c.document_version_id
 join lateral(select p.run_id,p.command_id from public.sentinel_claim_publications p where p.organization_id=c.organization_id and p.incident_id=c.incident_id and p.mode=c.mode and p.payload->'versionIds' @> jsonb_build_array(c.document_version_id::text) order by (p.receipt->>'committedAt')::timestamptz desc,p.command_id desc limit 1) pub on pub.run_id=c.run_id and pub.command_id=c.publication_command_id
 where c.organization_id=p_org and c.incident_id=p_incident and c.mode=p_mode and h.source_config_revision=r.source_config_revision;
 select coalesce(jsonb_agg(jsonb_build_object('sequence',sequence,'kind',kind,'payload',payload,'hash',payload_hash) order by sequence),'[]') into outputs from public.sentinel_worker_outputs where run_id=p_run;
 perform public.sentinel_assert_lease(r,p_owner,p_fence,clock_timestamp());
 if octet_length(versions::text)>1048576 or jsonb_array_length(versions)>5 or jsonb_array_length(assets)>10 or jsonb_array_length(claims)>25 then raise exception 'Worker context exceeds bounds' using errcode='54000';end if;
 return jsonb_build_object('run',public.sentinel_run_view(r),'configuration',cfg,'evidenceGeneration',s.evidence_generation,'versions',versions,'assets',assets,'outputs',outputs,'claims',claims);
end;$$;

create function public.sentinel_save_worker_output(p_org uuid,p_incident uuid,p_mode text,p_run uuid,p_owner uuid,p_fence bigint,p_sequence integer,p_kind text,p_frame text,p_hash text,p_state text) returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.sentinel_runs%rowtype;old public.sentinel_worker_outputs%rowtype;payload jsonb;next_seq integer;
begin
 if p_sequence is null or p_sequence not between 0 and 20 or p_kind is null or p_kind not in ('context','search','extract','evidence','claims','changes') or p_state is null or p_state not in ('retrieving','interpreting','validating')
 or p_frame is null or octet_length(p_frame)>1048576 or p_hash is null or encode(sha256(convert_to(p_frame,'UTF8')),'hex')<>p_hash then raise exception 'Invalid worker output' using errcode='22023';end if;
 payload:=p_frame::jsonb;if jsonb_typeof(payload)<>'object' then raise exception 'Invalid output payload' using errcode='22023';end if;
 r:=public.sentinel_lock_worker_run(p_org,p_incident,p_mode,p_run);perform public.sentinel_assert_lease(r,p_owner,p_fence,clock_timestamp());
 if not exists(select 1 from public.sentinel_incident_state where organization_id=p_org and incident_id=p_incident and mode=p_mode and current_source_config_revision=r.source_config_revision) then raise exception 'Configuration changed' using errcode='40001';end if;
 select * into old from public.sentinel_worker_outputs where run_id=p_run and sequence=p_sequence;
 if found then if old.kind<>p_kind or old.payload_hash<>p_hash or old.frame<>p_frame then raise exception 'Worker output conflict' using errcode='23505';end if;return true;end if;
 select coalesce(max(sequence)+1,0) into next_seq from public.sentinel_worker_outputs where run_id=p_run;
 if p_sequence<>next_seq or not (r.status=p_state or (r.status='retrieving' and p_state='interpreting') or (r.status='interpreting' and p_state='validating')) then raise exception 'Worker sequence changed' using errcode='40001';end if;
 -- Only reviewed full-text registrations may retain acquisition/model artifacts.
 if exists(select 1 from public.sentinel_source_configs c cross join lateral jsonb_array_elements(c.configuration->'sources')e where c.organization_id=p_org and c.incident_id=p_incident and c.mode=p_mode and c.id=r.source_config_revision and e->>'contentPermission'<>'full_text') then raise exception 'Unsupported retention' using errcode='22023';end if;
 insert into public.sentinel_worker_outputs values(p_org,p_incident,p_mode,p_run,p_sequence,p_kind,p_frame,payload,p_hash,clock_timestamp(),p_fence);
 perform public.sentinel_assert_lease(r,p_owner,p_fence,clock_timestamp());
 update public.sentinel_runs set status=p_state,stage=p_kind,lease_owner=null,lease_until=null where id=p_run;return true;
end;$$;

create function public.sentinel_finish_worker(p_org uuid,p_incident uuid,p_mode text,p_run uuid,p_owner uuid,p_fence bigint,p_status text,p_code text) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.sentinel_runs%rowtype;
begin
 if p_status is null or p_status not in ('completed','failed','budget_stopped') or p_code is null or p_code !~ '^[a-z0-9_-]{1,80}$' then raise exception 'Invalid completion' using errcode='22023';end if;
 if p_status='completed' then
  r:=public.sentinel_lock_worker_run(p_org,p_incident,p_mode,p_run);
 else
  -- A retired registry cannot be used for successful work; it must not prevent safe failure cleanup.
  select * into r from public.sentinel_runs where organization_id=p_org and incident_id=p_incident and mode=p_mode and id=p_run;
  if not found then raise exception 'Run unavailable' using errcode='42501';end if;
  perform public.sentinel_lock_execution(r.created_by,p_org,p_incident,p_mode);
  select * into r from public.sentinel_runs where organization_id=p_org and incident_id=p_incident and mode=p_mode and id=p_run for update;
 end if;
 perform public.sentinel_assert_lease(r,p_owner,p_fence,clock_timestamp());
 if p_status='completed' and not exists(select 1 from public.sentinel_incident_state where organization_id=p_org and incident_id=p_incident and mode=p_mode and current_source_config_revision=r.source_config_revision) then raise exception 'Configuration changed' using errcode='40001';end if;
 if p_status='completed' and p_mode<>'live' and (not exists(select 1 from public.sentinel_incident_state s join public.sentinel_policies p on p.organization_id=s.organization_id and p.incident_id=s.incident_id and p.mode=s.mode and p.id=s.current_policy_revision where s.organization_id=p_org and s.incident_id=p_incident and s.mode=p_mode and p.configuration->>'evaluationAt' is not null)
  or exists(select 1 from public.sentinel_incident_state s join public.sentinel_policies p on p.organization_id=s.organization_id and p.incident_id=s.incident_id and p.mode=s.mode and p.id=s.current_policy_revision join public.sentinel_document_heads h on h.organization_id=s.organization_id and h.incident_id=s.incident_id and h.mode=s.mode join public.sentinel_document_versions v on v.organization_id=h.organization_id and v.incident_id=h.incident_id and v.mode=h.mode and v.id=h.version_id where s.organization_id=p_org and s.incident_id=p_incident and s.mode=p_mode and v.retrieved_at>(p.configuration->>'evaluationAt')::timestamptz)) then raise exception 'Scenario clock changed' using errcode='40001';end if;
 if p_status='completed' and not exists(select 1 from public.sentinel_worker_outputs where run_id=p_run and kind='changes') then raise exception 'Missing publication' using errcode='40001';end if;
 if p_status='completed' and exists(
  select 1 from public.sentinel_source_configs cfg cross join lateral jsonb_array_elements(cfg.configuration->'sources') src
  where cfg.organization_id=p_org and cfg.incident_id=p_incident and cfg.mode=p_mode and cfg.id=r.source_config_revision and (
   not exists(select 1 from public.sentinel_worker_outputs o cross join lateral jsonb_array_elements(o.payload->'versions') ref
    join public.sentinel_document_heads h on h.organization_id=p_org and h.incident_id=p_incident and h.mode=p_mode and h.document_id=(src->>'documentId')::uuid and h.version_id=(ref->>'versionId')::uuid and h.source_config_revision=r.source_config_revision
    where o.run_id=p_run and o.kind='evidence' and ref->>'documentId'=src->>'documentId')
   or not exists(select 1 from public.sentinel_worker_outputs o where o.run_id=p_run and o.kind='claims' and o.payload->>'documentId'=src->>'documentId'
    and exists(select 1 from public.sentinel_document_heads h where h.organization_id=p_org and h.incident_id=p_incident and h.mode=p_mode and h.document_id=(src->>'documentId')::uuid and h.version_id=(o.payload->>'versionId')::uuid)
    and (exists(select 1 from public.sentinel_claim_publications pub where pub.organization_id=p_org and pub.incident_id=p_incident and pub.mode=p_mode and pub.run_id=p_run and pub.payload->'versionIds' @> jsonb_build_array(o.payload->>'versionId'))
      or (o.payload->'reused'='true'::jsonb and jsonb_array_length(o.payload->'claims')>0 and not exists(select 1 from jsonb_array_elements(o.payload->'claims') c where not exists(select 1 from public.sentinel_claims stored where stored.organization_id=p_org and stored.incident_id=p_incident and stored.mode=p_mode and stored.id=(c->>'id')::uuid and stored.document_version_id=(o.payload->>'versionId')::uuid)))))))
 then raise exception 'Incomplete current source extraction' using errcode='40001';end if;
 if p_status='completed' and exists(select 1 from public.sentinel_source_change_markers m where m.organization_id=p_org and m.incident_id=p_incident and m.mode=p_mode and m.run_id=p_run and not exists(select 1 from public.sentinel_changes c where c.organization_id=p_org and c.incident_id=p_incident and c.mode=p_mode and c.marker_id=m.id and c.run_id=p_run)) then raise exception 'Missing change publication' using errcode='40001';end if;
 update public.sentinel_runs set status=p_status,stage=p_code,lease_owner=null,lease_until=null,fence=fence+1 where id=p_run returning * into r;
 return public.sentinel_run_view(r);
end;$$;

revoke all on function public.sentinel_worker_locator(uuid),public.sentinel_dispatch_state(uuid),public.sentinel_claim_dispatch(uuid,uuid,uuid,boolean),public.sentinel_ack_dispatch(uuid,uuid,text),public.sentinel_read_worker(uuid,uuid,text,uuid,uuid,bigint),public.sentinel_save_worker_output(uuid,uuid,text,uuid,uuid,bigint,integer,text,text,text,text),public.sentinel_finish_worker(uuid,uuid,text,uuid,uuid,bigint,text,text) from public,anon,authenticated;
grant execute on function public.sentinel_worker_locator(uuid),public.sentinel_dispatch_state(uuid),public.sentinel_claim_dispatch(uuid,uuid,uuid,boolean),public.sentinel_ack_dispatch(uuid,uuid,text),public.sentinel_read_worker(uuid,uuid,text,uuid,uuid,bigint),public.sentinel_save_worker_output(uuid,uuid,text,uuid,uuid,bigint,integer,text,text,text,text),public.sentinel_finish_worker(uuid,uuid,text,uuid,uuid,bigint,text,text) to service_role;
