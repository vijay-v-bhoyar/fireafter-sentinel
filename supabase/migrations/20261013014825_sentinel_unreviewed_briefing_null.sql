-- Preserve absent reviews as JSON null before viewer redaction.
-- Existing immutable artifacts remain unchanged; new exports retain exact receipts.
create or replace function public.sentinel_create_briefing(p_actor_id uuid,p_organization_id uuid,p_incident_id uuid,p_mode text,p_revision_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog set timezone='UTC' as $$
declare role_name text;profile text;view jsonb;r public.sentinel_plan_revisions%rowtype;c public.sentinel_constraints%rowtype;p public.sentinel_policies%rowtype;
 a public.sentinel_briefings%rowtype;artifact_id uuid:=gen_random_uuid();receipt_id uuid:=gen_random_uuid();stamp text;cfg jsonb;docs jsonb;claims jsonb;decisions jsonb;assets jsonb;native_refs jsonb;payload jsonb;
begin
 select role into role_name from public.organization_members where organization_id=p_organization_id and user_id=p_actor_id and role in('viewer','analyst','incident_commander') for share;
 if not found then raise exception 'Briefing unavailable' using errcode='42501';end if;
 profile:=case when role_name='viewer' then 'viewer_reference_only' else 'member_full' end;
 view:=public.sentinel_read_plan_draft(p_actor_id,p_organization_id,p_incident_id,p_mode,p_revision_id);if view is null then return null;end if;
 select * into r from public.sentinel_plan_revisions where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and id=p_revision_id;
 select * into c from public.sentinel_constraints where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and id=r.constraint_revision_id;
 select * into p from public.sentinel_policies where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and id=(r.body->>'policyRevisionId')::uuid;
 cfg:=c.configuration;
 if profile='viewer_reference_only' then
  cfg:=cfg||jsonb_build_object('crews',(select coalesce(jsonb_agg(value||jsonb_build_object('label','Restricted crew')),'[]'::jsonb) from jsonb_array_elements(cfg->'crews')),
   'tasks',(select coalesce(jsonb_agg(value||jsonb_build_object('label','Restricted task')),'[]'::jsonb) from jsonb_array_elements(cfg->'tasks')));
 end if;
 -- Bundle every captured head and every cited historical version; never silently drop old dependencies.
 select coalesce(jsonb_agg(jsonb_build_object('documentId',v.document_id,'versionId',v.id,'configurationId',v.source_config_revision,'identityHash',v.identity_hash,'normalizedHash',v.normalized_hash,'rawHash',v.raw_hash,
  'availability',v.availability,'contentPermission',v.content_permission,'canonicalUrl',case when profile='member_full' then v.canonical_url end,
  'issuer',case when profile='member_full' then v.issuer end,'jurisdiction',case when profile='member_full' then v.jurisdiction end,
  'publishedAt',v.published_at,'effectiveFrom',v.effective_from,'effectiveUntil',v.effective_until,'retrievedAt',v.retrieved_at,
  'capturedHead',exists(select 1 from jsonb_array_elements(r.evidence_snapshot->'documents') x where x->>'versionId'=v.id::text)) order by v.document_id,v.id),'[]'::jsonb) into docs
 from public.sentinel_document_versions v where v.organization_id=p_organization_id and v.incident_id=p_incident_id and v.mode=p_mode and v.id in (
  select (x->>'versionId')::uuid from jsonb_array_elements(r.evidence_snapshot->'documents') x
  union select (x->'claim'->>'documentVersionId')::uuid from jsonb_array_elements(r.evidence_snapshot->'claims') x);
 select coalesce(jsonb_agg(jsonb_build_object('claim',case when profile='member_full' then x->'claim' else x->'claim'||jsonb_build_object('claimText',null,'excerpt',null) end,
  'claimTextHash',encode(sha256(convert_to(x->'claim'->>'claimText','UTF8')),'hex'),'review',case when x->'review' is null or jsonb_typeof(x->'review')='null' then 'null'::jsonb when profile='member_full' then x->'review' else x->'review'||jsonb_build_object('note','Withheld in viewer briefing') end,
  'reviewReceipt',cr.receipt) order by x->'claim'->>'id'),'[]'::jsonb) into claims
 from jsonb_array_elements(r.evidence_snapshot->'claims') x left join public.sentinel_claim_reviews cr on cr.organization_id=p_organization_id and cr.incident_id=p_incident_id and cr.mode=p_mode and cr.id=(x->'review'->>'id')::uuid;
 -- Stream a lower bound first, so unbounded annotation history cannot allocate an oversized JSON aggregate.
 if (select coalesce(sum(octet_length(jsonb_build_object('decision',case when profile='member_full' then d.body else d.body||jsonb_build_object('note','Withheld in viewer briefing') end,'receipt',cr.receipt)::text)),0)
  from public.sentinel_decisions d join public.sentinel_command_receipts cr on cr.organization_id=d.organization_id and cr.incident_id=d.incident_id and cr.mode=d.mode and cr.decision_id=d.id
  where d.organization_id=p_organization_id and d.incident_id=p_incident_id and d.mode=p_mode and d.revision_id=r.id)>2097152 then raise exception 'Briefing capacity exceeded' using errcode='54000';end if;
 select coalesce(jsonb_agg(jsonb_build_object('decision',case when profile='member_full' then d.body else d.body||jsonb_build_object('note','Withheld in viewer briefing') end,'receipt',cr.receipt,'lastAdmission',(select case when admission_audit.body->>'kind'='feedback_final_admission' then admission_audit.body->'finalValidation' else admission_audit.body end from public.sentinel_decision_audit admission_audit where admission_audit.organization_id=d.organization_id and admission_audit.incident_id=d.incident_id and admission_audit.mode=d.mode and admission_audit.decision_id=d.id and admission_audit.body->>'kind' in('feedback_final_admission','final_admission') order by case when admission_audit.body->>'kind'='feedback_final_admission' then 0 else 1 end limit 1)) order by d.body->>'committedAt',d.id),'[]'::jsonb) into decisions
 from public.sentinel_decisions d join public.sentinel_command_receipts cr on cr.organization_id=d.organization_id and cr.incident_id=d.incident_id and cr.mode=d.mode and cr.decision_id=d.id
 where d.organization_id=p_organization_id and d.incident_id=p_incident_id and d.mode=p_mode and d.revision_id=r.id;
 select coalesce(jsonb_agg(jsonb_build_object('taskId',x->>'taskId','assetId',x->'asset'->>'id','assetHash',x->>'assetHash')),'[]'::jsonb) into assets from jsonb_array_elements(r.evidence_snapshot->'assets') x;
 select coalesce(jsonb_agg(jsonb_build_object('id',x->'id','sourceName',case when profile='member_full' then x->'sourceName' else 'null'::jsonb end,'fetchedAt',x->'fetchedAt','sourceUpdatedAt',x->'sourceUpdatedAt','status',x->'status','stale',x->'stale','payloadHash',x->'payloadHash','snapshotHash',x->'snapshotHash')),'[]'::jsonb) into native_refs from jsonb_array_elements(r.evidence_snapshot->'nativeSourceReferences') x;
 stamp:=to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 payload:=jsonb_build_object('schemaVersion',1,'id',artifact_id,'receiptId',receipt_id,'scope',r.body->'scope','createdAt',stamp,'redactionProfile',profile,'plan',r.body,
  'constraint',jsonb_build_object('id',c.id,'constraintHash',c.constraint_hash,'configuration',cfg,'configurationRedacted',profile='viewer_reference_only'),
  'policy',case when p.id is not null then jsonb_build_object('id',p.id,'policyHash',p.policy_hash,'sourceConfigurationId',p.source_config_revision,
   'configuration',case when profile='member_full' then p.configuration else p.configuration||jsonb_build_object('note','Withheld in viewer briefing') end,'configurationRedacted',profile='viewer_reference_only') end,
  'evidence',jsonb_build_object('originalSnapshotHash',r.evidence_vector_hash,'sourceConfigurationId',r.evidence_snapshot->'sourceConfigurationId','sourceConfigurationHash',r.evidence_snapshot->'sourceConfigurationHash',
   'documents',docs,'claims',claims,'assetReferences',assets,'nativeReferences',native_refs,'retrievalChecks',r.evidence_snapshot->'retrievalChecks','taskDependencies',r.body->'taskDependencies'),
  'decisions',decisions,'currentValidity',view-'scope'-'revision',
  'limitations',jsonb_build_array('Full source documents are not bundled; permitted citations and reference hashes do not independently reconstruct full source content.',
   'Raw asset and native-provider rows are not bundled. The original snapshot hash is a retained reference, not a recomputable hash of this redacted export.',
   case when profile='viewer_reference_only' then 'Viewer text, labels, URLs and operational notes are withheld; original hashes refer to original records.' else 'Data-owner rights and permitted use remain separate from this technical artifact.' end));
 a.organization_id:=p_organization_id;a.incident_id:=p_incident_id;a.mode:=p_mode;a.id:=artifact_id;a.revision_id:=r.id;a.actor_id:=p_actor_id;a.redaction_profile:=profile;a.format:='json';a.content:=payload::text;
 a.content_bytes:=octet_length(a.content);if a.content_bytes>2097152 then raise exception 'Briefing capacity exceeded' using errcode='54000';end if;
 a.content_hash:=encode(sha256(convert_to(a.content,'UTF8')),'hex');
 a.receipt:=jsonb_build_object('id',receipt_id,'artifactId',artifact_id,'sourceArtifactId',null,'scope',r.body->'scope','planRevisionId',r.id,'issuedBy',p_actor_id,'createdAt',stamp,
  'redactionProfile',profile,'format','json','contentHash',a.content_hash,'contentBytes',a.content_bytes,'status','artifact_created');
 insert into public.sentinel_briefings select a.*;return public.sentinel_briefing_result(a);
end;$$;
revoke all on function public.sentinel_create_briefing(uuid,uuid,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.sentinel_create_briefing(uuid,uuid,uuid,text,uuid) to service_role;

notify pgrst, 'reload schema';
