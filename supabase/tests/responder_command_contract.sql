-- UNEXECUTED. Run only on an explicitly authorized disposable migrated database.
-- This single-session suite does not prove concurrent lock ordering or deadlines.
-- ON_ERROR_STOP aborts on setup/privilege errors, never treating them as a pass.
-- Use a disposable psql -f connection: on error connection close rolls back;
-- an interactive session that aborts early still needs an explicit ROLLBACK.
\set ON_ERROR_STOP on
begin;
set local lock_timeout = '2s';
set local statement_timeout = '60s';
do $$ begin
  if current_setting('fireafter.assurance_test_target', true) is distinct from 'disposable' then
    raise exception 'Explicit disposable assurance target required';
  end if;
  if public.fireafter_responder_action_security_version() is distinct from '20260914010000'
    or public.fireafter_bundle_persistence_security_version() is distinct from '20260914034000' then
    raise exception 'Required baseline controls are not verified';
  end if;
end $$;

create temporary table fa10_fixture (
  actor_id uuid, viewer_id uuid, organization_id uuid, incident_id uuid,
  asset_id uuid, recommendation_id uuid, revision uuid, command_id uuid,
  request jsonb, action jsonb, audit jsonb, response jsonb
) on commit drop;
grant select, update on table fa10_fixture to service_role;

do $$
declare
  f record;
  snapshot jsonb;
  written_at text := '2026-09-14T01:00:00Z';
begin
  insert into fa10_fixture (actor_id, viewer_id, organization_id, incident_id,
    asset_id, recommendation_id, revision, command_id)
  values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
    gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid()) returning * into f;
  insert into auth.users (id) values (f.actor_id), (f.viewer_id);
  insert into public.organizations (id, name) values (f.organization_id, 'Disposable FA10 fixture');
  insert into public.organization_members (organization_id, user_id, role)
    values (f.organization_id, f.actor_id, 'analyst'), (f.organization_id, f.viewer_id, 'viewer');
  insert into public.incidents (id, organization_id, county, state, title, status, storm_window, selected_fire)
  values (f.incident_id, f.organization_id, 'Fixture', 'CA', 'Disposable command test', 'active', 'fixture',
    jsonb_build_object('inventoryManifest', jsonb_build_object(
      'version', '2026-09-13-inventory-v1', 'revision', f.revision,
      'assetIds', jsonb_build_array(f.asset_id), 'recommendationIds', jsonb_build_array(f.recommendation_id),
      'sourceSnapshotIds', '[]'::jsonb)));
  insert into public.assets (id, incident_id, name, asset_type, location_label, source, confidence)
    values (f.asset_id, f.incident_id, 'Fixture asset', 'Road', 'Fixture', 'disposable SQL fixture', 'Low');
  insert into public.recommendations (id, incident_id, asset_id, final_score, score_100,
    risk_level, confidence_level, recommended_action, changed_since_last_refresh, score_breakdown)
  values (f.recommendation_id, f.incident_id, f.asset_id, 20, 20, 'Low', 'Low', 'Inspect fixture', 'fixture', '{}');
  snapshot := jsonb_build_object('id', f.recommendation_id, 'incidentId', f.incident_id,
    'assetId', f.asset_id, 'score100', 20, 'riskLevel', 'Low');
  update fa10_fixture set
    request = jsonb_build_object('recommendationId', f.recommendation_id, 'action', 'annotate',
      'note', 'Disposable SQL test', 'modifiedPriority', null),
    action = jsonb_build_object('id', gen_random_uuid(), 'recommendation_id', f.recommendation_id,
      'action', 'annotate', 'note', 'Disposable SQL test', 'actor_id', f.actor_id,
      'actor_name', 'SQL fixture analyst', 'modified_priority', null,
      'recommendation_snapshot', snapshot || jsonb_build_object('domainActionId',
        'action-command-' || f.actor_id::text || '-' || f.command_id::text), 'created_at', written_at),
    audit = jsonb_build_object('id', gen_random_uuid(), 'incident_id', f.incident_id,
      'recommendation_id', f.recommendation_id, 'actor_id', f.actor_id, 'actor_name', 'SQL fixture analyst',
      'event_type', 'RecommendationAnnotated', 'summary', 'Disposable SQL fixture annotated',
      'payload', jsonb_build_object('action', 'annotate', 'note', 'Disposable SQL test',
        'recommendationSnapshot', snapshot,
        'commandId', f.command_id, 'expectedRevision', f.revision,
        'domainAuditEventId', 'audit-command-' || f.actor_id::text || '-' || f.command_id::text), 'created_at', written_at);
