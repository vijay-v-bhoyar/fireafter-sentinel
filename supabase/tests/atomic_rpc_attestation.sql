-- Operator-only tests on a named disposable Supabase clone, never production.
-- Permission/configuration/body changes are deliberately rolled back.
\set ON_ERROR_STOP on
begin;
set local lock_timeout = '2s';
set local statement_timeout = '60s';
do $$
begin
  if current_setting('fireafter.assurance_test_target', true) is distinct from 'disposable' then
    raise exception 'Explicit disposable assurance target required';
  end if;
  if public.fireafter_responder_action_security_version() is distinct from '20260913234000'
    or public.fireafter_bundle_persistence_security_version() is distinct from '20260913234000' then
    raise exception 'Baseline atomic attestation is not verified';
  end if;
end;
$$;

set local role anon;
do $$
begin
  begin
    perform public.fireafter_record_responder_action(null::jsonb, null::jsonb);
    raise exception 'Browser role executed an operational RPC';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.fireafter_responder_action_security_version();
    raise exception 'Browser role executed an attestation probe';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.fireafter_persist_bundle(null::jsonb, null::jsonb, null::jsonb, null::jsonb, null::jsonb, null::jsonb, null::jsonb);
    raise exception 'Browser role executed an operational RPC';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.fireafter_bundle_persistence_security_version();
    raise exception 'Browser role executed an attestation probe';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

set local role authenticated;
do $$
begin
  begin
    perform public.fireafter_record_responder_action(null::jsonb, null::jsonb);
    raise exception 'Browser role executed an operational RPC';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.fireafter_responder_action_security_version();
    raise exception 'Browser role executed an attestation probe';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.fireafter_persist_bundle(null::jsonb, null::jsonb, null::jsonb, null::jsonb, null::jsonb, null::jsonb, null::jsonb);
    raise exception 'Browser role executed an operational RPC';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.fireafter_bundle_persistence_security_version();
    raise exception 'Browser role executed an attestation probe';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

set local role service_role;
do $$ begin
  if public.fireafter_responder_action_security_version() is distinct from '20260913234000'
    or public.fireafter_bundle_persistence_security_version() is distinct from '20260913234000' then
    raise exception 'Service attestation unavailable';
  end if;
end $$;
reset role;

savepoint atomic_drift;

-- PUBLIC execution: fireafter_record_responder_action
grant execute on function public.fireafter_record_responder_action(jsonb,jsonb) to public;
do $$ begin
  if public.fireafter_responder_action_security_version() is not null then
    raise exception 'Atomic attestation missed PUBLIC execution drift';
  end if;
end $$;
rollback to savepoint atomic_drift;

-- anon execution: fireafter_record_responder_action
grant execute on function public.fireafter_record_responder_action(jsonb,jsonb) to anon;
do $$ begin
  if public.fireafter_responder_action_security_version() is not null then
    raise exception 'Atomic attestation missed anon execution drift';
  end if;
end $$;
rollback to savepoint atomic_drift;

-- authenticated execution: fireafter_record_responder_action
grant execute on function public.fireafter_record_responder_action(jsonb,jsonb) to authenticated;
do $$ begin
  if public.fireafter_responder_action_security_version() is not null then
    raise exception 'Atomic attestation missed authenticated execution drift';
  end if;
end $$;
rollback to savepoint atomic_drift;

-- service execution loss: fireafter_record_responder_action
revoke execute on function public.fireafter_record_responder_action(jsonb,jsonb) from service_role;
do $$ begin
  if public.fireafter_responder_action_security_version() is not null then
    raise exception 'Atomic attestation missed service execution loss drift';
  end if;
end $$;
rollback to savepoint atomic_drift;

-- execution identity: fireafter_record_responder_action
alter function public.fireafter_record_responder_action(jsonb,jsonb) security invoker;
do $$ begin
  if public.fireafter_responder_action_security_version() is not null then
    raise exception 'Atomic attestation missed execution identity drift';
  end if;
end $$;
rollback to savepoint atomic_drift;

-- search path: fireafter_record_responder_action
alter function public.fireafter_record_responder_action(jsonb,jsonb) set search_path = pg_catalog;
do $$ begin
  if public.fireafter_responder_action_security_version() is not null then
    raise exception 'Atomic attestation missed search path drift';
  end if;
end $$;
rollback to savepoint atomic_drift;

-- extra configuration: fireafter_record_responder_action
alter function public.fireafter_record_responder_action(jsonb,jsonb) set statement_timeout = '1s';
do $$ begin
  if public.fireafter_responder_action_security_version() is not null then
    raise exception 'Atomic attestation missed extra configuration drift';
  end if;
end $$;
rollback to savepoint atomic_drift;

-- strictness: fireafter_record_responder_action
alter function public.fireafter_record_responder_action(jsonb,jsonb) strict;
do $$ begin
  if public.fireafter_responder_action_security_version() is not null then
    raise exception 'Atomic attestation missed strictness drift';
  end if;
end $$;
rollback to savepoint atomic_drift;

-- volatility: fireafter_record_responder_action
alter function public.fireafter_record_responder_action(jsonb,jsonb) immutable;
do $$ begin
  if public.fireafter_responder_action_security_version() is not null then
    raise exception 'Atomic attestation missed volatility drift';
  end if;
end $$;
rollback to savepoint atomic_drift;

-- parallel mode: fireafter_record_responder_action
alter function public.fireafter_record_responder_action(jsonb,jsonb) parallel safe;
do $$ begin
  if public.fireafter_responder_action_security_version() is not null then
    raise exception 'Atomic attestation missed parallel mode drift';
  end if;
end $$;
rollback to savepoint atomic_drift;

