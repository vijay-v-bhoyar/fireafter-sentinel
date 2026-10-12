set local lock_timeout = '2s';
set local statement_timeout = '60s';

-- Keep the responder decision and its audit evidence in one transaction. The
-- service role is the only caller because route authorization and actor
-- stamping happen before this database boundary.
create or replace function public.fireafter_record_responder_action(
  p_action jsonb,
  p_audit_event jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  action_id uuid;
  action_recommendation_id uuid;
  audit_recommendation_id uuid;
  action_type text;
  audit_event_type text;
begin
  if p_action is null or p_audit_event is null then
    raise exception 'Responder action and audit event payloads are required.'
      using errcode = '22023';
  end if;

  action_id := (p_action->>'id')::uuid;
  action_recommendation_id := (p_action->>'recommendation_id')::uuid;
  audit_recommendation_id := nullif(p_audit_event->>'recommendation_id', '')::uuid;
  action_type := p_action->>'action';
  audit_event_type := p_audit_event->>'event_type';

  if audit_recommendation_id is distinct from action_recommendation_id then
    raise exception 'Responder action and audit recommendation ids must match.'
      using errcode = '22023';
  end if;

  if (action_type, audit_event_type) not in (
    ('accept', 'RecommendationAccepted'),
    ('modify', 'RecommendationModified'),
    ('reject', 'RecommendationRejected'),
    ('annotate', 'RecommendationAnnotated')
  ) then
    raise exception 'Responder action and audit event types do not match.'
      using errcode = '22023';
  end if;

  insert into public.responder_actions (
    id,
    recommendation_id,
    action,
    note,
    actor_id,
    actor_name,
    modified_priority,
    recommendation_snapshot,
    created_at
  ) values (
    action_id,
    action_recommendation_id,
    action_type,
    coalesce(p_action->>'note', ''),
    nullif(p_action->>'actor_id', '')::uuid,
    p_action->>'actor_name',
    nullif(p_action->>'modified_priority', ''),
    p_action->'recommendation_snapshot',
    (p_action->>'created_at')::timestamptz
  ) on conflict (id) do nothing;

  insert into public.audit_events (
    id,
    incident_id,
    recommendation_id,
    actor_id,
    actor_name,
    event_type,
    summary,
    payload,
    created_at
  ) values (
    (p_audit_event->>'id')::uuid,
    (p_audit_event->>'incident_id')::uuid,
    audit_recommendation_id,
    nullif(p_audit_event->>'actor_id', '')::uuid,
    p_audit_event->>'actor_name',
    audit_event_type,
    p_audit_event->>'summary',
    coalesce(p_audit_event->'payload', '{}'::jsonb),
    (p_audit_event->>'created_at')::timestamptz
  ) on conflict (id) do nothing;
end;
$$;

revoke all
on function public.fireafter_record_responder_action(jsonb, jsonb)
from public, anon, authenticated;

grant execute
on function public.fireafter_record_responder_action(jsonb, jsonb)
to service_role;

create or replace function public.fireafter_responder_action_security_version()
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when to_regprocedure('public.fireafter_record_responder_action(jsonb,jsonb)') is not null
    then '20260906120000'::text
    else null::text
  end;
$$;

revoke all
on function public.fireafter_responder_action_security_version()
from public, anon, authenticated;

grant execute
on function public.fireafter_responder_action_security_version()
to service_role;