end;
$$;

-- Real RPC invocations; the helpers only vary fixture inputs and assert SQLSTATE.
create function pg_temp.fa10_invoke(overrides jsonb default '{}', commit_pair boolean default true)
returns jsonb language plpgsql security invoker as $$
declare f record;
begin
  select * into strict f from pg_temp.fa10_fixture;
  return public.fireafter_record_responder_command(
    case when overrides ? 'command' then (overrides->>'command')::uuid else f.command_id end,
    case when overrides ? 'actor' then (overrides->>'actor')::uuid else f.actor_id end,
    case when overrides ? 'organization' then (overrides->>'organization')::uuid else f.organization_id end,
    case when overrides ? 'revision' then (overrides->>'revision')::uuid else f.revision end,
    case when overrides ? 'request' then nullif(overrides->'request', 'null'::jsonb) else f.request end,
    case when not commit_pair then null when overrides ? 'action'
      then nullif(overrides->'action', 'null'::jsonb) else f.action end,
    case when not commit_pair then null when overrides ? 'audit'
      then nullif(overrides->'audit', 'null'::jsonb) else f.audit end);
end;
$$;
create function pg_temp.fa10_expect_error(expected text, overrides jsonb, commit_pair boolean default true)
returns void language plpgsql security invoker as $$
begin
  begin
    perform pg_temp.fa10_invoke(overrides, commit_pair);
  exception when others then
    if sqlstate <> expected then raise; end if;
    return;
  end;
  raise exception 'Expected SQLSTATE %, but command succeeded', expected;
end;
$$;
grant execute on function pg_temp.fa10_invoke(jsonb,boolean) to service_role;
grant execute on function pg_temp.fa10_expect_error(text,jsonb,boolean) to service_role;

set local role service_role;
do $$
declare f record; invalid_request jsonb; bad_action jsonb; bad_audit jsonb; answer jsonb;
  action_kind text; event_kind text; next_request jsonb; next_command uuid; metadata_key text;
