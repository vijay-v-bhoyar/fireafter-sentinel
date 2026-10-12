begin;
create table public.sentinel_decisions (
 organization_id uuid not null,incident_id uuid not null,mode text not null,id uuid not null,revision_id uuid not null,
 body jsonb not null,evidence_snapshot jsonb not null,primary key(organization_id,incident_id,mode,id),
 foreign key(organization_id,incident_id,mode,revision_id) references public.sentinel_plan_revisions(organization_id,incident_id,mode,id),
 check(octet_length(body::text)<=131072),check(octet_length(evidence_snapshot::text)<=1048576));
create table public.sentinel_command_receipts (
 organization_id uuid not null,incident_id uuid not null,mode text not null,actor_id uuid not null,command_id uuid not null,decision_id uuid not null,
 payload jsonb not null,receipt jsonb not null,primary key(organization_id,incident_id,mode,actor_id,command_id),
 foreign key(organization_id,incident_id,mode,decision_id) references public.sentinel_decisions(organization_id,incident_id,mode,id),check(octet_length(payload::text)<=131072));
create table public.sentinel_decision_status (
 organization_id uuid not null,incident_id uuid not null,mode text not null,revision_id uuid not null,decision_id uuid not null,
 outcome text not null check(outcome in('approved','rejected')),primary key(organization_id,incident_id,mode,revision_id),
 foreign key(organization_id,incident_id,mode,revision_id) references public.sentinel_plan_revisions(organization_id,incident_id,mode,id),
 foreign key(organization_id,incident_id,mode,decision_id) references public.sentinel_decisions(organization_id,incident_id,mode,id));
create table public.sentinel_decision_audit (
 organization_id uuid not null,incident_id uuid not null,mode text not null,id uuid not null,decision_id uuid not null,body jsonb not null,
 primary key(organization_id,incident_id,mode,id),foreign key(organization_id,incident_id,mode,decision_id) references public.sentinel_decisions(organization_id,incident_id,mode,id));
create unique index sentinel_final_admission_once on public.sentinel_decision_audit(organization_id,incident_id,mode,decision_id) where body->>'kind'='final_admission';
alter table public.sentinel_incident_state add column current_approved_plan_revision uuid;
alter table public.sentinel_incident_state add constraint sentinel_current_approved_fk foreign key(organization_id,incident_id,mode,current_approved_plan_revision)
 references public.sentinel_plan_revisions(organization_id,incident_id,mode,id);
alter table public.sentinel_decisions enable row level security;
alter table public.sentinel_command_receipts enable row level security;
alter table public.sentinel_decision_status enable row level security;
alter table public.sentinel_decision_audit enable row level security;
create trigger sentinel_decisions_immutable before update or delete on public.sentinel_decisions for each row execute function public.sentinel_reject_evidence_mutation();
create trigger sentinel_command_receipts_immutable before update or delete on public.sentinel_command_receipts for each row execute function public.sentinel_reject_evidence_mutation();
create trigger sentinel_decision_status_immutable before update or delete on public.sentinel_decision_status for each row execute function public.sentinel_reject_evidence_mutation();
create trigger sentinel_decision_audit_immutable before update or delete on public.sentinel_decision_audit for each row execute function public.sentinel_reject_evidence_mutation();
revoke all on public.sentinel_decisions,public.sentinel_command_receipts,public.sentinel_decision_status,public.sentinel_decision_audit from public,anon,authenticated,service_role;