-- owner: fireafter_record_responder_action
alter function public.fireafter_record_responder_action(jsonb,jsonb) owner to authenticated;
do $$ begin
  if public.fireafter_responder_action_security_version() is not null then
    raise exception 'Atomic attestation missed owner drift';
  end if;
end $$;
rollback to savepoint atomic_drift;

-- same-signature body: fireafter_record_responder_action
create or replace function public.fireafter_record_responder_action(p_action jsonb, p_audit_event jsonb)
returns void language plpgsql security definer set search_path = public
as $changed$ begin return; end; $changed$;
do $$ begin
  if public.fireafter_responder_action_security_version() is not null then
    raise exception 'Atomic attestation missed same-signature body drift';
  end if;
end $$;
rollback to savepoint atomic_drift;

-- probe execution exposure: fireafter_record_responder_action
grant execute on function public.fireafter_responder_action_security_version() to authenticated;
do $$ begin
  if public.fireafter_responder_action_security_version() is not null then
    raise exception 'Atomic attestation missed probe execution exposure drift';
  end if;
end $$;
rollback to savepoint atomic_drift;

-- PUBLIC execution: fireafter_persist_bundle
grant execute on function public.fireafter_persist_bundle(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) to public;
do $$ begin
  if public.fireafter_bundle_persistence_security_version() is not null then
    raise exception 'Atomic attestation missed PUBLIC execution drift';
  end if;
end $$;
rollback to savepoint atomic_drift;

-- anon execution: fireafter_persist_bundle
grant execute on function public.fireafter_persist_bundle(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) to anon;
do $$ begin
  if public.fireafter_bundle_persistence_security_version() is not null then
    raise exception 'Atomic attestation missed anon execution drift';
  end if;
end $$;
rollback to savepoint atomic_drift;

-- authenticated execution: fireafter_persist_bundle
grant execute on function public.fireafter_persist_bundle(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) to authenticated;
do $$ begin
  if public.fireafter_bundle_persistence_security_version() is not null then
    raise exception 'Atomic attestation missed authenticated execution drift';
  end if;
end $$;
rollback to savepoint atomic_drift;

-- service execution loss: fireafter_persist_bundle
revoke execute on function public.fireafter_persist_bundle(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) from service_role;
do $$ begin
  if public.fireafter_bundle_persistence_security_version() is not null then
    raise exception 'Atomic attestation missed service execution loss drift';
  end if;
end $$;
rollback to savepoint atomic_drift;

-- execution identity: fireafter_persist_bundle
alter function public.fireafter_persist_bundle(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) security invoker;
do $$ begin
  if public.fireafter_bundle_persistence_security_version() is not null then
    raise exception 'Atomic attestation missed execution identity drift';
  end if;
end $$;
rollback to savepoint atomic_drift;

-- search path: fireafter_persist_bundle
alter function public.fireafter_persist_bundle(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) set search_path = pg_catalog;
do $$ begin
  if public.fireafter_bundle_persistence_security_version() is not null then
    raise exception 'Atomic attestation missed search path drift';
  end if;
end $$;
rollback to savepoint atomic_drift;

-- extra configuration: fireafter_persist_bundle
alter function public.fireafter_persist_bundle(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) set statement_timeout = '1s';
do $$ begin
  if public.fireafter_bundle_persistence_security_version() is not null then
    raise exception 'Atomic attestation missed extra configuration drift';
  end if;
end $$;
rollback to savepoint atomic_drift;

-- strictness: fireafter_persist_bundle
alter function public.fireafter_persist_bundle(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) strict;
do $$ begin
  if public.fireafter_bundle_persistence_security_version() is not null then
    raise exception 'Atomic attestation missed strictness drift';
  end if;
end $$;
rollback to savepoint atomic_drift;

-- volatility: fireafter_persist_bundle
alter function public.fireafter_persist_bundle(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) immutable;
do $$ begin
  if public.fireafter_bundle_persistence_security_version() is not null then
    raise exception 'Atomic attestation missed volatility drift';
  end if;
end $$;
rollback to savepoint atomic_drift;

-- parallel mode: fireafter_persist_bundle
alter function public.fireafter_persist_bundle(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) parallel safe;
do $$ begin
  if public.fireafter_bundle_persistence_security_version() is not null then
    raise exception 'Atomic attestation missed parallel mode drift';
  end if;
end $$;
rollback to savepoint atomic_drift;

-- owner: fireafter_persist_bundle
alter function public.fireafter_persist_bundle(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) owner to authenticated;
do $$ begin
  if public.fireafter_bundle_persistence_security_version() is not null then
    raise exception 'Atomic attestation missed owner drift';
  end if;
end $$;
rollback to savepoint atomic_drift;

-- same-signature body: fireafter_persist_bundle
create or replace function public.fireafter_persist_bundle(p_organization jsonb, p_incident jsonb, p_source_snapshots jsonb, p_assets jsonb, p_recommendations jsonb, p_responder_actions jsonb, p_audit_events jsonb)
returns void language plpgsql security definer set search_path = public
as $changed$ begin return; end; $changed$;
do $$ begin
  if public.fireafter_bundle_persistence_security_version() is not null then
    raise exception 'Atomic attestation missed same-signature body drift';
  end if;
end $$;
rollback to savepoint atomic_drift;

-- probe execution exposure: fireafter_persist_bundle
grant execute on function public.fireafter_bundle_persistence_security_version() to authenticated;
do $$ begin
  if public.fireafter_bundle_persistence_security_version() is not null then
    raise exception 'Atomic attestation missed probe execution exposure drift';
  end if;
end $$;
rollback to savepoint atomic_drift;

rollback;
