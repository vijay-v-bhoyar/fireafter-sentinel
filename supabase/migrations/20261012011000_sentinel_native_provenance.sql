create table public.sentinel_native_signing_keys (
 organization_id uuid not null references public.organizations(id),id uuid not null,
 secret_key bytea not null check(octet_length(secret_key)=32),authority_evidence_hash text not null check(authority_evidence_hash ~ '^[a-f0-9]{64}$'),
 valid_from timestamptz not null,valid_until timestamptz not null,revoked_at timestamptz,
 primary key(organization_id,id),check(isfinite(valid_from) and isfinite(valid_until) and valid_until>valid_from),
 check(revoked_at is null or isfinite(revoked_at))
);
alter table public.sentinel_native_signing_keys enable row level security;
revoke all on public.sentinel_native_signing_keys from public,anon,authenticated,service_role;
create function public.sentinel_preserve_native_key() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 if tg_op='DELETE' then raise exception 'Native key history is retained' using errcode='42501';end if;
 if new.organization_id<>old.organization_id or new.id<>old.id or new.secret_key<>old.secret_key or new.authority_evidence_hash<>old.authority_evidence_hash
  or new.valid_from<>old.valid_from or new.valid_until<>old.valid_until or old.revoked_at is not null or new.revoked_at is null then
  raise exception 'Only first native key revocation is permitted' using errcode='42501';end if;
 return new;
end;$$;
create trigger sentinel_native_key_history before update or delete on public.sentinel_native_signing_keys for each row execute function public.sentinel_preserve_native_key();
revoke all on function public.sentinel_preserve_native_key() from public,anon,authenticated,service_role;

