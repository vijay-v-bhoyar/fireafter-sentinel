-- Sentinel's independent database only. A locking read must be VOLATILE in
-- PostgreSQL. Preserve the existing body, operator binding and privileges.
set local lock_timeout = '2s';
set local statement_timeout = '20s';

alter function public.fireafter_get_account_issuance_as_operator(uuid) volatile;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_proc p
    where p.oid = pg_catalog.to_regprocedure('public.fireafter_get_account_issuance_as_operator(uuid)')
      and p.provolatile = 'v' and p.prosecdef
      and p.proowner = 'postgres'::regrole
      and p.proconfig = array['search_path=""','statement_timeout=20s']::text[]
      and pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and not pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
      and not pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')
  ) or public.fireafter_operator_account_issuance_audit_security_version() is distinct from '20260915130000' then
    raise exception 'Operator recovery controls failed after volatility repair';
  end if;
end;
$$;
