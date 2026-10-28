-- New Sentinel native database ONLY. Transport compatibility, not an authority grant.
-- Modern PostgREST sets verified request.jwt.claims; inherited migration checks
-- require the legacy request.jwt.claim.role GUC. Keep both representations equal.
begin;
create schema if not exists sentinel_local_runtime;
revoke all on schema sentinel_local_runtime from public;
grant usage on schema sentinel_local_runtime to anon, authenticated, service_role;
create or replace function sentinel_local_runtime.bridge_verified_claim_role()
returns void language plpgsql volatile security invoker
set search_path = ''
as $$
declare v_role text := coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role','anon');
begin
 if v_role not in ('anon','authenticated','service_role') or v_role is distinct from current_user::text then
  raise exception 'Verified JWT role differs from PostgREST request role' using errcode='42501';
 end if;
 perform pg_catalog.set_config('request.jwt.claim.role',v_role,true);
end;
$$;
revoke all on function sentinel_local_runtime.bridge_verified_claim_role() from public;
grant execute on function sentinel_local_runtime.bridge_verified_claim_role() to anon,authenticated,service_role;
alter role authenticator in database postgres set pgrst.db_pre_request = 'sentinel_local_runtime.bridge_verified_claim_role';
notify pgrst,'reload config';
commit;