begin
  select * into strict f from pg_temp.fa10_fixture;
  if public.fireafter_responder_action_security_version() is distinct from '20260914010000' then
    raise exception 'Service probe unavailable';
  end if;
  if pg_temp.fa10_invoke('{}', false) is not null
    or exists (select 1 from public.responder_command_receipts where actor_id = f.actor_id) then
    raise exception 'Preflight wrote a receipt or invented a response';
  end if;
  perform pg_temp.fa10_expect_error('FA422', '{"command":null}');
  perform pg_temp.fa10_expect_error('FA422', '{"actor":null}');
  perform pg_temp.fa10_expect_error('FA422', '{"revision":null}');
  perform pg_temp.fa10_expect_error('FA422', '{"organization":null}');
  perform pg_temp.fa10_expect_error('FA422', '{"action":null}');
  perform pg_temp.fa10_expect_error('FA422', '{"audit":null}');
  perform pg_temp.fa10_expect_error('FA409', jsonb_build_object('revision', gen_random_uuid()), false);
  perform pg_temp.fa10_expect_error('FA401', jsonb_build_object('actor', f.viewer_id));
  perform pg_temp.fa10_expect_error('FA401', jsonb_build_object('organization', gen_random_uuid()));
  for invalid_request in select value from jsonb_array_elements(jsonb_build_array(
    'null'::jsonb, '[]'::jsonb, f.request - 'note', f.request || '{"extra":true}',
    f.request || '{"recommendationId":"invalid"}', f.request || '{"action":"unknown"}',
    f.request || '{"note":4}', f.request || '{"modifiedPriority":true}',
    f.request || '{"modifiedPriority":"Impossible"}', f.request || '{"action":"modify"}',
    f.request || '{"action":"modify","note":"  ","modifiedPriority":"High"}')) loop
    perform pg_temp.fa10_expect_error('FA422', jsonb_build_object('request', invalid_request));
  end loop;
  -- Preflight isolates request validation from any action/audit mismatch.
  foreach action_kind in array array['accept', 'reject', 'annotate'] loop
    perform pg_temp.fa10_expect_error('FA422', jsonb_build_object('request',
      f.request || jsonb_build_object('action', action_kind, 'modifiedPriority', 'High')), false);
  end loop;
  -- Each storage identity is mandatory, non-null and bound to this exact command.
  for bad_action in select value from jsonb_array_elements(jsonb_build_array(
    f.action #- array['recommendation_snapshot', 'domainActionId'],
    jsonb_set(f.action, '{recommendation_snapshot,domainActionId}', 'null'),
    jsonb_set(f.action, '{recommendation_snapshot,domainActionId}', '42'),
    jsonb_set(f.action, '{recommendation_snapshot,domainActionId}', '"wrong-command"'))) loop
    perform pg_temp.fa10_expect_error('FA422', jsonb_build_object('action', bad_action));
  end loop;
  foreach metadata_key in array array['commandId', 'expectedRevision', 'domainAuditEventId'] loop
    for bad_audit in select value from jsonb_array_elements(jsonb_build_array(
      f.audit #- array['payload', metadata_key],
      jsonb_set(f.audit, array['payload', metadata_key], 'null'),
      jsonb_set(f.audit, array['payload', metadata_key], '42'),
      jsonb_set(f.audit, array['payload', metadata_key], '"wrong-command"'))) loop
      perform pg_temp.fa10_expect_error('FA422', jsonb_build_object('audit', bad_audit));
    end loop;
  end loop;
  for bad_action in select value from jsonb_array_elements(jsonb_build_array(
    f.action || jsonb_build_object('actor_id', f.viewer_id),
    f.action || jsonb_build_object('recommendation_id', gen_random_uuid()),
    f.action || '{"id":null}', f.action || '{"id":"invalid"}',
    f.action || '{"action":"accept"}', f.action || '{"note":"different"}',
    f.action || '{"modified_priority":"High"}', f.action || '{"created_at":"infinity"}',
    f.action || '{"recommendation_snapshot":false}',
    jsonb_set(f.action, '{recommendation_snapshot,assetId}', to_jsonb(gen_random_uuid())))) loop
    perform pg_temp.fa10_expect_error('FA422', jsonb_build_object('action', bad_action));
  end loop;
  for bad_audit in select value from jsonb_array_elements(jsonb_build_array(
    f.audit || jsonb_build_object('actor_id', f.viewer_id),
    f.audit || jsonb_build_object('incident_id', gen_random_uuid()),
    f.audit || jsonb_build_object('recommendation_id', gen_random_uuid()),
    f.audit || '{"event_type":"RecommendationAccepted"}', f.audit || '{"actor_name":"different"}',
    f.audit || '{"created_at":"2026-09-14T01:00:01Z"}',
    f.audit || '{"payload":false}',
    jsonb_set(f.audit, '{payload,note}', '"different"'),
    jsonb_set(f.audit, '{payload,recommendationSnapshot,score100}', '99'))) loop
    perform pg_temp.fa10_expect_error('FA422', jsonb_build_object('audit', bad_audit));
  end loop;
  if exists (select 1 from public.responder_actions where recommendation_id = f.recommendation_id)
    or exists (select 1 from public.audit_events where incident_id = f.incident_id)
    or exists (select 1 from public.responder_command_receipts where actor_id = f.actor_id) then
    raise exception 'Invalid command left durable rows';
  end if;

  -- The TS row mapper omits undefined nullable priorities; request shape stays strict.
  answer := pg_temp.fa10_invoke(jsonb_build_object('action', f.action - 'modified_priority'));
  if answer is distinct from jsonb_build_object(
    'action', (select to_jsonb(a) from public.responder_actions a where id = (f.action->>'id')::uuid),
    'auditEvent', (select to_jsonb(e) from public.audit_events e where id = (f.audit->>'id')::uuid)) then
    raise exception 'Response is not the persisted row pair';
  end if;
  if answer->'auditEvent'->'payload' is distinct from f.audit->'payload'
    or answer->'action'->'recommendation_snapshot' is distinct from f.action->'recommendation_snapshot'
    or (answer->'action'->>'created_at')::timestamptz is distinct from (f.action->>'created_at')::timestamptz then
    raise exception 'Receipt lost domain IDs, command metadata or persisted time';
  end if;
  update pg_temp.fa10_fixture set response = answer;
  if pg_temp.fa10_invoke() is distinct from answer or pg_temp.fa10_invoke('{}', false) is distinct from answer then
    raise exception 'Replay did not return the canonical receipt';
  end if;
  perform pg_temp.fa10_expect_error('FA408', jsonb_build_object('request', f.request || '{"note":"changed"}'));
  perform pg_temp.fa10_expect_error('FA408', jsonb_build_object('revision', gen_random_uuid()), false);
  next_command := gen_random_uuid();
  bad_action := jsonb_set(f.action, '{recommendation_snapshot,domainActionId}',
    to_jsonb('action-command-' || f.actor_id::text || '-' || next_command::text));
  bad_audit := f.audit || jsonb_build_object('payload', (f.audit->'payload') || jsonb_build_object(
    'commandId', next_command, 'domainAuditEventId', 'audit-command-' || f.actor_id::text || '-' || next_command::text));
  perform pg_temp.fa10_expect_error('FA422', jsonb_build_object('command', next_command, 'action', bad_action, 'audit', bad_audit));
  -- The action insert succeeds first; a duplicate audit id must undo that insert.
  bad_action := f.action || jsonb_build_object('id', gen_random_uuid());
  next_command := gen_random_uuid();
  bad_action := jsonb_set(bad_action, '{recommendation_snapshot,domainActionId}',
    to_jsonb('action-command-' || f.actor_id::text || '-' || next_command::text));
  bad_audit := f.audit || jsonb_build_object('payload', (f.audit->'payload') || jsonb_build_object(
    'commandId', next_command, 'domainAuditEventId', 'audit-command-' || f.actor_id::text || '-' || next_command::text));
  perform pg_temp.fa10_expect_error('FA422', jsonb_build_object('command', next_command, 'action', bad_action, 'audit', bad_audit));
  if exists (select 1 from public.responder_actions where id = (bad_action->>'id')::uuid)
    or (select count(*) from public.responder_command_receipts where actor_id = f.actor_id) <> 1 then
    raise exception 'Late audit conflict left a partial command';
  end if;
  foreach action_kind in array array['accept', 'modify', 'reject'] loop
    next_command := gen_random_uuid();
    event_kind := case action_kind when 'accept' then 'RecommendationAccepted'
      when 'modify' then 'RecommendationModified' else 'RecommendationRejected' end;
    next_request := f.request || jsonb_build_object('action', action_kind,
      'modifiedPriority', case when action_kind = 'modify' then 'High' else null end);
    bad_action := f.action || jsonb_build_object('id', gen_random_uuid(), 'action', action_kind,
      'modified_priority', next_request->'modifiedPriority',
      'recommendation_snapshot', (f.action->'recommendation_snapshot') || jsonb_build_object(
        'domainActionId', 'action-command-' || f.actor_id::text || '-' || next_command::text));
    bad_audit := f.audit || jsonb_build_object('id', gen_random_uuid(), 'event_type', event_kind,
      'payload', (f.audit->'payload') || jsonb_build_object('action', action_kind,
        'commandId', next_command,
        'domainAuditEventId', 'audit-command-' || f.actor_id::text || '-' || next_command::text,
        'modifiedPriority', next_request->'modifiedPriority'));
    answer := pg_temp.fa10_invoke(jsonb_build_object('command', next_command,
      'request', next_request, 'action', bad_action, 'audit', bad_audit));
    if answer->'action'->>'action' is distinct from action_kind
      or answer->'auditEvent'->>'event_type' is distinct from event_kind then
      raise exception 'Valid decision kind did not persist';
    end if;
  end loop;
  if (select count(*) from public.responder_actions where recommendation_id = f.recommendation_id) <> 4
    or (select count(*) from public.audit_events where incident_id = f.incident_id) <> 4
    or (select count(*) from public.responder_command_receipts where actor_id = f.actor_id) <> 4 then
    raise exception 'Commands did not produce exactly four row pairs and receipts';
  end if;
