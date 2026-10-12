begin;
alter table public.sentinel_incident_state add column history_generation bigint not null default 0 check(history_generation between 0 and 9007199254740991);
create table public.sentinel_history_entries (
 organization_id uuid not null,incident_id uuid not null,mode text not null,sequence bigint not null check(sequence between 1 and 9007199254740991),
 kind text not null check(kind in('plan','decision')),revision_id uuid not null,decision_id uuid,actor_id uuid not null,created_at timestamptz not null,
 primary key(organization_id,incident_id,mode,sequence),
 foreign key(organization_id,incident_id,mode,revision_id) references public.sentinel_plan_revisions(organization_id,incident_id,mode,id),
 foreign key(organization_id,incident_id,mode,decision_id) references public.sentinel_decisions(organization_id,incident_id,mode,id),
 check((kind='plan' and decision_id is null) or (kind='decision' and decision_id is not null))
);
-- Existing immutable records are indexed once. Identity is local to incident/mode, not a cross-tenant counter.
insert into public.sentinel_history_entries
select organization_id,incident_id,mode,row_number() over(partition by organization_id,incident_id,mode order by created_at,kind,reference_id),kind,revision_id,decision_id,actor_id,created_at from (
 select organization_id,incident_id,mode,'plan'::text kind,id reference_id,id revision_id,null::uuid decision_id,(body->>'createdBy')::uuid actor_id,(body->>'createdAt')::timestamptz created_at from public.sentinel_plan_revisions
 union all select organization_id,incident_id,mode,'decision',id,revision_id,id,(body->>'actorId')::uuid,(body->>'committedAt')::timestamptz from public.sentinel_decisions) old;
update public.sentinel_incident_state s set history_generation=coalesce((select max(sequence) from public.sentinel_history_entries h where h.organization_id=s.organization_id and h.incident_id=s.incident_id and h.mode=s.mode),0);
create function public.sentinel_index_history() returns trigger language plpgsql security definer set search_path=pg_catalog as $$
declare n bigint;k text;r uuid;d uuid;a uuid;t timestamptz;
begin
 if tg_table_name='sentinel_plan_revisions' then k:='plan';r:=new.id;d:=null;a:=(new.body->>'createdBy')::uuid;t:=(new.body->>'createdAt')::timestamptz;
 else k:='decision';r:=new.revision_id;d:=new.id;a:=(new.body->>'actorId')::uuid;t:=(new.body->>'committedAt')::timestamptz;end if;
 update public.sentinel_incident_state set history_generation=history_generation+1 where organization_id=new.organization_id and incident_id=new.incident_id and mode=new.mode returning history_generation into n;
 if not found then raise exception 'History unavailable' using errcode='42501';end if;
 insert into public.sentinel_history_entries values(new.organization_id,new.incident_id,new.mode,n,k,r,d,a,t);return new;
