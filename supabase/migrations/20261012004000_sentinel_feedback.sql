-- Optional corrections are part of the original review transaction. Grants are owner-provisioned, never browser consent.
begin;
create table public.sentinel_permission_records (
 organization_id uuid not null, incident_id uuid not null, mode text not null, id uuid not null,
 data_owner_id uuid not null references auth.users(id), grantee_actor_id uuid not null references auth.users(id),
 purpose text not null check(purpose='offline_internal_evaluation'), destination text not null check(destination='sentinel_internal_evaluation'),
 retention_policy_revision uuid not null, authority_evidence_hash text not null check(authority_evidence_hash ~ '^[a-f0-9]{64}$'),
 granted_at timestamptz not null, expires_at timestamptz not null, revoked_at timestamptz,
 primary key(organization_id,incident_id,mode,id),
 foreign key(organization_id,incident_id,mode) references public.sentinel_incident_state(organization_id,incident_id,mode),
 check(expires_at>granted_at),check(revoked_at is null or revoked_at>=granted_at)
);
create function public.sentinel_permission_revoke_only() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 if (to_jsonb(new)-'revoked_at')<>(to_jsonb(old)-'revoked_at') or old.revoked_at is not null or new.revoked_at is null or new.revoked_at>clock_timestamp()
 then raise exception 'Permission grants are immutable; only first revocation is permitted' using errcode='22023';end if;
 return new;
end;$$;
revoke all on function public.sentinel_permission_revoke_only() from public,anon,authenticated,service_role;
create trigger sentinel_permission_revoke_only before update on public.sentinel_permission_records for each row execute function public.sentinel_permission_revoke_only();
create trigger sentinel_permission_no_delete before delete on public.sentinel_permission_records for each row execute function public.sentinel_reject_evidence_mutation();
create table public.sentinel_feedback_observations (
 organization_id uuid not null,incident_id uuid not null,mode text not null,id uuid not null,actor_id uuid not null,command_id uuid not null,
 review_kind text not null check(review_kind in('claim','plan')),claim_id uuid not null,document_version_id uuid not null,
 claim_review_id uuid,review_decision_id uuid,permission_record_id uuid,payload jsonb not null,body jsonb not null,
 primary key(organization_id,incident_id,mode,id),unique(organization_id,incident_id,mode,actor_id,review_kind,command_id),
 unique(organization_id,incident_id,mode,claim_review_id),unique(organization_id,incident_id,mode,review_decision_id),
 foreign key(organization_id,incident_id,mode,claim_id) references public.sentinel_claims(organization_id,incident_id,mode,id),
 foreign key(organization_id,incident_id,mode,document_version_id) references public.sentinel_document_versions(organization_id,incident_id,mode,id),
 foreign key(organization_id,incident_id,mode,claim_review_id) references public.sentinel_claim_reviews(organization_id,incident_id,mode,id),
 foreign key(organization_id,incident_id,mode,review_decision_id) references public.sentinel_decisions(organization_id,incident_id,mode,id),
 foreign key(organization_id,incident_id,mode,permission_record_id) references public.sentinel_permission_records(organization_id,incident_id,mode,id),
 check((review_kind='claim' and claim_review_id is not null and review_decision_id is null) or (review_kind='plan' and review_decision_id is not null and claim_review_id is null)),
 check(octet_length(payload::text)<=16384 and octet_length(body::text)<=16384)
);
create unique index sentinel_feedback_final_admission_once on public.sentinel_decision_audit(organization_id,incident_id,mode,decision_id) where body->>'kind'='feedback_final_admission';
create trigger sentinel_feedback_immutable before update or delete on public.sentinel_feedback_observations for each row execute function public.sentinel_reject_evidence_mutation();
alter table public.sentinel_feedback_observations enable row level security;
alter table public.sentinel_permission_records enable row level security;
revoke all on public.sentinel_feedback_observations,public.sentinel_permission_records from public,anon,authenticated,service_role;