end;
$$;
reset role;

savepoint inventory_drift;
update public.incidents set selected_fire = jsonb_set(selected_fire, '{inventoryManifest,assetIds}', '[]')
  where id = (select incident_id from fa10_fixture);
set local role service_role;
select pg_temp.fa10_expect_error('FA409', jsonb_build_object('command', gen_random_uuid()));
reset role;
rollback to savepoint inventory_drift;
update public.incidents set selected_fire = jsonb_set(selected_fire, '{inventoryManifest,recommendationIds}', '[]')
  where id = (select incident_id from fa10_fixture);
set local role service_role;
select pg_temp.fa10_expect_error('FA409', jsonb_build_object('command', gen_random_uuid()), false);
reset role;
rollback to savepoint inventory_drift;
update public.incidents set selected_fire = jsonb_set(selected_fire, '{inventoryManifest,version}', '"unknown"')
  where id = (select incident_id from fa10_fixture);
set local role service_role;
select pg_temp.fa10_expect_error('FA409', jsonb_build_object('command', gen_random_uuid()), false);
reset role;
rollback to savepoint inventory_drift;

-- A refresh retires the inventory. Original replay still succeeds; a new command does not.
update public.incidents set selected_fire = jsonb_set(selected_fire, '{inventoryManifest,revision}', to_jsonb(gen_random_uuid()))
  where id = (select incident_id from fa10_fixture);