end;$$;
revoke all on function public.sentinel_index_history() from public,anon,authenticated,service_role;
create trigger sentinel_plan_history after insert on public.sentinel_plan_revisions for each row execute function public.sentinel_index_history();
create trigger sentinel_decision_history after insert on public.sentinel_decisions for each row execute function public.sentinel_index_history();
create trigger sentinel_history_immutable before update or delete on public.sentinel_history_entries for each row execute function public.sentinel_reject_evidence_mutation();
alter table public.sentinel_history_entries enable row level security;
revoke all on public.sentinel_history_entries from public,anon,authenticated,service_role;
create function public.sentinel_read_history(p_actor_id uuid,p_organization_id uuid,p_incident_id uuid,p_mode text,p_after_sequence bigint) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare s public.sentinel_incident_state%rowtype;items jsonb;last_sequence bigint;more boolean;
begin
 if p_after_sequence is null or p_after_sequence not between 0 and 9007199254740991 then raise exception 'Invalid history cursor' using errcode='22023';end if;
 s:=public.sentinel_lock_evidence_reader(p_actor_id,p_organization_id,p_incident_id,p_mode);if s.organization_id is null then return null;end if;
 select coalesce(jsonb_agg(jsonb_build_object('sequence',h.sequence,'kind',h.kind,'planRevisionId',h.revision_id,'parentRevisionId',r.parent_revision_id,
  'decisionId',h.decision_id,'actorId',h.actor_id,'createdAt',to_char(h.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'action',d.body->>'action','receiptId',case when h.kind='decision' then d.body->>'receiptId' else c.receipt->>'id' end) order by h.sequence),'[]'::jsonb),max(h.sequence)
 into items,last_sequence from (select * from public.sentinel_history_entries where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and sequence>p_after_sequence order by sequence limit 25) h
 join public.sentinel_plan_revisions r on r.organization_id=h.organization_id and r.incident_id=h.incident_id and r.mode=h.mode and r.id=h.revision_id
 left join public.sentinel_decisions d on d.organization_id=h.organization_id and d.incident_id=h.incident_id and d.mode=h.mode and d.id=h.decision_id
 left join public.sentinel_plan_commands c on c.organization_id=h.organization_id and c.incident_id=h.incident_id and c.mode=h.mode and c.revision_id=h.revision_id;
 more:=last_sequence is not null and exists(select 1 from public.sentinel_history_entries where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and sequence>last_sequence);
 return jsonb_build_object('scope',jsonb_build_object('organizationId',p_organization_id,'incidentId',p_incident_id,'mode',p_mode),'items',items,'hasMore',more,
  'nextAfterSequence',case when more then last_sequence end,'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
end;$$;
revoke all on function public.sentinel_read_history(uuid,uuid,uuid,text,bigint) from public,anon,authenticated;
grant execute on function public.sentinel_read_history(uuid,uuid,uuid,text,bigint) to service_role;

create table public.sentinel_briefings (
 organization_id uuid not null,incident_id uuid not null,mode text not null,id uuid not null,revision_id uuid not null,source_artifact_id uuid,
 actor_id uuid not null,redaction_profile text not null check(redaction_profile in('member_full','viewer_reference_only')),
 format text not null check(format in('json','html')),content text not null,content_hash text not null check(content_hash ~ '^[a-f0-9]{64}$'),
 content_bytes integer not null check(content_bytes between 1 and 2097152),receipt jsonb not null,
 primary key(organization_id,incident_id,mode,id),
 foreign key(organization_id,incident_id,mode,revision_id) references public.sentinel_plan_revisions(organization_id,incident_id,mode,id),
 foreign key(organization_id,incident_id,mode,source_artifact_id) references public.sentinel_briefings(organization_id,incident_id,mode,id),
 check(octet_length(content)=content_bytes),check(encode(sha256(convert_to(content,'UTF8')),'hex')=content_hash),
 check((format='json' and source_artifact_id is null) or (format='html' and source_artifact_id is not null))
);
create trigger sentinel_briefings_immutable before update or delete on public.sentinel_briefings for each row execute function public.sentinel_reject_evidence_mutation();
alter table public.sentinel_briefings enable row level security;
revoke all on public.sentinel_briefings from public,anon,authenticated,service_role;
create function public.sentinel_briefing_result(a public.sentinel_briefings) returns jsonb language sql immutable set search_path=pg_catalog as $$
 select jsonb_build_object('content',a.content,'receipt',a.receipt)
$$;
revoke all on function public.sentinel_briefing_result(public.sentinel_briefings) from public,anon,authenticated,service_role;

create function public.sentinel_create_briefing(p_actor_id uuid,p_organization_id uuid,p_incident_id uuid,p_mode text,p_revision_id uuid) returns jsonb
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
  'claimTextHash',encode(sha256(convert_to(x->'claim'->>'claimText','UTF8')),'hex'),'review',case when profile='member_full' then x->'review' else x->'review'||jsonb_build_object('note','Withheld in viewer briefing') end,
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
create function public.sentinel_read_briefing(p_actor_id uuid,p_organization_id uuid,p_incident_id uuid,p_mode text,p_artifact_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare a public.sentinel_briefings%rowtype;role_name text;s public.sentinel_incident_state%rowtype;
begin
 s:=public.sentinel_lock_evidence_reader(p_actor_id,p_organization_id,p_incident_id,p_mode);if s.organization_id is null then return null;end if;
 select role into role_name from public.organization_members where organization_id=p_organization_id and user_id=p_actor_id;
 select * into a from public.sentinel_briefings where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and id=p_artifact_id;
 if not found then return null;end if;
 if role_name='viewer' and a.redaction_profile<>'viewer_reference_only' then raise exception 'Briefing unavailable' using errcode='42501';end if;
 return public.sentinel_briefing_result(a);
end;$$;
revoke all on function public.sentinel_read_briefing(uuid,uuid,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.sentinel_read_briefing(uuid,uuid,uuid,text,uuid) to service_role;

create function public.sentinel_briefing_escape(t text) returns text language sql immutable set search_path=pg_catalog as $$
 select replace(replace(replace(replace(coalesce(t,'Unknown'),'&','&amp;'),'<','&lt;'),'>','&gt;'),'"','&quot;')
$$;
revoke all on function public.sentinel_briefing_escape(text) from public,anon,authenticated,service_role;
create function public.sentinel_create_html_briefing(p_actor_id uuid,p_organization_id uuid,p_incident_id uuid,p_mode text,p_source_artifact_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare source public.sentinel_briefings%rowtype;a public.sentinel_briefings%rowtype;read_result jsonb;b jsonb;html text;x jsonb;artifact_id uuid:=gen_random_uuid();stamp text;receipt_id uuid:=gen_random_uuid();
begin
 read_result:=public.sentinel_read_briefing(p_actor_id,p_organization_id,p_incident_id,p_mode,p_source_artifact_id);if read_result is null then return null;end if;
 select * into source from public.sentinel_briefings where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and id=p_source_artifact_id;
 if source.format<>'json' then raise exception 'Invalid briefing source' using errcode='22023';end if;b:=source.content::jsonb;
 html:='<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="sentinel-artifact-id" content="'||artifact_id||'"><title>FireAfter Sentinel briefing</title><style>body{font:16px system-ui;max-width:960px;margin:2rem auto;padding:0 1rem;color:#17212b}h1,h2{line-height:1.2}li{margin:.6rem 0}pre,blockquote{white-space:pre-wrap;overflow-wrap:anywhere}code{overflow-wrap:anywhere}table{width:100%;border-collapse:collapse}th,td{border:1px solid #aaa;padding:.5rem;text-align:left}@media print{body{max-width:none;margin:0;font-size:11pt}h2{break-after:avoid}li,blockquote{break-inside:avoid}}</style></head><body><main><h1>Inspection briefing</h1><p>FireAfter Sentinel · '||public.sentinel_briefing_escape(b->'scope'->>'mode')||' data</p><p>Revision <code>'||public.sentinel_briefing_escape(b->'plan'->>'id')||'</code></p><p>Review state: '||public.sentinel_briefing_escape(b->'currentValidity'->>'reviewState')||'. Current validity: '||public.sentinel_briefing_escape(b->'currentValidity'->>'validity')||', observed '||public.sentinel_briefing_escape(b->'currentValidity'->>'observedAt')||'.</p><p>Historical decisions and this observed validity are separate. This briefing does not dispatch crews or continuously check conditions.</p><h2>Inspection tasks</h2><ol>';
 for x in select value from jsonb_array_elements(b->'constraint'->'configuration'->'tasks') loop
  html:=html||'<li><strong>'||public.sentinel_briefing_escape(x->>'label')||'</strong> — capability '||public.sentinel_briefing_escape(x->>'requiredCapability')||'; inspection '||public.sentinel_briefing_escape(x->>'durationMinutes')||' minutes; travel allowance '||public.sentinel_briefing_escape(x->>'travelMinutes')||' minutes; window '||public.sentinel_briefing_escape(x->>'windowFrom')||' to '||public.sentinel_briefing_escape(x->>'windowUntil')||'. Task <code>'||public.sentinel_briefing_escape(x->>'id')||'</code></li>';
 end loop;
 html:=html||'</ol><h2>Allocation</h2><p>'||public.sentinel_briefing_escape(b->'plan'->'allocation'->>'status')||'. Inputs: '||public.sentinel_briefing_escape(b->'constraint'->'configuration'->>'inputBasis')||'.</p><ul>';
 for x in select value from jsonb_array_elements(b->'plan'->'allocation'->'assignments') loop
  html:=html||'<li>Task <code>'||public.sentinel_briefing_escape(x->>'taskId')||'</code>; crew <code>'||public.sentinel_briefing_escape(x->>'crewId')||'</code>; start '||public.sentinel_briefing_escape(x->>'startsAt')||'.</li>';
 end loop;
 html:=html||'</ul><h2>Evidence and citations</h2><ul>';
 for x in select value from jsonb_array_elements(b->'evidence'->'documents') loop
  html:=html||'<li>Source '||public.sentinel_briefing_escape(case when source.redaction_profile='viewer_reference_only' then 'Withheld in viewer briefing' else x->>'issuer' end)||'; version <code>'||public.sentinel_briefing_escape(x->>'versionId')||'</code>; published '||public.sentinel_briefing_escape(x->>'publishedAt')||'; retrieved '||public.sentinel_briefing_escape(x->>'retrievedAt')||'; hash <code>'||public.sentinel_briefing_escape(x->>'normalizedHash')||'</code>. URL: '||public.sentinel_briefing_escape(case when source.redaction_profile='viewer_reference_only' then 'Withheld in viewer briefing' else x->>'canonicalUrl' end)||'.</li>';
 end loop;
 html:=html||'</ul>';
 for x in select value from jsonb_array_elements(b->'evidence'->'claims') loop
  html:=html||'<p>Claim <code>'||public.sentinel_briefing_escape(x->'claim'->>'id')||'</code>: '||public.sentinel_briefing_escape(case when source.redaction_profile='viewer_reference_only' then 'Withheld in viewer briefing' else x->'claim'->>'claimText' end)||'. Review: '||public.sentinel_briefing_escape(x->'review'->>'support')||' / '||public.sentinel_briefing_escape(x->'review'->>'applicability')||'.</p><blockquote>'||public.sentinel_briefing_escape(case when source.redaction_profile='viewer_reference_only' then 'Withheld in viewer briefing' else x->'claim'->>'excerpt' end)||'</blockquote>';
 end loop;
 html:=html||'<h2>Human decisions</h2><ul>';
 for x in select value from jsonb_array_elements(b->'decisions') loop
  html:=html||'<li>'||public.sentinel_briefing_escape(x->'decision'->>'action')||'; actor <code>'||public.sentinel_briefing_escape(x->'decision'->>'actorId')||'</code>; checked '||public.sentinel_briefing_escape(x->'decision'->>'checkedAt')||'; receipt <code>'||public.sentinel_briefing_escape(x->'receipt'->>'id')||'</code>. '||public.sentinel_briefing_escape(x->'decision'->>'note')||'</li>';
 end loop;
 html:=html||'</ul><h2>Limitations</h2><ul>';
 for x in select value from jsonb_array_elements(b->'limitations') loop html:=html||'<li>'||public.sentinel_briefing_escape(x#>>'{}')||'</li>';end loop;
 -- Non-executable machine-readable complete lineage. Escaping '<' prevents source text closing the element.
 html:=html||'</ul><h2>Complete retained lineage</h2><details><summary>Constraints, policy, dependencies and reference hashes</summary><pre>'||public.sentinel_briefing_escape(source.content)||'</pre></details></main><script id="sentinel-briefing-lineage" type="application/json">'||replace(replace(replace(source.content,'&','\u0026'),'<','\u003c'),'>','\u003e')||'</script></body></html>';
 a.organization_id:=p_organization_id;a.incident_id:=p_incident_id;a.mode:=p_mode;a.id:=artifact_id;a.revision_id:=source.revision_id;a.source_artifact_id:=source.id;a.actor_id:=p_actor_id;a.redaction_profile:=source.redaction_profile;a.format:='html';a.content:=html;a.content_bytes:=octet_length(html);
 if a.content_bytes>2097152 then raise exception 'Briefing capacity exceeded' using errcode='54000';end if;
 a.content_hash:=encode(sha256(convert_to(html,'UTF8')),'hex');stamp:=to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 a.receipt:=jsonb_build_object('id',receipt_id,'artifactId',artifact_id,'sourceArtifactId',source.id,'scope',source.receipt->'scope','planRevisionId',source.revision_id,'issuedBy',p_actor_id,'createdAt',stamp,'redactionProfile',source.redaction_profile,'format','html','contentHash',a.content_hash,'contentBytes',a.content_bytes,'status','artifact_created');
 insert into public.sentinel_briefings select a.*;return public.sentinel_briefing_result(a);
end;$$;
revoke all on function public.sentinel_create_html_briefing(uuid,uuid,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.sentinel_create_html_briefing(uuid,uuid,uuid,text,uuid) to service_role;
commit;