create function public.sentinel_feedback_input_valid(f jsonb) returns boolean language plpgsql immutable set search_path=pg_catalog as $$
declare k text;
begin
 if jsonb_typeof(f) is distinct from 'object' or octet_length(f::text)>16384 or f->'schemaVersion' is distinct from '1'::jsonb
 or (select count(*) from jsonb_object_keys(f))<>7
 or f-array['schemaVersion','claimId','originalClaimHash','correctedClaimText','correctedClaimId','reasonCode','permissionRecordId']<>'{}'::jsonb
 or jsonb_typeof(f->'originalClaimHash') is distinct from 'string' or f->>'originalClaimHash' !~ '^[a-f0-9]{64}$'
 or jsonb_typeof(f->'reasonCode') is distinct from 'string' or f->>'reasonCode' not in('identity_error','time_error','unsupported_claim','constraint_error','not_material','other')
 or jsonb_typeof(f->'correctedClaimText') not in('string','null')
 or ((f->>'correctedClaimText' is not null)=(f->>'correctedClaimId' is not null))
 or (f->>'correctedClaimText' is not null and (length(btrim(f->>'correctedClaimText'))=0 or octet_length(f->>'correctedClaimText')>2048))
 or f->>'correctedClaimId'=f->>'claimId' then return false;end if;
 for k in select unnest(array['claimId','correctedClaimId','permissionRecordId']) loop
  if jsonb_typeof(f->k) not in('string','null') or (k='claimId' and jsonb_typeof(f->k)<>'string')
   or (f->>k is not null and f->>k !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then return false;end if;
 end loop;
 return true;
end;$$;
revoke all on function public.sentinel_feedback_input_valid(jsonb) from public,anon,authenticated,service_role;

-- Called only by authenticated review wrappers after the core's locked command and before commit.
create function public.sentinel_append_feedback(p_actor uuid,p_org uuid,p_incident uuid,p_mode text,p_command uuid,p_kind text,p_feedback jsonb,p_result jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare f public.sentinel_feedback_observations%rowtype;c public.sentinel_claims%rowtype;review_id uuid;receipt_id uuid;policy_id uuid;body jsonb;final_check jsonb;final_body jsonb;
begin
 select * into f from public.sentinel_feedback_observations where organization_id=p_org and incident_id=p_incident and mode=p_mode and actor_id=p_actor and review_kind=p_kind and command_id=p_command;
 if p_feedback is null then
  if found then raise exception 'Feedback command changed' using errcode='40001';end if;return p_result;
 end if;
 if found then
  if f.payload<>p_feedback then raise exception 'Feedback command changed' using errcode='40001';end if;
  select a.body->'finalValidation' into final_body from public.sentinel_decision_audit a where a.organization_id=p_org and a.incident_id=p_incident and a.mode=p_mode and a.decision_id=f.review_decision_id and a.body->>'kind'='feedback_final_admission';
  return p_result||jsonb_build_object('feedback',f.body)||case when final_body is null then '{}'::jsonb else jsonb_build_object('finalValidation',final_body) end;
 end if;
 if p_result->>'replayed'='true' then raise exception 'Feedback cannot be added to a historical command' using errcode='40001';end if;
 if not public.sentinel_feedback_input_valid(p_feedback) then raise exception 'Invalid feedback' using errcode='22023';end if;
 select * into c from public.sentinel_claims where organization_id=p_org and incident_id=p_incident and mode=p_mode and id=(p_feedback->>'claimId')::uuid;
 if not found then raise exception 'Feedback unavailable' using errcode='42501';end if;
 if encode(sha256(convert_to(c.body->>'claimText','UTF8')),'hex')<>p_feedback->>'originalClaimHash' then raise exception 'Feedback claim changed' using errcode='40001';end if;
 if p_kind='claim' then
  if c.id<>(p_result->'review'->>'claimId')::uuid then raise exception 'Feedback unavailable' using errcode='42501';end if;
  review_id:=(p_result->'review'->>'id')::uuid;
  select current_policy_revision into policy_id from public.sentinel_incident_state where organization_id=p_org and incident_id=p_incident and mode=p_mode;
 else
  review_id:=(p_result->'decision'->>'id')::uuid;policy_id:=(p_result->'decision'->>'policyRevisionId')::uuid;
  if not exists(select 1 from public.sentinel_plan_dependencies where organization_id=p_org and incident_id=p_incident and mode=p_mode and revision_id=(p_result->'decision'->>'planRevisionId')::uuid and claim_id=c.id)
  then raise exception 'Feedback unavailable' using errcode='42501';end if;
 end if;
 if p_feedback->>'correctedClaimId' is not null and not exists(select 1 from public.sentinel_claims where organization_id=p_org and incident_id=p_incident and mode=p_mode and id=(p_feedback->>'correctedClaimId')::uuid and document_version_id=c.document_version_id)
 then raise exception 'Correction unavailable' using errcode='42501';end if;
 if p_feedback->>'permissionRecordId' is not null then
  perform 1 from public.sentinel_permission_records where organization_id=p_org and incident_id=p_incident and mode=p_mode and id=(p_feedback->>'permissionRecordId')::uuid for share;
  if not found then raise exception 'Permission unavailable' using errcode='42501';end if;
 end if;
 receipt_id:=(p_result->'receipt'->>'id')::uuid;
 body:=jsonb_build_object('id',gen_random_uuid(),'scope',jsonb_build_object('organizationId',p_org,'incidentId',p_incident,'mode',p_mode),
  'claimId',c.id,'documentVersionId',c.document_version_id,'runId',c.run_id,'modelVersion',c.body->>'modelVersion','promptVersion',c.body->>'promptVersion','policyRevisionId',policy_id,
  'originalClaimHash',p_feedback->>'originalClaimHash','correctedClaimText',p_feedback->>'correctedClaimText','correctedClaimId',p_feedback->>'correctedClaimId','reasonCode',p_feedback->>'reasonCode',
  'reviewKind',p_kind,'claimReviewId',case when p_kind='claim' then review_id end,'reviewDecisionId',case when p_kind='plan' then review_id end,
  'receiptId',receipt_id,'actorId',p_actor,'createdAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'permissionRecordId',p_feedback->>'permissionRecordId');
 insert into public.sentinel_feedback_observations(organization_id,incident_id,mode,id,actor_id,command_id,review_kind,claim_id,document_version_id,claim_review_id,review_decision_id,permission_record_id,payload,body)
 values(p_org,p_incident,p_mode,(body->>'id')::uuid,p_actor,p_command,p_kind,c.id,c.document_version_id,case when p_kind='claim' then review_id end,case when p_kind='plan' then review_id end,(p_feedback->>'permissionRecordId')::uuid,p_feedback,body);
 -- Feedback triggers may take time or affect native evidence. Approval must remain eligible at this last validation.
 if p_kind='plan' and p_result->'decision'->>'action'='accept' then
  final_check:=public.sentinel_plan_admission(p_org,p_incident,p_mode,(p_result->'decision'->>'planRevisionId')::uuid);
  if final_check->>'eligible'<>'true' then raise exception 'Evidence changed during feedback persistence' using errcode='40001';end if;
  final_body:=jsonb_build_object('kind','final_admission','decisionId',review_id,'planRevisionId',p_result->'decision'->>'planRevisionId','checkedAt',final_check->>'checkedAt',
   'timeBasis',final_check->>'timeBasis','evidenceVectorHash',final_check->>'evidenceVectorHash','eligible',true);
  -- Append the last check without rewriting the signal, original decision or audit.
  insert into public.sentinel_decision_audit(organization_id,incident_id,mode,id,decision_id,body) values(p_org,p_incident,p_mode,gen_random_uuid(),review_id,
   jsonb_build_object('kind','feedback_final_admission','feedbackId',body->>'id','finalValidation',final_body));
 end if;
 return p_result||jsonb_build_object('feedback',body)||case when final_body is null then '{}'::jsonb else jsonb_build_object('finalValidation',final_body) end;
end;$$;
revoke all on function public.sentinel_append_feedback(uuid,uuid,uuid,text,uuid,text,jsonb,jsonb) from public,anon,authenticated,service_role;

alter function public.sentinel_record_claim_review(uuid,uuid,uuid,text,uuid,uuid,jsonb) rename to sentinel_record_claim_review_core;
revoke all on function public.sentinel_record_claim_review_core(uuid,uuid,uuid,text,uuid,uuid,jsonb) from public,anon,authenticated,service_role;
create function public.sentinel_record_claim_review(p_actor_id uuid,p_organization_id uuid,p_incident_id uuid,p_mode text,p_claim_id uuid,p_command_id uuid,p_review jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare r jsonb;f jsonb;
begin
 if p_review ? 'feedback' then f:=p_review->'feedback';if not public.sentinel_feedback_input_valid(f) then raise exception 'Invalid feedback' using errcode='22023';end if;end if;
 r:=public.sentinel_record_claim_review_core(p_actor_id,p_organization_id,p_incident_id,p_mode,p_claim_id,p_command_id,p_review-'feedback');
 return public.sentinel_append_feedback(p_actor_id,p_organization_id,p_incident_id,p_mode,p_command_id,'claim',f,r);
end;$$;
revoke all on function public.sentinel_record_claim_review(uuid,uuid,uuid,text,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.sentinel_record_claim_review(uuid,uuid,uuid,text,uuid,uuid,jsonb) to service_role;
alter function public.sentinel_record_decision(uuid,uuid,uuid,text,uuid,jsonb) rename to sentinel_record_decision_core;
revoke all on function public.sentinel_record_decision_core(uuid,uuid,uuid,text,uuid,jsonb) from public,anon,authenticated,service_role;
create function public.sentinel_record_decision(p_actor_id uuid,p_organization_id uuid,p_incident_id uuid,p_mode text,p_revision_id uuid,p_command jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare r jsonb;f jsonb;
begin
 if p_command ? 'feedback' then f:=p_command->'feedback';if not public.sentinel_feedback_input_valid(f) then raise exception 'Invalid feedback' using errcode='22023';end if;end if;
 r:=public.sentinel_record_decision_core(p_actor_id,p_organization_id,p_incident_id,p_mode,p_revision_id,p_command-'feedback');
 return public.sentinel_append_feedback(p_actor_id,p_organization_id,p_incident_id,p_mode,(p_command->>'commandId')::uuid,'plan',f,r);
end;$$;
revoke all on function public.sentinel_record_decision(uuid,uuid,uuid,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.sentinel_record_decision(uuid,uuid,uuid,text,uuid,jsonb) to service_role;

alter function public.sentinel_read_claim_review(uuid,uuid,uuid,text,uuid) rename to sentinel_read_claim_review_core;
revoke all on function public.sentinel_read_claim_review_core(uuid,uuid,uuid,text,uuid) from public,anon,authenticated,service_role;
create function public.sentinel_read_claim_review(p_actor_id uuid,p_organization_id uuid,p_incident_id uuid,p_mode text,p_claim_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare r jsonb;f jsonb;
begin
 r:=public.sentinel_read_claim_review_core(p_actor_id,p_organization_id,p_incident_id,p_mode,p_claim_id);
 if r is null then return null;end if;
 select body into f from public.sentinel_feedback_observations where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and claim_review_id=(r->'review'->>'id')::uuid;
 return r||case when f is null then '{}'::jsonb else jsonb_build_object('feedback',f) end;
end;$$;
revoke all on function public.sentinel_read_claim_review(uuid,uuid,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.sentinel_read_claim_review(uuid,uuid,uuid,text,uuid) to service_role;
alter function public.sentinel_read_decision_command(uuid,uuid,uuid,text,uuid) rename to sentinel_read_decision_command_core;
revoke all on function public.sentinel_read_decision_command_core(uuid,uuid,uuid,text,uuid) from public,anon,authenticated,service_role;
create function public.sentinel_read_decision_command(p_actor_id uuid,p_organization_id uuid,p_incident_id uuid,p_mode text,p_command_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare r jsonb;f public.sentinel_feedback_observations%rowtype;last_check jsonb;
begin
 r:=public.sentinel_read_decision_command_core(p_actor_id,p_organization_id,p_incident_id,p_mode,p_command_id);
 if r is null then return null;end if;
 select * into f from public.sentinel_feedback_observations where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and review_decision_id=(r->'decision'->>'id')::uuid;
 select a.body->'finalValidation' into last_check from public.sentinel_decision_audit a where a.organization_id=p_organization_id and a.incident_id=p_incident_id and a.mode=p_mode and a.decision_id=f.review_decision_id and a.body->>'kind'='feedback_final_admission';
 return r||case when f.id is null then '{}'::jsonb else jsonb_build_object('feedback',f.body) end||case when last_check is null then '{}'::jsonb else jsonb_build_object('finalValidation',last_check) end;
end;$$;
revoke all on function public.sentinel_read_decision_command(uuid,uuid,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.sentinel_read_decision_command(uuid,uuid,uuid,text,uuid) to service_role;

-- Exact owner grant, destination, retention version, grantee, membership and current clock. No network or provider operation.
create function public.sentinel_read_feedback_for_evaluation(p_actor_id uuid,p_organization_id uuid,p_incident_id uuid,p_mode text,p_feedback_id uuid,p_destination text,p_retention_revision uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare f public.sentinel_feedback_observations%rowtype;g public.sentinel_permission_records%rowtype;t timestamptz;
begin
 perform 1 from public.organization_members where organization_id=p_organization_id and user_id=p_actor_id and role='incident_commander' for share;
 if not found then raise exception 'Evaluation unavailable' using errcode='42501';end if;
 select * into f from public.sentinel_feedback_observations where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and id=p_feedback_id;
 if not found or f.permission_record_id is null then return null;end if;
 select * into g from public.sentinel_permission_records where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and id=f.permission_record_id for share;
 t:=clock_timestamp();
 if not found or g.grantee_actor_id<>p_actor_id or g.purpose<>'offline_internal_evaluation' or g.destination is distinct from p_destination
  or g.retention_policy_revision is distinct from p_retention_revision or g.revoked_at is not null or g.granted_at>t or g.expires_at<=t then return null;end if;
 return f.body;
end;$$;
revoke all on function public.sentinel_read_feedback_for_evaluation(uuid,uuid,uuid,text,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.sentinel_read_feedback_for_evaluation(uuid,uuid,uuid,text,uuid,text,uuid) to service_role;
commit;