-- RFC2104 HMAC-SHA256 using built-in SHA256; does not depend on optional extensions.
create function public.sentinel_hmac_sha256(p_key bytea,p_message bytea) returns bytea
language plpgsql immutable strict set search_path=pg_catalog as $$
declare key_bytes bytea:=p_key;inner_pad bytea:=decode(repeat('00',64),'hex');outer_pad bytea:=decode(repeat('00',64),'hex');b integer;i integer;
begin
 if octet_length(key_bytes)>64 then key_bytes:=sha256(key_bytes);end if;
 for i in 0..63 loop
  b:=case when i<octet_length(key_bytes) then get_byte(key_bytes,i) else 0 end;
  inner_pad:=set_byte(inner_pad,i,b # 54);outer_pad:=set_byte(outer_pad,i,b # 92);
 end loop;
 return sha256(outer_pad||sha256(inner_pad||p_message));
end;$$;
revoke all on function public.sentinel_hmac_sha256(bytea,bytea) from public,anon,authenticated,service_role;

create function public.sentinel_native_binding_valid(n public.source_snapshots,p_org uuid,p_incident uuid,p_mode text,p_now timestamptz) returns boolean
language plpgsql security definer set search_path=pg_catalog,public as $$
declare binding jsonb;frame jsonb;frame_text text;key_row public.sentinel_native_signing_keys%rowtype;expected jsonb;record jsonb;message text;stamp timestamptz;
begin
 if n.incident_id<>p_incident or p_mode not in ('live','replay','synthetic') or n.raw_payload->>'sentinelMode' is distinct from p_mode or n.raw_payload->>'dataOrigin' is distinct from p_mode then return false;end if;
 binding:=n.raw_payload->'sentinelNativeBinding';
 if jsonb_typeof(binding) is distinct from 'object' or binding->>'schemaVersion' is distinct from '1' or binding->>'organizationId' is distinct from p_org::text
  or binding->>'mode' is distinct from p_mode or coalesce(binding->>'signature','') !~ '^[a-f0-9]{64}$' then return false;end if;
 frame_text:=binding->>'frame';if frame_text is null or octet_length(frame_text)>1048576 then return false;end if;
 -- Hold authority through the calling transaction so a concurrent owner revocation cannot race acceptance.
 select * into key_row from public.sentinel_native_signing_keys where organization_id=p_org and id=(binding->>'keyId')::uuid for share;
 stamp:=clock_timestamp();
 if not found or key_row.revoked_at is not null or stamp<key_row.valid_from or stamp>=key_row.valid_until then return false;end if;
 frame:=frame_text::jsonb;if jsonb_typeof(frame) is distinct from 'object' then return false;end if;
 if (frame->>'fetched_at')::timestamptz is distinct from n.fetched_at or (frame->>'source_updated_at')::timestamptz is distinct from n.source_updated_at then return false;end if;
 record:=to_jsonb(n);
 expected:=jsonb_build_object('id',n.id,'incident_id',n.incident_id,'source_name',n.source_name,
  'fetched_at',to_char(n.fetched_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'source_updated_at',case when n.source_updated_at is null then null else to_char(n.source_updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
  'status',n.status,'stale',n.stale,'freshness_label',n.freshness_label,'source_key',record->'source_key','source_url',record->'source_url',
  'coverage_status',record->'coverage_status','warnings',record->'warnings','derived_signals',record->'derived_signals','raw_payload',n.raw_payload-'sentinelNativeBinding');
 if frame<>expected then return false;end if;
 message:=key_row.id::text||E'\n'||p_org::text||E'\n'||p_incident::text||E'\n'||p_mode||E'\n'||frame_text;
 return encode(public.sentinel_hmac_sha256(key_row.secret_key,convert_to(message,'UTF8')),'hex')=binding->>'signature'
  and clock_timestamp()<key_row.valid_until;
exception when others then return false;
end;$$;
revoke all on function public.sentinel_native_binding_valid(public.source_snapshots,uuid,uuid,text,timestamptz) from public,anon,authenticated,service_role;

create or replace function public.sentinel_plan_admission(p_org uuid,p_incident uuid,p_mode text,p_revision uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog set timezone='UTC' as $$
declare s public.sentinel_incident_state%rowtype;p public.sentinel_policies%rowtype;r public.sentinel_plan_revisions%rowtype;
 v public.sentinel_document_versions%rowtype;event public.sentinel_retrieval_events%rowtype;n public.source_snapshots%rowtype;
 ctx jsonb;rule jsonb;issues jsonb;blockers jsonb:='[]'::jsonb;documents jsonb:='[]'::jsonb;natives jsonb:='[]'::jsonb;
 stamp timestamptz;basis text:='database';until_at timestamptz;payload jsonb;inner_payload jsonb;current_id uuid;current_hash text;
begin
 select * into s from public.sentinel_incident_state where organization_id=p_org and incident_id=p_incident and mode=p_mode;
 select * into r from public.sentinel_plan_revisions where organization_id=p_org and incident_id=p_incident and mode=p_mode and id=p_revision;
 if s.organization_id is null or r.id is null then return null;end if;
 select current_revision_id into current_id from public.sentinel_plan_status where organization_id=p_org and incident_id=p_incident and mode=p_mode;
 select * into p from public.sentinel_policies where organization_id=p_org and incident_id=p_incident and mode=p_mode and id=s.current_policy_revision;
 if current_id is distinct from r.id then blockers:=blockers||'"proposal_superseded"'::jsonb;end if;
 if s.current_constraint_revision is distinct from r.constraint_revision_id then blockers:=blockers||'"constraints_changed"'::jsonb;
 else
  begin
   ctx:=public.sentinel_plan_context(p_org,p_incident,p_mode,r.body->'taskDependencies');
   current_hash:=ctx->>'evidenceVectorHash';
   blockers:=blockers||(select coalesce(jsonb_agg(value),'[]'::jsonb) from jsonb_array_elements(ctx->'blockers') where value#>>'{}' not in('policy_not_qualified','native_evidence_not_qualified'));
  exception when insufficient_privilege or invalid_parameter_value or serialization_failure then blockers:=blockers||'"snapshot_unavailable"'::jsonb;
  end;
 end if;
 if r.evidence_generation<>s.evidence_generation or current_hash is distinct from r.evidence_vector_hash then blockers:=blockers||'"evidence_changed"'::jsonb;end if;
 if not exists(select 1 from public.sentinel_constraints c where c.organization_id=p_org and c.incident_id=p_incident and c.mode=p_mode and c.id=r.constraint_revision_id
    and r.body->'allocation'->>'status'='feasible' and public.sentinel_plan_assignments_valid(c.configuration,r.body->'allocation'->'assignments'))
   then blockers:=blockers||'"allocation_not_feasible"'::jsonb;end if;
 -- This wall-clock read is deliberately after all preview/commit locks and context acquisition.
 stamp:=clock_timestamp();
 if p.id is null then blockers:=blockers||'"policy_missing"'::jsonb;
 else
  if p_mode<>'live' then stamp:=public.sentinel_policy_instant(p.configuration->'evaluationAt');basis:='scenario';end if;
  if p.id::text is distinct from r.body->>'policyRevisionId' or p.source_config_revision is distinct from s.current_source_config_revision then blockers:=blockers||'"policy_changed"'::jsonb;end if;
  if s.unresolved_source_change_count<>0 then blockers:=blockers||'"source_reviews_pending"'::jsonb;end if;
  for rule in select value from jsonb_array_elements(p.configuration->'documentRules') loop
   issues:='[]'::jsonb;
   select ver.* into v from public.sentinel_document_heads h join public.sentinel_document_versions ver on ver.organization_id=h.organization_id and ver.incident_id=h.incident_id and ver.mode=h.mode and ver.id=h.version_id
    where h.organization_id=p_org and h.incident_id=p_incident and h.mode=p_mode and h.document_id=(rule->>'documentId')::uuid and h.source_config_revision=p.source_config_revision;
   if not found then issues:=issues||'"document_missing"'::jsonb;
   else
    select * into event from public.sentinel_retrieval_events where organization_id=p_org and incident_id=p_incident and mode=p_mode and document_id=v.document_id and source_config_revision=p.source_config_revision order by event_sequence desc limit 1;
    if not found or event.outcome not in('version','same_version') or event.checked_version_id is distinct from v.id then issues:=issues||'"document_check_incomplete"'::jsonb;
    elsif event.completed_at>stamp or event.requested_at>stamp or v.retrieved_at>stamp then issues:=issues||'"document_check_in_future"'::jsonb;
    elsif stamp>=event.completed_at+(rule->>'maxAgeMinutes')::int*interval '1 minute' then issues:=issues||'"document_check_expired"'::jsonb;end if;
    if v.availability<>'available' or v.content_permission<>'full_text' or v.normalized_text is null then issues:=issues||'"document_coverage_unavailable"'::jsonb;end if;
    if v.published_at>stamp then issues:=issues||'"document_publication_in_future"'::jsonb;end if;
    if (rule->>'requirePublicationTime')::boolean and v.published_at is null then issues:=issues||'"document_publication_unknown"'::jsonb;end if;
    if (rule->>'requireEffectiveInterval')::boolean and (v.effective_from is null or v.effective_until is null) then issues:=issues||'"document_effective_unknown"'::jsonb;end if;
    if v.effective_from>stamp or v.effective_until<=stamp then issues:=issues||'"document_not_effective"'::jsonb;end if;
    if not exists(select 1 from public.sentinel_claim_publications x where x.organization_id=p_org and x.incident_id=p_incident and x.mode=p_mode and x.payload->'versionIds' @> jsonb_build_array(v.id::text))
     then issues:=issues||'"document_extraction_missing"'::jsonb;end if;
   end if;
   documents:=documents||jsonb_build_array(jsonb_build_object('documentId',rule->>'documentId','versionId',v.id,'issues',issues));blockers:=blockers||issues;
  end loop;
  for rule in select value from jsonb_array_elements(p.configuration->'nativeRules') loop
   issues:='[]'::jsonb;until_at:=null;
   select x.* into n from public.source_snapshots x where x.incident_id=p_incident and coalesce(to_jsonb(x)->>'source_key',x.raw_payload->>'sourceKey')=rule->>'sourceKey' order by x.fetched_at desc,x.id desc limit 1;
   if not found then issues:=issues||'"native_source_missing"'::jsonb;
   else
    payload:=n.raw_payload;inner_payload:=coalesce(payload->'rawPayload',payload);
    if not public.sentinel_native_binding_valid(n,p_org,p_incident,p_mode,clock_timestamp()) then issues:=issues||'"native_mode_unbound"'::jsonb;end if;
    if n.status<>'online' or n.stale or coalesce(to_jsonb(n)->>'coverage_status',payload->>'coverageStatus') is distinct from 'available' then issues:=issues||'"native_coverage_unavailable"'::jsonb;end if;
    if n.fetched_at>stamp then issues:=issues||'"native_check_in_future"'::jsonb;
    elsif stamp>=n.fetched_at+(rule->>'maxAgeMinutes')::int*interval '1 minute' then issues:=issues||'"native_check_expired"'::jsonb;end if;
    if n.source_updated_at>stamp then issues:=issues||'"native_publication_in_future"'::jsonb;end if;
    if (rule->>'requireProviderTime')::boolean and (n.source_updated_at is null or payload->>'sourceTimeBasis' is distinct from 'provider') then issues:=issues||'"native_provider_time_unknown"'::jsonb;end if;
    begin until_at:=public.sentinel_policy_instant(payload->'validUntil');
    exception when invalid_parameter_value or data_exception then issues:=issues||'"native_validity_invalid"'::jsonb;end;
    if (rule->>'requireValidUntil')::boolean and until_at is null then issues:=issues||'"native_validity_unknown"'::jsonb;end if;
    if until_at<=stamp then issues:=issues||'"native_validity_expired"'::jsonb;end if;
    if rule->>'sourceKey'='usgs-pwfdf' and inner_payload->>'analysisGeometryVersion' is distinct from '2026-09-14-provider-resolution-v1' then issues:=issues||'"native_geometry_unqualified"'::jsonb;end if;
    if rule->>'sourceKey'='mtbs-burn-severity' and inner_payload->>'interpretationVersion' is distinct from '2026-09-12-source-semantics-v1' then issues:=issues||'"native_interpretation_unqualified"'::jsonb;end if;
   end if;
   natives:=natives||jsonb_build_array(jsonb_build_object('sourceKey',rule->>'sourceKey','snapshotId',n.id,'issues',issues));blockers:=blockers||issues;
  end loop;
 end if;
 select coalesce(jsonb_agg(value order by value),'[]'::jsonb) into blockers from(select distinct value from jsonb_array_elements(blockers)) b;
 return jsonb_build_object('scope',jsonb_build_object('organizationId',p_org,'incidentId',p_incident,'mode',p_mode),'planRevisionId',r.id,'policyRevisionId',p.id,
  'currentPlanRevisionId',current_id,'evidenceGeneration',s.evidence_generation,'evidenceVectorHash',current_hash,
  'checkedAt',to_char(stamp at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'timeBasis',basis,'eligible',jsonb_array_length(blockers)=0,'approvalReady',false,
  'blockers',blockers,'documentChecks',documents,'nativeChecks',natives);
end;$$;
