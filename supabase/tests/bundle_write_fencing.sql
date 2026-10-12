-- UNEXECUTED candidate. Approved disposable target ONLY; never production.
-- Operator must independently verify host/database against a disposable allowlist
-- and set fireafter.assurance_test_target=disposable plus
-- fireafter.assurance_test_database=<exact current_database()> before this file.
-- Use a dedicated psql connection which closes on ON_ERROR_STOP. If interactive,
-- an early error leaves an aborted transaction: explicitly ROLLBACK before reuse.
-- Fixtures and catalog drift below are transaction-local and never committed.
\set ON_ERROR_STOP on
begin;
set local lock_timeout = '2s';
set local statement_timeout = '60s';
do $$ begin
  if current_setting('fireafter.assurance_test_target', true) is distinct from 'disposable'
    or current_setting('fireafter.assurance_test_database', true) is distinct from current_database()
    or current_user is distinct from 'postgres' then
    raise exception 'Approved disposable database acknowledgement and postgres setup required';
  end if;
  if public.fireafter_bundle_persistence_security_version() is distinct from '20260914034000'
    or public.fireafter_responder_action_security_version() is distinct from '20260914010000' then
    raise exception 'Required migrated controls are not verified';
  end if;
end $$;

create temporary table fb_fixture (
  actor_id uuid, viewer_id uuid, revoked_id uuid, outsider_id uuid,
  organization_id uuid, foreign_org_id uuid, incident_id uuid, legacy_id uuid,
  foreign_incident_id uuid, absent_id uuid, revision uuid, next_revision uuid,
  asset_id uuid, recommendation_id uuid, source_id uuid, foreign_asset_id uuid,
  organization jsonb, incident jsonb, sources jsonb, assets jsonb,
  recommendations jsonb, audits jsonb
) on commit drop;
grant select, update on pg_temp.fb_fixture to service_role;

do $$
declare f record; manifest jsonb;
begin
  insert into pg_temp.fb_fixture(actor_id, viewer_id, revoked_id, outsider_id,
    organization_id, foreign_org_id, incident_id, legacy_id, foreign_incident_id,
    absent_id, revision, next_revision, asset_id, recommendation_id, source_id, foreign_asset_id)
  select gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
    gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
    gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
    gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid()
  returning * into f;
  insert into auth.users(id) values(f.actor_id), (f.viewer_id), (f.revoked_id), (f.outsider_id);
  insert into public.organizations(id,name) values
    (f.organization_id,'Disposable FB canonical organization'), (f.foreign_org_id,'Disposable FB other organization');
  insert into public.organization_members(organization_id,user_id,role) values
    (f.organization_id,f.actor_id,'analyst'), (f.organization_id,f.viewer_id,'viewer'),
    (f.organization_id,f.revoked_id,'analyst'), (f.foreign_org_id,f.outsider_id,'analyst');
  delete from public.organization_members where user_id=f.revoked_id;
  manifest := jsonb_build_object('inventoryManifest', jsonb_build_object(
    'version','2026-09-13-inventory-v1','revision',f.revision,
    'assetIds','[]'::jsonb,'recommendationIds','[]'::jsonb,'sourceSnapshotIds','[]'::jsonb));
  insert into public.incidents(id,organization_id,county,state,title,status,storm_window,selected_fire)
  values (f.incident_id,f.organization_id,'Disposable','CA','FB existing','active','fixture',manifest),
    (f.legacy_id,f.organization_id,'Disposable','CA','FB legacy','active','fixture','{}'),
    (f.foreign_incident_id,f.foreign_org_id,'Disposable','CA','FB foreign','active','fixture',manifest);
  insert into public.assets(id,incident_id,name,asset_type,location_label,source,confidence)
  values (f.foreign_asset_id,f.foreign_incident_id,'Foreign fixture','Road','Disposable','SQL fixture','Low');
  update pg_temp.fb_fixture set
    organization=jsonb_build_object('id',f.organization_id,'name','Caller must not rename organization'),
    incident=jsonb_build_object('id',f.incident_id,'organization_id',f.organization_id,
      'county','Disposable','state','CA','title','Real RPC test bundle','status','active','storm_window','fixture',
      'selected_fire',jsonb_build_object('inventoryManifest',jsonb_build_object(
        'version','2026-09-13-inventory-v1','revision',f.next_revision,
        'assetIds',jsonb_build_array(f.asset_id),'recommendationIds',jsonb_build_array(f.recommendation_id),
        'sourceSnapshotIds',jsonb_build_array(f.source_id)))),
    sources=jsonb_build_array(jsonb_build_object('id',f.source_id,'incident_id',f.incident_id,
      'source_key','sql-fixture','source_name','Disposable SQL source','fetched_at','2026-09-14T03:40:00Z',
      'status','offline','stale',true,'freshness_label','Unverified SQL fixture')),
    assets=jsonb_build_array(jsonb_build_object('id',f.asset_id,'incident_id',f.incident_id,
      'name','Disposable SQL asset','asset_type','Road','location_label','Disposable',
      'source','SQL fixture','confidence','Low','local_or_uploaded',false)),
    recommendations=jsonb_build_array(jsonb_build_object('id',f.recommendation_id,'incident_id',f.incident_id,
      'asset_id',f.asset_id,'final_score',0,'score_100',0,'risk_level','Unknown','confidence_level','Low',
      'recommended_action','Review fixture','changed_since_last_refresh','fixture','score_breakdown','{}'::jsonb)),
    audits=jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'incident_id',f.incident_id,
      'recommendation_id',null,'actor_id',f.actor_id,'actor_name','Disposable SQL actor',
      'event_type','SourcesRefreshed','summary','Disposable bundle test','created_at','2026-09-14T03:40:00Z',
      'payload',jsonb_build_object('actorId',f.actor_id,'operation','refresh','expectedRevision',f.revision)));