set local role service_role;
do $$ begin
  if pg_temp.fa10_invoke() is distinct from (select response from pg_temp.fa10_fixture)
    or pg_temp.fa10_invoke('{}', false) is distinct from (select response from pg_temp.fa10_fixture) then
    raise exception 'Refresh destroyed the original receipt';
  end if;
  perform pg_temp.fa10_expect_error('FA409', jsonb_build_object('command', gen_random_uuid()), false);
end $$;
reset role;

-- Current authority is mandatory even when a receipt exists.
update public.organization_members set role = 'viewer' where user_id = (select actor_id from fa10_fixture);
set local role service_role;
select pg_temp.fa10_expect_error('FA401', '{}');
select pg_temp.fa10_expect_error('FA401', '{}', false);
reset role;
delete from public.organization_members where user_id = (select actor_id from fa10_fixture);
set local role service_role;
select pg_temp.fa10_expect_error('FA401', '{}');
reset role;
insert into public.organization_members (organization_id, user_id, role)
  select organization_id, actor_id, 'incident_commander' from fa10_fixture;
set local role service_role;
do $$ begin
  if pg_temp.fa10_invoke('{}', false) is distinct from (select response from pg_temp.fa10_fixture) then
    raise exception 'Restored commander authority could not replay';
  end if;
  begin
    perform public.fireafter_record_responder_action(null, null);
    raise exception 'Legacy writer remained executable';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.responder_command_receipts select * from public.responder_command_receipts;
    raise exception 'Service role bypassed the command boundary';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- Immutability is tested as the privileged migration principal, not by lack of grants.
do $$ begin
  begin
    update public.responder_command_receipts set response = '{}' where actor_id = (select actor_id from fa10_fixture);
  exception when raise_exception then
    if sqlerrm <> 'FireAfter audit/action records are append-only' then raise; end if;
  end;
  if (select response from public.responder_command_receipts where actor_id = (select actor_id from fa10_fixture)
      and command_id = (select command_id from fa10_fixture))
    is distinct from (select response from fa10_fixture) then raise exception 'Receipt was mutable'; end if;
  begin
    delete from public.responder_command_receipts where actor_id = (select actor_id from fa10_fixture);
  exception when raise_exception then
    if sqlerrm <> 'FireAfter audit/action records are append-only' then raise; end if;
  end;
  if (select count(*) from public.responder_command_receipts where actor_id = (select actor_id from fa10_fixture)) <> 4 then
    raise exception 'Receipt deletion was permitted';
  end if;
  begin
    truncate public.responder_command_receipts;
  exception when raise_exception then
    if sqlerrm <> 'FireAfter audit/action records are append-only' then raise; end if;
  end;
  if not exists (select 1 from public.responder_command_receipts where actor_id = (select actor_id from fa10_fixture)) then
    raise exception 'Receipt truncation was permitted';
  end if;
end $$;

set local role anon;
do $$ begin
  begin
    perform command_id from public.responder_command_receipts limit 1;
    raise exception 'Browser read raw receipts';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.fireafter_record_responder_command(null, null, null, null, null, null, null);
    raise exception 'Browser executed commands';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
set local role authenticated;
do $$ begin
  begin
    perform * from public.responder_command_receipts limit 1;
    raise exception 'Browser read raw receipts';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.fireafter_record_responder_command(null, null, null, null, null, null, null);
    raise exception 'Browser executed commands';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

savepoint receipt_drift;
grant select (response) on public.responder_command_receipts to authenticated;
do $$ begin
  if public.fireafter_responder_action_security_version() is not null then raise exception 'Column drift was missed'; end if;
end $$;
rollback to savepoint receipt_drift;
alter table public.responder_command_receipts disable row level security;
do $$ begin
  if public.fireafter_responder_action_security_version() is not null then raise exception 'RLS drift was missed'; end if;
end $$;
rollback to savepoint receipt_drift;
grant execute on function public.fireafter_record_responder_action(jsonb,jsonb) to service_role;
do $$ begin
  if public.fireafter_responder_action_security_version() is not null then raise exception 'Legacy writer drift was missed'; end if;
end $$;
rollback to savepoint receipt_drift;
do $$ begin
  if public.fireafter_responder_action_security_version() is distinct from '20260914010000'
    or public.fireafter_bundle_persistence_security_version() is distinct from '20260914034000' then
    raise exception 'Rollback did not restore the baseline';
  end if;
end $$;
rollback;