create function public.sentinel_decision_command_valid(c jsonb) returns boolean language plpgsql immutable set search_path=pg_catalog as $$
begin
 if c is null or jsonb_typeof(c)<>'object' or (select count(*) from jsonb_object_keys(c))<>9
  or not(c ?& array['expectedPlanRevision','expectedEvidenceGeneration','expectedEvidenceVectorHash','expectedConstraintRevision','expectedPolicyRevision','action','note','modifications','commandId'])
  or c->>'action' not in('accept','reject','modify','annotate') or jsonb_typeof(c->'action')<>'string'
  or jsonb_typeof(c->'note')<>'string' or btrim(c->>'note')='' or octet_length(c->>'note')>2048
  or jsonb_typeof(c->'expectedPlanRevision')<>'string' or c->>'expectedPlanRevision' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  or jsonb_typeof(c->'expectedConstraintRevision')<>'string' or c->>'expectedConstraintRevision' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  or jsonb_typeof(c->'commandId')<>'string' or c->>'commandId' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  or jsonb_typeof(c->'expectedPolicyRevision') not in('string','null')
  or (jsonb_typeof(c->'expectedPolicyRevision')='string' and c->>'expectedPolicyRevision' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')
  or jsonb_typeof(c->'expectedEvidenceGeneration')<>'number' or (c->>'expectedEvidenceGeneration')::numeric<>trunc((c->>'expectedEvidenceGeneration')::numeric)
  or (c->>'expectedEvidenceGeneration')::numeric not between 0 and 9007199254740991
  or c->>'expectedEvidenceVectorHash' !~ '^[a-f0-9]{64}$' or jsonb_typeof(c->'expectedEvidenceVectorHash')<>'string'
  or octet_length(c::text)>131072 then return false;end if;
 if c->>'action'='modify' then
  if jsonb_typeof(c->'modifications')<>'object' or (select count(*) from jsonb_object_keys(c->'modifications'))<>1 or not(c->'modifications' ? 'assignments')
   or jsonb_typeof(c->'modifications'->'assignments')<>'array' or jsonb_array_length(c->'modifications'->'assignments') not between 1 and 10 then return false;end if;
 elsif jsonb_typeof(c->'modifications')<>'null' then return false;end if;
 return true;
exception when data_exception then return false;
end;$$;
revoke all on function public.sentinel_decision_command_valid(jsonb) from public,anon,authenticated,service_role;

create function public.sentinel_record_decision(p_actor_id uuid,p_organization_id uuid,p_incident_id uuid,p_mode text,p_revision_id uuid,p_command jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog set timezone='UTC' as $$
declare s public.sentinel_incident_state%rowtype;r public.sentinel_plan_revisions%rowtype;prior public.sentinel_command_receipts%rowtype;
 d public.sentinel_decisions%rowtype;current_id uuid;role_name text;action_name text;ctx jsonb;admission jsonb;new_plan jsonb;final_validation jsonb;
 decision_id uuid:=gen_random_uuid();receipt_id uuid:=gen_random_uuid();audit_id uuid:=gen_random_uuid();new_revision uuid;stamp text;checked text;body jsonb;receipt jsonb;
begin
 if p_actor_id is null or p_revision_id is null or p_mode not in('live','replay','synthetic') or not coalesce(public.sentinel_decision_command_valid(p_command),false)
  or p_revision_id::text is distinct from p_command->>'expectedPlanRevision' then raise exception 'Invalid decision command' using errcode='22023';end if;
 action_name:=p_command->>'action';
 select role into role_name from public.organization_members where organization_id=p_organization_id and user_id=p_actor_id for share;
 if not found or (action_name in('accept','reject') and role_name<>'incident_commander') or (action_name in('modify','annotate') and role_name not in('incident_commander','analyst'))
  then raise exception 'Decision authority unavailable' using errcode='42501';end if;
 -- Take legacy native/asset write barriers before the Sentinel state lock.
 lock table public.assets,public.source_snapshots in share mode;
 select * into s from public.sentinel_incident_state where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode for update;
 if not found then raise exception 'Decision scope unavailable' using errcode='42501';end if;
 select * into prior from public.sentinel_command_receipts where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and actor_id=p_actor_id and command_id=(p_command->>'commandId')::uuid;
 if found then
  if prior.payload<>jsonb_build_object('revisionId',p_revision_id,'command',p_command) then raise exception 'Decision retry changed' using errcode='40001';end if;
  select * into d from public.sentinel_decisions where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and id=prior.decision_id;
  select a.body into final_validation from public.sentinel_decision_audit a where a.organization_id=p_organization_id and a.incident_id=p_incident_id and a.mode=p_mode and a.decision_id=d.id and a.body->>'kind'='final_admission';
  return jsonb_build_object('decision',d.body,'receipt',prior.receipt,'replayed',true,'finalValidation',final_validation);
 end if;
 select * into r from public.sentinel_plan_revisions where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and id=p_revision_id;
 if not found then raise exception 'Proposal unavailable' using errcode='42501';end if;
 if r.evidence_generation<>(p_command->>'expectedEvidenceGeneration')::bigint or r.evidence_vector_hash<>p_command->>'expectedEvidenceVectorHash'
  or r.constraint_revision_id::text<>p_command->>'expectedConstraintRevision' or r.body->>'policyRevisionId' is distinct from p_command->>'expectedPolicyRevision'
  then raise exception 'Reviewed proposal changed' using errcode='40001';end if;
 select current_revision_id into current_id from public.sentinel_plan_status where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode for update;
 if action_name<>'annotate' and current_id is distinct from r.id then raise exception 'Proposal superseded' using errcode='40001';end if;
 if action_name in('accept','reject') and exists(select 1 from public.sentinel_decision_status where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and revision_id=r.id)
  then raise exception 'Proposal already decided' using errcode='40001';end if;
 if action_name in('accept','modify') then
  if s.evidence_generation<>r.evidence_generation or s.current_constraint_revision is distinct from r.constraint_revision_id or s.current_policy_revision::text is distinct from r.body->>'policyRevisionId'
   then raise exception 'Current evidence changed' using errcode='40001';end if;
  ctx:=public.sentinel_plan_context(p_organization_id,p_incident_id,p_mode,r.body->'taskDependencies');
  if ctx->>'evidenceVectorHash'<>r.evidence_vector_hash then raise exception 'Current evidence changed' using errcode='40001';end if;
 end if;
 if action_name='accept' then
  admission:=public.sentinel_plan_admission(p_organization_id,p_incident_id,p_mode,r.id);
  if admission is null or admission->'eligible' is distinct from 'true'::jsonb then raise exception 'Evidence is not eligible' using errcode='40001';end if;
  checked:=admission->>'checkedAt';
 elsif action_name='modify' then
  if not public.sentinel_plan_assignments_valid(ctx->'constraintRevision'->'configuration',p_command->'modifications'->'assignments') then raise exception 'Invalid complete modification' using errcode='22023';end if;
  new_plan:=public.sentinel_create_plan_draft(p_actor_id,p_organization_id,p_incident_id,p_mode,(p_command->>'commandId')::uuid,r.id,r.constraint_revision_id,r.evidence_generation,r.evidence_vector_hash,
   r.body->'taskDependencies',jsonb_build_object('status','feasible','selectedTaskIds',r.body->'allocation'->'selectedTaskIds','assignments',p_command->'modifications'->'assignments','issues','[]'::jsonb));
  new_revision:=(new_plan->'revision'->>'id')::uuid;
 end if;
 stamp:=to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 checked:=coalesce(checked,stamp);
 body:=jsonb_build_object('id',decision_id,'scope',jsonb_build_object('organizationId',p_organization_id,'incidentId',p_incident_id,'mode',p_mode),'receiptId',receipt_id,'auditId',audit_id,
  'planId',r.plan_id,'planRevisionId',r.id,'newPlanRevisionId',new_revision,'actorId',p_actor_id,'action',action_name,'note',p_command->>'note',
  'reviewedEvidenceGeneration',r.evidence_generation,'reviewedEvidenceVectorHash',r.evidence_vector_hash,'constraintRevisionId',r.constraint_revision_id,'policyRevisionId',r.body->'policyRevisionId',
  'checkedAt',checked,'committedAt',stamp,'timeBasis',case when action_name='accept' then admission->>'timeBasis' else 'database' end);
 receipt:=jsonb_build_object('id',receipt_id,'scope',body->'scope','commandId',p_command->>'commandId','actorId',p_actor_id,'decisionId',decision_id,'auditId',audit_id,
  'reviewedPlanRevision',r.id,'newPlanRevisionId',new_revision,'reviewedEvidenceGeneration',r.evidence_generation,'reviewedEvidenceVectorHash',r.evidence_vector_hash,
  'action',action_name,'checkedAt',checked,'committedAt',stamp);
 insert into public.sentinel_decisions values(p_organization_id,p_incident_id,p_mode,decision_id,r.id,body,r.evidence_snapshot);
 insert into public.sentinel_decision_audit values(p_organization_id,p_incident_id,p_mode,audit_id,decision_id,receipt);
 if action_name in('accept','reject') then
  insert into public.sentinel_decision_status values(p_organization_id,p_incident_id,p_mode,r.id,decision_id,case when action_name='accept' then 'approved' else 'rejected' end);
  if action_name='accept' then update public.sentinel_incident_state set current_approved_plan_revision=r.id where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode;end if;
 end if;
 insert into public.sentinel_command_receipts values(p_organization_id,p_incident_id,p_mode,p_actor_id,(p_command->>'commandId')::uuid,decision_id,jsonb_build_object('revisionId',r.id,'command',p_command),receipt);
 if action_name='accept' then
  admission:=public.sentinel_plan_admission(p_organization_id,p_incident_id,p_mode,r.id);
  if admission is null or admission->'eligible' is distinct from 'true'::jsonb then raise exception 'Evidence expired before final validation' using errcode='40001';end if;
  final_validation:=jsonb_build_object('kind','final_admission','decisionId',decision_id,'planRevisionId',r.id,'checkedAt',admission->>'checkedAt',
   'timeBasis',admission->>'timeBasis','evidenceVectorHash',r.evidence_vector_hash,'eligible',true);
  insert into public.sentinel_decision_audit values(p_organization_id,p_incident_id,p_mode,gen_random_uuid(),decision_id,final_validation);
 end if;
 return jsonb_build_object('decision',body,'receipt',receipt,'replayed',false,'finalValidation',final_validation);
exception when data_exception then raise exception 'Invalid decision value' using errcode='22023';
end;$$;
revoke all on function public.sentinel_record_decision(uuid,uuid,uuid,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.sentinel_record_decision(uuid,uuid,uuid,text,uuid,jsonb) to service_role;

create function public.sentinel_read_decision_command(p_actor_id uuid,p_organization_id uuid,p_incident_id uuid,p_mode text,p_command_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare s public.sentinel_incident_state%rowtype;c public.sentinel_command_receipts%rowtype;d public.sentinel_decisions%rowtype;final_validation jsonb;
begin
 s:=public.sentinel_lock_evidence_reader(p_actor_id,p_organization_id,p_incident_id,p_mode);if s.organization_id is null then return null;end if;
 select * into c from public.sentinel_command_receipts where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and actor_id=p_actor_id and command_id=p_command_id;
 if not found then return null;end if;
 select * into d from public.sentinel_decisions where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and id=c.decision_id;
 select body into final_validation from public.sentinel_decision_audit where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and decision_id=d.id and body->>'kind'='final_admission';
 return jsonb_build_object('decision',d.body,'receipt',c.receipt,'replayed',true,'finalValidation',final_validation);
end;$$;
revoke all on function public.sentinel_read_decision_command(uuid,uuid,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.sentinel_read_decision_command(uuid,uuid,uuid,text,uuid) to service_role;

create or replace function public.sentinel_read_plan_draft(p_actor_id uuid,p_organization_id uuid,p_incident_id uuid,p_mode text,p_revision_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog set timezone='UTC' as $$
declare s public.sentinel_incident_state%rowtype;r public.sentinel_plan_revisions%rowtype;terminal public.sentinel_decision_status%rowtype;d public.sentinel_decisions%rowtype;
 current_id uuid;admission jsonb;issues jsonb;matches boolean;valid boolean;review_state text;terminal_view jsonb;
begin
 perform 1 from public.organization_members where organization_id=p_organization_id and user_id=p_actor_id and role in('viewer','analyst','incident_commander') for share;
 if not found then raise exception 'Plan unavailable' using errcode='42501';end if;
 lock table public.assets,public.source_snapshots in share mode;
 s:=public.sentinel_lock_evidence_reader(p_actor_id,p_organization_id,p_incident_id,p_mode);if s.organization_id is null then return null;end if;
 select current_revision_id into current_id from public.sentinel_plan_status where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode;
 select * into r from public.sentinel_plan_revisions where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and id=coalesce(p_revision_id,current_id);
 if not found then return null;end if;
 select * into terminal from public.sentinel_decision_status where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and revision_id=r.id;
 admission:=public.sentinel_plan_admission(p_organization_id,p_incident_id,p_mode,r.id);
 matches:=coalesce(s.evidence_generation=r.evidence_generation and admission->>'evidenceVectorHash'=r.evidence_vector_hash,false);
 issues:=admission->'blockers';
 if terminal.outcome='approved' and s.current_approved_plan_revision=r.id then
  select coalesce(jsonb_agg(value),'[]'::jsonb) into issues from jsonb_array_elements(issues) where value#>>'{}'<>'proposal_superseded';
 end if;
 valid:=coalesce(matches and jsonb_array_length(issues)=0,false);
 review_state:=coalesce(terminal.outcome,case when current_id=r.id then 'draft' else 'superseded' end);
 if terminal.decision_id is not null then
  select * into d from public.sentinel_decisions where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and id=terminal.decision_id;
  terminal_view:=jsonb_build_object('decisionId',d.id,'action',d.body->>'action','actorId',d.body->>'actorId','checkedAt',d.body->>'checkedAt','committedAt',d.body->>'committedAt');
 end if;
 return jsonb_build_object('scope',r.body->'scope','revision',r.body,'isCurrentRevision',current_id=r.id,'snapshotMatchesCurrent',matches,
  'validity',case when valid then 'current' else 'needs_review' end,'approvalReady',terminal.decision_id is null and current_id=r.id and valid,
  'reviewState',review_state,'isCurrentApprovedPlan',coalesce(s.current_approved_plan_revision=r.id,false),'terminalDecision',terminal_view,
  'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
end;$$;

create or replace function public.sentinel_preview_plan_admission(p_actor_id uuid,p_organization_id uuid,p_incident_id uuid,p_mode text,p_revision_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog set timezone='UTC' as $$
declare s public.sentinel_incident_state%rowtype;result jsonb;
begin
 perform 1 from public.organization_members where organization_id=p_organization_id and user_id=p_actor_id and role in('viewer','analyst','incident_commander') for share;
 if not found then raise exception 'Policy read unavailable' using errcode='42501';end if;
 lock table public.assets,public.source_snapshots in share mode;
 s:=public.sentinel_lock_evidence_reader(p_actor_id,p_organization_id,p_incident_id,p_mode);if s.organization_id is null then return null;end if;
 result:=public.sentinel_plan_admission(p_organization_id,p_incident_id,p_mode,p_revision_id);if result is null then return null;end if;
 if exists(select 1 from public.sentinel_decision_status where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and revision_id=p_revision_id) then
  result:=result||jsonb_build_object('eligible',false,'blockers',(result->'blockers')||'"proposal_already_decided"'::jsonb);
 end if;
 return result;
end;$$;
commit;