end $$;

-- Invoker helpers call the real public RPC; they neither stub nor replace it.
create function pg_temp.fb_invoke(o jsonb default '{}') returns void
language plpgsql security invoker as $$
declare f record;
begin
  select * into strict f from pg_temp.fb_fixture;
  perform public.fireafter_commit_bundle(
    case when o ? 'actor' then (o->>'actor')::uuid else f.actor_id end,
    case when o ? 'expected' then (o->>'expected')::uuid else f.revision end,
    case when o ? 'operation' then o->>'operation' else 'refresh' end,
    case when o ? 'organization' then nullif(o->'organization','null'::jsonb) else f.organization end,
    case when o ? 'incident' then nullif(o->'incident','null'::jsonb) else f.incident end,
    case when o ? 'sources' then nullif(o->'sources','null'::jsonb) else f.sources end,
    case when o ? 'assets' then nullif(o->'assets','null'::jsonb) else f.assets end,
    case when o ? 'recommendations' then nullif(o->'recommendations','null'::jsonb) else f.recommendations end,
    case when o ? 'actions' then nullif(o->'actions','null'::jsonb) else '[]'::jsonb end,
    case when o ? 'audits' then nullif(o->'audits','null'::jsonb) else f.audits end);
end $$;
create function pg_temp.fb_expect_error(expected text, o jsonb) returns void
language plpgsql security invoker as $$
begin
  begin
    perform pg_temp.fb_invoke(o);
  exception when others then
    if sqlstate is distinct from expected then raise; end if;
    return;
  end;
  raise exception 'Expected SQLSTATE %, but bundle succeeded', expected;
end $$;
grant execute on function pg_temp.fb_invoke(jsonb), pg_temp.fb_expect_error(text,jsonb) to service_role, anon, authenticated;
grant select on pg_temp.fb_fixture to anon, authenticated;

set local role service_role;
do $$
declare f record; key text; bad jsonb; event_type text;
begin
  select * into strict f from pg_temp.fb_fixture;
  perform pg_temp.fb_expect_error('FB401','{"actor":null}');
  perform pg_temp.fb_expect_error('FB401',jsonb_build_object('actor',f.viewer_id));
  perform pg_temp.fb_expect_error('FB401',jsonb_build_object('actor',f.revoked_id));
  perform pg_temp.fb_expect_error('FB401',jsonb_build_object('actor',f.outsider_id));
  perform pg_temp.fb_expect_error('FB401',jsonb_build_object('incident',f.incident || jsonb_build_object('id',f.foreign_incident_id)));
  perform pg_temp.fb_expect_error('FB401','{"operation":"cron_refresh"}');
  perform pg_temp.fb_expect_error('FB409','{"expected":null}');
  perform pg_temp.fb_expect_error('FB409',jsonb_build_object('expected',gen_random_uuid()));
  perform pg_temp.fb_expect_error('FB409','{"operation":"create","expected":null}');
  perform pg_temp.fb_expect_error('FB404',jsonb_build_object('incident',f.incident || jsonb_build_object('id',f.absent_id)));
  perform pg_temp.fb_expect_error('FB404',jsonb_build_object('operation','cron_refresh','actor',null,
    'incident',f.incident || jsonb_build_object('id',f.absent_id)));
  perform pg_temp.fb_expect_error('FB404',jsonb_build_object('operation','cron_refresh','actor',null,
    'organization',f.organization || jsonb_build_object('id',f.absent_id),
    'incident',f.incident || jsonb_build_object('organization_id',f.absent_id)));
  perform pg_temp.fb_expect_error('FB400',jsonb_build_object('operation','create',
    'incident',f.incident || jsonb_build_object('id',f.absent_id)));
  perform pg_temp.fb_expect_error('FB400','{"operation":null}');
  perform pg_temp.fb_expect_error('FB400','{"operation":"unknown"}');
  foreach key in array array['organization','incident','sources','assets','recommendations','actions','audits'] loop
    perform pg_temp.fb_expect_error('FB400',jsonb_build_object(key,null));
    perform pg_temp.fb_expect_error('FB400',jsonb_build_object(key,7));
  end loop;
  perform pg_temp.fb_expect_error('FB400','{"actions":[{}]}');
  perform pg_temp.fb_expect_error('FB400','{"audits":[]}');
  perform pg_temp.fb_expect_error('FB400',jsonb_build_object('audits',f.audits || f.audits));
  foreach event_type in array array['RecommendationAccepted','RecommendationModified','RecommendationRejected',
    'RecommendationAnnotated','IncidentCreated','AssetsImported','FireContextSelected'] loop
    perform pg_temp.fb_expect_error('FB400',jsonb_build_object('audits',
      jsonb_build_array(f.audits->0 || jsonb_build_object('event_type',event_type))));
  end loop;
  foreach key in array array['actor_id','recommendation_id','payload','id','created_at','summary','actor_name'] loop
    perform pg_temp.fb_expect_error('FB400',jsonb_build_object('audits',jsonb_build_array((f.audits->0)-key)));
  end loop;
  foreach key in array array['actorId','operation','expectedRevision'] loop
    perform pg_temp.fb_expect_error('FB400',jsonb_build_object('audits',jsonb_build_array(
      jsonb_set(f.audits->0,'{payload}',(f.audits->0->'payload')-key))));
    perform pg_temp.fb_expect_error('FB400',jsonb_build_object('audits',jsonb_build_array(
      jsonb_set(f.audits->0,array['payload',key],'null'))));
  end loop;
  perform pg_temp.fb_expect_error('FB400',jsonb_build_object('audits',jsonb_build_array(
    jsonb_set(f.audits->0,'{actor_id}',to_jsonb(f.viewer_id)))));
  perform pg_temp.fb_expect_error('FB400',jsonb_build_object('incident',
    jsonb_set(f.incident,'{selected_fire,inventoryManifest,revision}',to_jsonb(f.revision))));
  perform pg_temp.fb_expect_error('FB400',jsonb_build_object('incident',
    jsonb_set(f.incident,'{selected_fire,inventoryManifest,revision}','"malformed"')));
  for bad in select value from jsonb_array_elements('[null,{},[],{"version":"wrong"}]'::jsonb) loop
    perform pg_temp.fb_expect_error('FB400',jsonb_build_object('incident',
      jsonb_set(f.incident,'{selected_fire,inventoryManifest}',bad)));
  end loop;
  foreach key in array array['version','revision','assetIds','recommendationIds','sourceSnapshotIds'] loop
    perform pg_temp.fb_expect_error('FB400',jsonb_build_object('incident',
      f.incident #- array['selected_fire','inventoryManifest',key]));
    perform pg_temp.fb_expect_error('FB400',jsonb_build_object('incident',
      jsonb_set(f.incident,array['selected_fire','inventoryManifest',key],'null')));
  end loop;
  perform pg_temp.fb_expect_error('FB400',jsonb_build_object('incident',
    jsonb_set(f.incident,'{selected_fire,inventoryManifest,assetIds}',jsonb_build_array(f.asset_id,f.asset_id))));
  perform pg_temp.fb_expect_error('FB400',jsonb_build_object('incident',
    jsonb_set(f.incident,'{selected_fire,inventoryManifest,assetIds}','[]')));
  perform pg_temp.fb_expect_error('FB400',jsonb_build_object('assets',f.assets || f.assets));
  perform pg_temp.fb_expect_error('FB400',jsonb_build_object('assets',jsonb_build_array(
    f.assets->0 || jsonb_build_object('incident_id',f.foreign_incident_id))));
  perform pg_temp.fb_expect_error('FB400',jsonb_build_object('recommendations',jsonb_build_array(
    f.recommendations->0 || jsonb_build_object('asset_id',f.foreign_asset_id))));
  perform pg_temp.fb_expect_error('FB400',jsonb_build_object(
    'assets',jsonb_build_array(f.assets->0 || jsonb_build_object('id',f.foreign_asset_id)),
    'recommendations',jsonb_build_array(f.recommendations->0 || jsonb_build_object('asset_id',f.foreign_asset_id)),
    'incident',jsonb_set(f.incident,'{selected_fire,inventoryManifest,assetIds}',jsonb_build_array(f.foreign_asset_id))));
  -- Late helper failure must roll back incident, source replacement and assets.
  perform pg_temp.fb_expect_error('FB400',jsonb_build_object('recommendations',jsonb_build_array(
    f.recommendations->0 || '{"score_100":null}'::jsonb)));
  if exists(select 1 from public.assets where id=f.asset_id)
    or exists(select 1 from public.source_snapshots where id=f.source_id)
    or exists(select 1 from public.audit_events where incident_id=f.incident_id)
    or (select selected_fire->'inventoryManifest'->>'revision' from public.incidents where id=f.incident_id)
      is distinct from f.revision::text then
    raise exception 'Rejected bundle leaked writes';
  end if;
  perform pg_temp.fb_invoke();
  if (select selected_fire->'inventoryManifest'->>'revision' from public.incidents where id=f.incident_id)
      is distinct from f.next_revision::text
    or (select name from public.organizations where id=f.organization_id)
      is distinct from 'Disposable FB canonical organization'
    or (select count(*) from public.assets where id=f.asset_id and incident_id=f.incident_id) <> 1
    or (select count(*) from public.recommendations where id=f.recommendation_id and asset_id=f.asset_id) <> 1
    or (select count(*) from public.source_snapshots where id=f.source_id and incident_id=f.incident_id) <> 1
    or (select count(*) from public.audit_events where incident_id=f.incident_id and actor_id=f.actor_id
      and payload->>'actorId'=f.actor_id::text and event_type='SourcesRefreshed') <> 1
    or exists(select 1 from public.responder_actions where recommendation_id=f.recommendation_id) then
    raise exception 'Real bundle commit or actor/name preservation failed';
  end if;
  -- Same request cannot silently replay under a stale CAS.
  perform pg_temp.fb_expect_error('FB409','{}');
  perform pg_temp.fb_expect_error('FB400',jsonb_build_object('expected',f.next_revision,
    'incident',jsonb_set(f.incident,'{selected_fire,inventoryManifest,revision}',to_jsonb(gen_random_uuid())),
    'audits',jsonb_build_array(jsonb_set(f.audits->0,'{payload,expectedRevision}',to_jsonb(f.next_revision)))));
end $$;
reset role;

-- The actual responder-command RPC can commit against the wrapper's generation.
-- A later bundle keeps the append-only action/audit/receipt, even with empty new
-- inventory membership. This is single-session compatibility, not race evidence.
set local role service_role;
do $$
declare f record; v_command_id uuid := gen_random_uuid(); action_id uuid := gen_random_uuid();
  audit_id uuid := gen_random_uuid(); snapshot jsonb; request jsonb; action_row jsonb;
  audit_row jsonb; response jsonb; next_rev uuid := gen_random_uuid(); bundle_audit jsonb;
begin
  select * into strict f from pg_temp.fb_fixture;
  snapshot := jsonb_build_object('id',f.recommendation_id,'incidentId',f.incident_id,'assetId',f.asset_id);
  request := jsonb_build_object('recommendationId',f.recommendation_id,'action','annotate',
    'note','Disposable command compatibility','modifiedPriority',null);
  action_row := jsonb_build_object('id',action_id,'recommendation_id',f.recommendation_id,
    'actor_id',f.actor_id,'actor_name','Disposable SQL actor','action','annotate',
    'note','Disposable command compatibility','modified_priority',null,'created_at','2026-09-14T03:40:01Z',
    'recommendation_snapshot',snapshot || jsonb_build_object('domainActionId',
      'action-command-' || f.actor_id::text || '-' || v_command_id::text));
  audit_row := jsonb_build_object('id',audit_id,'incident_id',f.incident_id,'recommendation_id',f.recommendation_id,
    'actor_id',f.actor_id,'actor_name','Disposable SQL actor','event_type','RecommendationAnnotated',
    'summary','Disposable command compatibility','created_at','2026-09-14T03:40:01Z',
    'payload',jsonb_build_object('recommendationSnapshot',snapshot,'action','annotate',
      'note','Disposable command compatibility','commandId',v_command_id,'expectedRevision',f.next_revision,
      'domainAuditEventId','audit-command-' || f.actor_id::text || '-' || v_command_id::text));
  response := public.fireafter_record_responder_command(v_command_id,f.actor_id,f.organization_id,
    f.next_revision,request,action_row,audit_row);
  if response->'action'->>'id' is distinct from action_id::text then
    raise exception 'Real responder command did not commit against bundle generation';
  end if;
  bundle_audit := f.audits->0 || jsonb_build_object('id',gen_random_uuid(),
    'payload',jsonb_build_object('actorId',f.actor_id,'operation','refresh','expectedRevision',f.next_revision));
  perform pg_temp.fb_invoke(jsonb_build_object('expected',f.next_revision,
    'incident',f.incident || jsonb_build_object('selected_fire',jsonb_build_object('inventoryManifest',
      jsonb_build_object('version','2026-09-13-inventory-v1','revision',next_rev,
        'assetIds','[]'::jsonb,'recommendationIds','[]'::jsonb,'sourceSnapshotIds','[]'::jsonb))),
    'sources','[]'::jsonb,'assets','[]'::jsonb,'recommendations','[]'::jsonb,'audits',jsonb_build_array(bundle_audit)));
  if (select to_jsonb(a) from public.responder_actions a where id=action_id) is distinct from response->'action'
    or (select to_jsonb(a) from public.audit_events a where id=audit_id) is distinct from response->'auditEvent'
    or (select r.response from public.responder_command_receipts r
      where r.actor_id=f.actor_id and r.command_id=v_command_id) is distinct from response
    or exists(select 1 from public.source_snapshots where incident_id=f.incident_id)
    or not exists(select 1 from public.assets where id=f.asset_id)
    or not exists(select 1 from public.recommendations where id=f.recommendation_id) then
    raise exception 'Bundle rewrite changed append-only decisions or retained inventory history';
  end if;
end $$;
reset role;

-- The remaining positive user calls exercise commander membership too.
update public.organization_members set role='incident_commander'
  where user_id=(select actor_id from pg_temp.fb_fixture);

-- Each positive operation uses the actual RPC and verifies durable rows inside
-- this transaction. Independent incident IDs prevent accidental prior-state reuse.
do $$
declare f record; op text; target uuid; event_type text; expected uuid; actor uuid;
  next_rev uuid; inc jsonb; audit jsonb; audits jsonb; options jsonb; n integer;
begin
  select * into strict f from pg_temp.fb_fixture;
  foreach op in array array['create','refresh','import','fire_context','cron_refresh'] loop
    target := case when op='create' then f.absent_id else gen_random_uuid() end;
    expected := case when op='create' then null else gen_random_uuid() end;
    actor := case when op='cron_refresh' then null else f.actor_id end;
    next_rev := gen_random_uuid();
    if op <> 'create' then
      insert into public.incidents(id,organization_id,county,state,title,status,storm_window,selected_fire)
      values(target,f.organization_id,'Disposable','CA','Positive operation','active','fixture',
        jsonb_build_object('inventoryManifest',jsonb_build_object('version','2026-09-13-inventory-v1',
          'revision',expected,'assetIds','[]'::jsonb,'recommendationIds','[]'::jsonb,'sourceSnapshotIds','[]'::jsonb)));
    end if;
    inc := f.incident || jsonb_build_object('id',target,'selected_fire',
      jsonb_build_object('inventoryManifest',jsonb_build_object('version','2026-09-13-inventory-v1',
        'revision',next_rev,'assetIds','[]'::jsonb,'recommendationIds','[]'::jsonb,'sourceSnapshotIds','[]'::jsonb)));
    event_type := case op when 'create' then 'IncidentCreated' when 'import' then 'AssetsImported'
      when 'fire_context' then 'FireContextSelected' else 'SourcesRefreshed' end;
    audit := f.audits->0 || jsonb_build_object('id',gen_random_uuid(),'incident_id',target,
      'actor_id',actor,'event_type',event_type,'payload',jsonb_build_object(
        'actorId',actor,'operation',op,'expectedRevision',expected));
    audits := jsonb_build_array(audit);
    if op='create' then
      audits := audits || jsonb_build_array(audit || jsonb_build_object('id',gen_random_uuid(),'event_type','SourcesRefreshed'));
    end if;
    options := jsonb_build_object('actor',actor,'operation',op,'expected',expected,'incident',inc,
      'sources','[]'::jsonb,'assets','[]'::jsonb,'recommendations','[]'::jsonb,'audits',audits);
    execute 'set local role service_role';
    perform pg_temp.fb_invoke(options);
    execute 'reset role';
    select count(*) into n from public.audit_events where incident_id=target
      and actor_id is not distinct from actor and payload->'actorId' is not distinct from coalesce(to_jsonb(actor),'null'::jsonb);
    if n is distinct from jsonb_array_length(audits)
      or (select selected_fire->'inventoryManifest'->>'revision' from public.incidents where id=target)
        is distinct from next_rev::text then
      raise exception 'Positive operation % failed', op;
    end if;
    if op='cron_refresh' then
      execute 'set local role service_role';
      perform pg_temp.fb_expect_error('FB409',options);
      execute 'reset role';
    end if;
  end loop;
end $$;

-- Legacy means absent inventoryManifest, never an explicit null or broken object.
do $$
declare f record; bad jsonb; inc jsonb; audit jsonb; options jsonb;
begin
  select * into strict f from pg_temp.fb_fixture;
  inc := f.incident || jsonb_build_object('id',f.legacy_id,'selected_fire',jsonb_build_object(
    'inventoryManifest',jsonb_build_object('version','2026-09-13-inventory-v1','revision',gen_random_uuid(),
      'assetIds','[]'::jsonb,'recommendationIds','[]'::jsonb,'sourceSnapshotIds','[]'::jsonb)));
  audit := f.audits->0 || jsonb_build_object('id',gen_random_uuid(),'incident_id',f.legacy_id,
    'payload',jsonb_build_object('actorId',f.actor_id,'operation','refresh','expectedRevision',null));
  options := jsonb_build_object('expected',null,'incident',inc,'sources','[]'::jsonb,'assets','[]'::jsonb,
    'recommendations','[]'::jsonb,'audits',jsonb_build_array(audit));
  for bad in select value from jsonb_array_elements(jsonb_build_array(
    'null'::jsonb,'[]'::jsonb,jsonb_build_object('inventoryManifest',null),
    jsonb_build_object('inventoryManifest','{}'::jsonb),
    jsonb_build_object('inventoryManifest',jsonb_build_object('version','2026-09-13-inventory-v1','revision',null)),
    jsonb_build_object('inventoryManifest',jsonb_build_object('version','2026-09-13-inventory-v1','revision','bad')),
    jsonb_build_object('inventoryManifest',jsonb_build_object('version','2026-09-13-inventory-v1',
      'revision',f.revision,'assetIds',null,'recommendationIds','[]'::jsonb,'sourceSnapshotIds','[]'::jsonb)))) loop
    update public.incidents set selected_fire=bad where id=f.legacy_id;
    execute 'set local role service_role';
    perform pg_temp.fb_expect_error('FB400',options);
    execute 'reset role';
  end loop;
  update public.incidents set selected_fire='{}' where id=f.legacy_id;
  execute 'set local role service_role';
  perform pg_temp.fb_expect_error('FB409',options || jsonb_build_object('expected',f.revision));
  perform pg_temp.fb_invoke(options);
  execute 'reset role';
  if (select selected_fire from public.incidents where id=f.legacy_id) is distinct from inc->'selected_fire' then
    raise exception 'Legacy upgrade did not preserve the caller-generated manifest';
  end if;
end $$;

-- Actual privilege denials, not catalog assertions alone.
create function pg_temp.fb_expect_legacy_denied() returns void language plpgsql security invoker as $$
begin
  begin
    perform public.fireafter_persist_bundle('{}','{}','[]','[]','[]','[]','[]');
  exception when insufficient_privilege then return;
  end;
  raise exception 'Legacy helper remains externally executable';
end $$;
grant execute on function pg_temp.fb_expect_legacy_denied() to anon, authenticated, service_role;
set local role anon;
select pg_temp.fb_expect_error('42501','{}');
select pg_temp.fb_expect_legacy_denied();
reset role;
set local role authenticated;
select pg_temp.fb_expect_error('42501','{}');
select pg_temp.fb_expect_legacy_denied();
reset role;
set local role service_role;
select pg_temp.fb_expect_legacy_denied();
reset role;

create function pg_temp.fb_assert_attestation(expected text) returns void language plpgsql as $$
begin
  if public.fireafter_bundle_persistence_security_version() is distinct from expected then
    raise exception 'Unexpected bundle attestation result';
  end if;
end $$;

-- Savepoint rollback restores the real function after each independent drift.
savepoint fb_drift;
grant execute on function public.fireafter_persist_bundle(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) to service_role;
select pg_temp.fb_assert_attestation(null);
rollback to savepoint fb_drift;
grant execute on function public.fireafter_commit_bundle(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) to public;
select pg_temp.fb_assert_attestation(null);
rollback to savepoint fb_drift;
grant execute on function public.fireafter_bundle_persistence_security_version() to authenticated;
select pg_temp.fb_assert_attestation(null);
rollback to savepoint fb_drift;
alter function public.fireafter_commit_bundle(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) owner to service_role;
select pg_temp.fb_assert_attestation(null);
rollback to savepoint fb_drift;
alter function public.fireafter_persist_bundle(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) owner to service_role;
select pg_temp.fb_assert_attestation(null);
rollback to savepoint fb_drift;
alter function public.fireafter_commit_bundle(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) reset all;
select pg_temp.fb_assert_attestation(null);
rollback to savepoint fb_drift;
alter function public.fireafter_persist_bundle(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) reset all;
select pg_temp.fb_assert_attestation(null);
rollback to savepoint fb_drift;
alter function public.fireafter_commit_bundle(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) set search_path=public;
select pg_temp.fb_assert_attestation(null);
rollback to savepoint fb_drift;
alter function public.fireafter_commit_bundle(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) strict;
select pg_temp.fb_assert_attestation(null);
rollback to savepoint fb_drift;
alter function public.fireafter_commit_bundle(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) security invoker;
select pg_temp.fb_assert_attestation(null);
rollback to savepoint fb_drift;
do $$ begin
  execute replace(pg_get_functiondef('public.fireafter_commit_bundle(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb)'::regprocedure),
    'Invalid bundle operation','Disposable wrapper body drift');
end $$;
select pg_temp.fb_assert_attestation(null);
rollback to savepoint fb_drift;
do $$ begin
  execute replace(pg_get_functiondef('public.fireafter_persist_bundle(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb)'::regprocedure),
    'FireAfter bundle payload has invalid JSON shapes.','Disposable helper body drift');
end $$;
select pg_temp.fb_assert_attestation(null);
rollback to savepoint fb_drift;
select pg_temp.fb_assert_attestation('20260914034000');

-- Real two-session races, transport loss and restore remain mandatory in PLAN.md.
rollback;
