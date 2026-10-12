import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadModule, parseSync } from "libpg-query";
import { ISSUANCE_ATTESTATION_CONTRACT,
  ISSUANCE_ATTESTATION_SHA256, ISSUANCE_COORDINATOR_BODIES } from "./issuance-attestation-contract.mjs";

// Offline PostgreSQL 17 syntax validation; no database connections or SQL execution.
await loadModule();

export function hasValidPostgresSyntax(sql) {
  try {
    const tree = parseSync(sql);
    for (const statement of tree.stmts ?? []) {
      const options = statement.stmt?.CreateFunctionStmt?.options?.map(option => option.DefElem) ?? [];
      if (options.find(option => option.defname === "language")?.arg?.String?.sval === "sql") {
        const body = options.find(option => option.defname === "as")?.arg?.List?.items?.[0]?.String?.sval;
        if (typeof body === "string") parseSync(body);
      }
    }
    return true;
  } catch { return false; }
}

export const SECURITY_PROBES = [
  {
    name: "serverOwnedWrites",
    rpc: "fireafter_server_owned_write_security_version",
    expectedVersion: "20260914070900",
    migration: "supabase/migrations/20260914070900_effective_write_privileges.sql",
  },
  {
    name: "atomicResponderAction",
    rpc: "fireafter_responder_action_security_version",
    expectedVersion: "20260914010000",
    migration: "supabase/migrations/20260914010000_responder_command_contract.sql",
  },
  {
    name: "atomicBundlePersistence",
    rpc: "fireafter_bundle_persistence_security_version",
    expectedVersion: "20261002010000",
    migration: "supabase/migrations/20261002010000_bulk_bundle_capacity.sql",
  },
  {
    name: "operatorAccountIssuanceAudit",
    rpc: "fireafter_operator_account_issuance_audit_security_version",
    expectedVersion: "20260915130000",
    migration: "supabase/migrations/20260915130000_operator_account_issuance_retention.sql",
  },
  {
    name: "serverOwnedReads",
    rpc: "fireafter_server_owned_read_security_version",
    expectedVersion: "20260913230300",
    migration: "supabase/migrations/20260913230300_server_owned_operational_reads.sql",
  },
  {
    name: "scheduledRefresh",
    rpc: "fireafter_scheduled_refresh_security_version",
    expectedVersion: "20261002000000",
    migration: "supabase/migrations/20261002000000_scheduled_refresh_claim_ambiguity_fix.sql",
  },
];

const operationalTables = [
  "organizations",
  "organization_members",
  "incidents",
  "source_runs",
  "source_snapshots",
  "assets",
  "recommendations",
  "responder_actions",
  "audit_events",
];

const serverOwnedWriteContract = [
  { id: "lock-timeout", sql: "set local lock_timeout = '2s';" },
  { id: "statement-timeout", sql: "set local statement_timeout = '60s';" },
  ...operationalTables.map((table) => ({
    id: `rls-${table}`,
    sql: `alter table public.${table} enable row level security;`,
  })),
  {
    id: "browser-write-revocation",
    sql: `revoke insert, update, delete on table ${operationalTables.map((table) => `public.${table}`).join(", ")} from public, anon, authenticated;`,
  },
  {
    id: "incident-policy-removal",
    sql: 'drop policy if exists "members can manage incidents" on public.incidents;',
  },
  {
    id: "responder-policy-removal",
    sql: 'drop policy if exists "members can create actions" on public.responder_actions;',
  },
  {
    id: "server-owned-probe",
    sql: "create or replace function public.fireafter_server_owned_write_security_version()",
  },
  { id: "all-tables-check", sql: "count(*) = 9 as all_tables_present" },
  { id: "rls-check", sql: "bool_and(c.relrowsecurity) as rls_enabled" },
  { id: "privilege-check", sql: "pg_catalog.has_table_privilege(" },
  { id: "policy-check", sql: "from pg_catalog.pg_policies" },
  {
    id: "policy-role-check",
    sql: "roles && array['public'::name, 'anon'::name, 'authenticated'::name]",
  },
  { id: "server-owned-version", sql: "then '20260904053500'::text" },
  {
    id: "server-owned-probe-revocation",
    sql: "revoke all on function public.fireafter_server_owned_write_security_version() from public, anon, authenticated;",
  },
  {
    id: "server-owned-probe-grant",
    sql: "grant execute on function public.fireafter_server_owned_write_security_version() to service_role;",
  },
];

const atomicResponderContract = [
  { id: "lock-timeout", sql: "set local lock_timeout = '2s';" },
  { id: "statement-timeout", sql: "set local statement_timeout = '60s';" },
  {
    id: "atomic-responder-rpc",
    sql: "create or replace function public.fireafter_record_responder_action( p_action jsonb, p_audit_event jsonb )",
  },
  {
    id: "atomic-responder-security-definer",
    sql: "returns void language plpgsql security definer set search_path = public as $$",
  },
  { id: "atomic-responder-table", sql: "insert into public.responder_actions" },
  { id: "atomic-audit-table", sql: "insert into public.audit_events" },
  { id: "atomic-responder-idempotency", sql: "on conflict (id) do nothing;" },
  {
    id: "atomic-responder-probe",
    sql: "create or replace function public.fireafter_responder_action_security_version()",
  },
  {
    id: "atomic-responder-existence-check",
    sql: "to_regprocedure('public.fireafter_record_responder_action(jsonb,jsonb)') is not null",
  },
  { id: "atomic-responder-version", sql: "then '20260906120000'::text" },
  {
    id: "atomic-responder-rpc-revocation",
    sql: "revoke all on function public.fireafter_record_responder_action(jsonb, jsonb) from public, anon, authenticated;",
  },
  {
    id: "atomic-responder-rpc-grant",
    sql: "grant execute on function public.fireafter_record_responder_action(jsonb, jsonb) to service_role;",
  },
  {
    id: "atomic-responder-probe-revocation",
    sql: "revoke all on function public.fireafter_responder_action_security_version() from public, anon, authenticated;",
  },
  {
    id: "atomic-responder-probe-grant",
    sql: "grant execute on function public.fireafter_responder_action_security_version() to service_role;",
  },
];

const atomicBundleContract = [
  { id: "lock-timeout", sql: "set local lock_timeout = '2s';" },
  { id: "statement-timeout", sql: "set local statement_timeout = '60s';" },
  {
    id: "atomic-bundle-rpc",
    sql: "create or replace function public.fireafter_persist_bundle( p_organization jsonb, p_incident jsonb, p_source_snapshots jsonb, p_assets jsonb, p_recommendations jsonb, p_responder_actions jsonb, p_audit_events jsonb )",
  },
  {
    id: "atomic-bundle-security-definer",
    sql: "returns void language plpgsql security definer set search_path = public as $$",
  },
  { id: "atomic-bundle-validation", sql: "jsonb_typeof(p_organization) <> 'object'" },
  { id: "atomic-bundle-snapshots", sql: "delete from public.source_snapshots" },
  { id: "atomic-bundle-incidents", sql: "insert into public.incidents" },
  { id: "atomic-bundle-recommendations", sql: "insert into public.recommendations" },
  { id: "atomic-bundle-idempotency", sql: "on conflict (id) do nothing;" },
  {
    id: "atomic-bundle-probe",
    sql: "create or replace function public.fireafter_bundle_persistence_security_version()",
  },
  {
    id: "atomic-bundle-existence-check",
    sql: "to_regprocedure('public.fireafter_persist_bundle(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb)') is not null",
  },
  { id: "atomic-bundle-version", sql: "then '20260910120000'::text" },
  {
    id: "atomic-bundle-rpc-revocation",
    sql: "revoke all on function public.fireafter_persist_bundle(jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb) from public, anon, authenticated;",
  },
  {
    id: "atomic-bundle-rpc-grant",
    sql: "grant execute on function public.fireafter_persist_bundle(jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb) to service_role;",
  },
  {
    id: "atomic-bundle-probe-revocation",
    sql: "revoke all on function public.fireafter_bundle_persistence_security_version() from public, anon, authenticated;",
  },
  {
    id: "atomic-bundle-probe-grant",
    sql: "grant execute on function public.fireafter_bundle_persistence_security_version() to service_role;",
  },
];

const operatorAccountIssuanceContract = [
  { id: "lock-timeout", sql: "set local lock_timeout = '2s';" },
  { id: "statement-timeout", sql: "set local statement_timeout = '60s';" },
  {
    id: "operator-issuance-table",
    sql: "create table if not exists public.operator_account_issuance_events (",
  },
  {
    id: "operator-issuance-rls",
    sql: "alter table public.operator_account_issuance_events enable row level security;",
  },
  {
    id: "operator-issuance-client-revocation",
    sql: "revoke all on table public.operator_account_issuance_events from public, anon, authenticated;",
  },
  {
    id: "operator-issuance-service-role-grant",
    sql: "grant insert on table public.operator_account_issuance_events to service_role;",
  },
  {
    id: "operator-issuance-event-check",
    sql: "check (event_type in ('started', 'succeeded', 'failed'))",
  },
  {
    id: "operator-issuance-failure-check",
    sql: "check (failure_code is null or failure_code = 'account_issuance_failed')",
  },
  {
    id: "operator-issuance-idempotency",
    sql: "unique (attempt_id, event_type)",
  },
  {
    id: "operator-issuance-terminal-idempotency",
    sql: "create unique index if not exists operator_account_issuance_events_one_terminal_idx",
  },
  {
    id: "operator-issuance-probe",
    sql: "create or replace function public.fireafter_operator_account_issuance_audit_security_version()",
  },
  {
    id: "operator-issuance-version",
    sql: "then '20260910173914'::text",
  },
  {
    id: "operator-issuance-probe-revocation",
    sql: "revoke all on function public.fireafter_operator_account_issuance_audit_security_version() from public, anon, authenticated;",
  },
  {
    id: "operator-issuance-probe-grant",
    sql: "grant execute on function public.fireafter_operator_account_issuance_audit_security_version() to service_role;",
  },
];

const operationalReadContract = [
  { id: "lock-timeout", sql: "set local lock_timeout = '2s';" },
  { id: "statement-timeout", sql: "set local statement_timeout = '60s';" },
  { id: "raw-read-revocation", sql: "revoke select on table public.incidents, public.source_runs, public.source_snapshots, public.assets, public.recommendations, public.responder_actions, public.audit_events from public, anon, authenticated;" },
  { id: "column-read-revocation", sql: "revoke select (%s) on table public.%I from public, anon, authenticated" },
  { id: "read-probe", sql: "create or replace function public.fireafter_server_owned_read_security_version()" },
  { id: "read-probe-table-count", sql: "count(*) = 7" },
  { id: "read-probe-rls", sql: "bool_and(c.relrowsecurity)" },
  { id: "anon-read-denial", sql: "not pg_catalog.has_any_column_privilege('anon', c.oid, 'SELECT')" },
  { id: "authenticated-read-denial", sql: "not pg_catalog.has_any_column_privilege('authenticated', c.oid, 'SELECT')" },
  { id: "service-read-allow", sql: "pg_catalog.has_table_privilege('service_role', c.oid, 'SELECT')" },
  { id: "read-version", sql: "then '20260913230300'::text" },
  { id: "read-probe-revocation", sql: "revoke all on function public.fireafter_server_owned_read_security_version() from public, anon, authenticated;" },
  { id: "read-probe-grant", sql: "grant execute on function public.fireafter_server_owned_read_security_version() to service_role;" },
  { id: "effective-control-assertion", sql: "if public.fireafter_server_owned_read_security_version() is distinct from '20260913230300' then" },
];

const atomicAttestationContract = [
  { id: "lock-timeout", sql: "set local lock_timeout = '2s';" },
  { id: "statement-timeout", sql: "set local statement_timeout = '60s';" },
  { id: "routine-kind", sql: "p.prokind = 'f' and p.prosecdef and not p.proretset", occurrences: 2 },
  { id: "strict-leakproof", sql: "not p.proisstrict and not p.proleakproof", occurrences: 2 },
  { id: "volatility-parallel", sql: "p.provolatile = 'v' and p.proparallel = 'u'", occurrences: 2 },
  { id: "return-type", sql: "p.prorettype = 'pg_catalog.void'::pg_catalog.regtype", occurrences: 2 },
  { id: "defaults-support", sql: "p.pronargdefaults = 0 and p.prosupport = 0", occurrences: 2 },
  { id: "argument-modes", sql: "p.provariadic = 0 and p.proallargtypes is null and p.proargmodes is null", occurrences: 2 },
  { id: "language", sql: "p.prolang = (select oid from pg_catalog.pg_language where lanname = 'plpgsql')", occurrences: 2 },
  { id: "search-path", sql: "p.proconfig = array['search_path=public']::text[]", occurrences: 2 },
  { id: "owner", sql: "pg_catalog.pg_get_userbyid(p.proowner) = 'postgres'", occurrences: 2 },
  { id: "anon-denial", sql: "not pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')", occurrences: 2 },
  { id: "authenticated-denial", sql: "not pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')", occurrences: 2 },
  { id: "service-access", sql: "pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')", occurrences: 2 },
  { id: "body-hash", sql: "pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(", occurrences: 2 },
  { id: "new-version", sql: "then '20260913234000'::text else null::text end", occurrences: 2 },
  { id: "target-0", sql: "where p.oid = pg_catalog.to_regprocedure('public.fireafter_record_responder_action(jsonb,jsonb)')" },
  { id: "hash-0", sql: "= '8011fd1cb4a16fe7ee059ff7d80161c13fe4192aa0d7b6552b122292131a2075'" },
  { id: "argument-names-0", sql: "p.proargnames = array['p_action', 'p_audit_event']::text[]" },
  { id: "probe-0", sql: "create or replace function public.fireafter_responder_action_security_version()" },
  { id: "probe-revocation-0", sql: "revoke all on function public.fireafter_responder_action_security_version() from public, anon, authenticated;" },
  { id: "probe-grant-0", sql: "grant execute on function public.fireafter_responder_action_security_version() to service_role;" },
  { id: "assertion-0", sql: "public.fireafter_responder_action_security_version() is distinct from '20260913234000'" },
  { id: "target-1", sql: "where p.oid = pg_catalog.to_regprocedure('public.fireafter_persist_bundle(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb)')" },
  { id: "hash-1", sql: "= '8da7cbfdbdec493d6df5322aada6c599de0748964649f91dccbb3b7af3295b8b'" },
  { id: "argument-names-1", sql: "p.proargnames = array['p_organization', 'p_incident', 'p_source_snapshots', 'p_assets', 'p_recommendations', 'p_responder_actions', 'p_audit_events']::text[]" },
  { id: "probe-1", sql: "create or replace function public.fireafter_bundle_persistence_security_version()" },
  { id: "probe-revocation-1", sql: "revoke all on function public.fireafter_bundle_persistence_security_version() from public, anon, authenticated;" },
  { id: "probe-grant-1", sql: "grant execute on function public.fireafter_bundle_persistence_security_version() to service_role;" },
  { id: "assertion-1", sql: "public.fireafter_bundle_persistence_security_version() is distinct from '20260913234000'" },
];

export const ATOMIC_RPC_BODY_CONTRACTS = [
  { path: "supabase/migrations/20260906120000_atomic_responder_action_audit.sql", sha256: "8011fd1cb4a16fe7ee059ff7d80161c13fe4192aa0d7b6552b122292131a2075" },
  { path: "supabase/migrations/20260910120000_atomic_bundle_persistence.sql", sha256: "8da7cbfdbdec493d6df5322aada6c599de0748964649f91dccbb3b7af3295b8b" },
];

const atomicProbeNames = [
  "fireafter_responder_action_security_version",
  "fireafter_bundle_persistence_security_version",
];
// Seal the reviewed local candidate, including grants and final assertions. This
// is not SQL execution proof; changes require review and a new explicit seal.
const atomicAttestationSha256 = "6c3ce4fcf639c27a73e145a6c59522163b67da49a258415dbe69ab2f4a233bfb";
// Reviewed local candidate identity, not proof of executed database behavior.
const responderCommandSha256 = "87ea219774896142f40d02b0acf342dc39652bd6e255c7d8d1985f1a9c222eb0";
const responderCommandContract = [
  { id: "command-lock", sql: "perform pg_catalog.pg_advisory_xact_lock" },
  { id: "membership-lock", sql: "where organization_id = p_organization_id and user_id = p_actor_id for share;" },
  { id: "incident-lock", sql: "where id = v_incident_id for update;" },
  { id: "revision-check", sql: "lower(v_manifest->>'revision') is distinct from p_expected_revision::text" },
  { id: "receipt-write", sql: "insert into public.responder_command_receipts" },
  { id: "receipt-replay", sql: "return v_receipt.response;" },
  { id: "receipt-rls", sql: "alter table public.responder_command_receipts enable row level security;" },
  { id: "legacy-denial", sql: "revoke all on function public.fireafter_record_responder_action(jsonb,jsonb) from public, anon, authenticated, service_role;" },
  { id: "command-version", sql: "then '20260914010000'::text else null::text end" },
  { id: "approved-command-body", sql: "'586ff8b9077f590d8b3f6886bc335888fe5da1cb319fb38970797ba555602bac'" },
];

const bundleWriteFencingPath = "supabase/migrations/20260914034000_bundle_write_fencing.sql";
// Independently inspected local candidate only; historical seals remain unchanged.
const bundleWriteFencingSha256 = "e7a256796f072e168536dd28595a264be1763a5d864d1abb10774b46ca5052d3";
const bundleWrapper = "fireafter_commit_bundle";
const bundleProbe = "fireafter_bundle_persistence_security_version";
export const BUNDLE_RPC_BODY_CONTRACTS = [
  { id: "wrapper", path: bundleWriteFencingPath, name: bundleWrapper, sha256: "fe543da2cee605072d697b0747b77b413c97e6108fc0adf0917ff0da967261c2" },
  { id: "helper", ...ATOMIC_RPC_BODY_CONTRACTS[1], name: "fireafter_persist_bundle" },
];
const bundleWriteFencingContract = [
  { id: "lock-timeout", sql: "set local lock_timeout = '2s';" },
  { id: "statement-timeout", sql: "set local statement_timeout = '60s';" },
  ...[
    { id: "wrapper-security", sql: "returns void language plpgsql volatile security definer called on null input parallel unsafe set search_path = '' set lock_timeout = '2s' set statement_timeout = '15s'" },
    { id: "actor-authority", sql: "if (p_operation = 'cron_refresh' and p_actor_id is not null) or (p_operation <> 'cron_refresh' and p_actor_id is null) then" },
    { id: "membership-lock", sql: "where organization_id = v_organization_id and user_id = p_actor_id for share;" },
    { id: "membership-role", sql: "if not found or (v_role = any(array['analyst', 'incident_commander'])) is distinct from true then" },
    { id: "organization-lock", sql: "where id = v_organization_id for no key update;" },
    { id: "incident-lock", sql: "select * into v_incident from public.incidents where id = v_incident_id for update;" },
    { id: "incident-authority", sql: "if v_incident.organization_id is distinct from v_organization_id then" },
    { id: "revision-fence", sql: "if p_expected_revision is distinct from v_current_revision then" },
    { id: "revision-advance", sql: "if v_new_revision is not distinct from v_current_revision then" },
    { id: "command-only-decisions", sql: "if p_responder_actions is distinct from '[]'::jsonb then" },
    { id: "create-audits", sql: "when 'create' then array['IncidentCreated', 'SourcesRefreshed']" },
    { id: "audit-actor", sql: "or v_row->'actor_id' is distinct from v_actor" },
    { id: "child-lock", sql: "perform pg_catalog.pg_advisory_xact_lock(34001, v_stripe);" },
    { id: "child-authority", sql: "raise exception 'Bundle cannot move another incident child' using errcode = 'FB400';" },
    { id: "helper-call", sql: "perform public.fireafter_persist_bundle( pg_catalog.jsonb_build_object('id', v_organization_id, 'name', v_organization_name), p_incident, p_source_snapshots, p_assets, p_recommendations, '[]'::jsonb, v_audits);" },
    { id: "audit-postcondition", sql: "raise exception 'Bundle audit was not committed as authorized' using errcode = 'FB400';" },
  ].map((clause) => ({ ...clause, scope: bundleWrapper })),
  ...[
    { id: "two-routines", sql: "select count(*) = 2 and pg_catalog.bool_and((" },
    { id: "routine-owner", sql: "pg_catalog.pg_get_userbyid(p.proowner) = 'postgres'" },
    { id: "routine-settings", sql: "p.proargnames = e.names and p.proconfig = e.settings" },
    { id: "anon-denial", sql: "not pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')" },
    { id: "authenticated-denial", sql: "not pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')" },
    { id: "service-boundary", sql: "pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') = e.service_execute" },
    { id: "acl-boundary", sql: "or (acl.grantee <> p.proowner and (not e.service_execute or acl.grantee <> (select oid from pg_catalog.pg_roles where rolname = 'service_role')))" },
    { id: "overload-denial", sql: "select count(*) = 1 from pg_catalog.pg_proc overload" },
    { id: "body-attestation", sql: "pg_catalog.btrim(pg_catalog.replace(p.prosrc, E'\\r\\n', E'\\n'), E' \\t\\r\\n'), 'UTF8')), 'hex') = e.body_hash" },
    { id: "wrapper-body-pin", sql: `'${BUNDLE_RPC_BODY_CONTRACTS[0].sha256}', true)` },
    { id: "helper-body-pin", sql: `'${BUNDLE_RPC_BODY_CONTRACTS[1].sha256}', false)` },
    { id: "probe-anon-denial", sql: "not pg_catalog.has_function_privilege('anon', q.oid, 'EXECUTE')" },
    { id: "probe-authenticated-denial", sql: "not pg_catalog.has_function_privilege('authenticated', q.oid, 'EXECUTE')" },
    { id: "bundle-version", sql: "then '20260914034000'::text else null::text end" },
  ].map((clause) => ({ ...clause, scope: bundleProbe })),
  { id: "wrapper-owner", sql: "alter function public.fireafter_commit_bundle(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) owner to postgres;" },
  { id: "wrapper-revocation", sql: "revoke all on function public.fireafter_commit_bundle(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;" },
  { id: "wrapper-grant", sql: "grant execute on function public.fireafter_commit_bundle(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) to service_role;" },
  { id: "helper-denial", sql: "revoke all on function public.fireafter_persist_bundle(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;" },
  { id: "probe-owner", sql: "alter function public.fireafter_bundle_persistence_security_version() owner to postgres;" },
  { id: "probe-revocation", sql: "revoke all on function public.fireafter_bundle_persistence_security_version() from public, anon, authenticated, service_role;" },
  { id: "probe-grant", sql: "grant execute on function public.fireafter_bundle_persistence_security_version() to service_role;" },
  { id: "effective-control-assertion", sql: "if public.fireafter_bundle_persistence_security_version() is distinct from '20260914034000' then" },
];

const effectiveWritePath = "supabase/migrations/20260914070900_effective_write_privileges.sql";
const effectiveWriteSha256 = "ff6fa22daee54715620c1c679ec84d4b2bcbd9f1e166fee87f789be56c582940";
const effectiveWriteContract = [
  { id: "lock-timeout", sql: "set local lock_timeout = '2s';" },
  { id: "statement-timeout", sql: "set local statement_timeout = '60s';" },
  { id: "table-revocation", sql: `revoke insert, update, delete, truncate, references, trigger on table ${operationalTables.map(table => `public.${table}`).join(", ")} from public, anon, authenticated;` },
  ...["anon", "authenticated"].flatMap(role => [
    { id: `${role}-table-denial`, scope: "fireafter_server_owned_write_security_version", sql: `not pg_catalog.has_table_privilege('${role}', c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')` },
    { id: `${role}-column-denial`, scope: "fireafter_server_owned_write_security_version", sql: `not pg_catalog.has_any_column_privilege('${role}', c.oid, 'INSERT,UPDATE,REFERENCES')` },
    { id: `${role}-probe-denial`, scope: "fireafter_server_owned_write_security_version", sql: `not pg_catalog.has_function_privilege('${role}', p.oid, 'EXECUTE')` },
  ]),
  ...["SELECT", "INSERT", "UPDATE", "DELETE"].map(privilege => ({ id: `service-${privilege.toLowerCase()}`, scope: "fireafter_server_owned_write_security_version", sql: `pg_catalog.has_table_privilege('service_role', c.oid, '${privilege}')` })),
  { id: "service-access-gate", scope: "fireafter_server_owned_write_security_version", sql: "and table_controls.service_access_available" },
  { id: "table-count", sql: "count(*) = 9 as all_tables_present" },
  { id: "rls", sql: "bool_and(c.relrowsecurity) as rls_enabled" },
  { id: "policy-denial", sql: "p.roles && array['public'::name, 'anon'::name, 'authenticated'::name]" },
  { id: "role-denial", sql: "not r.rolsuper and not r.rolbypassrls and not r.rolcreaterole" },
  { id: "service-membership-denial", sql: "not pg_catalog.pg_has_role(r.oid, 'service_role', 'MEMBER')" },
  { id: "probe-owner", sql: "alter function public.fireafter_server_owned_write_security_version() owner to postgres;" },
  { id: "probe-revocation", sql: "revoke all on function public.fireafter_server_owned_write_security_version() from public, anon, authenticated, service_role;" },
  { id: "probe-grant", sql: "grant execute on function public.fireafter_server_owned_write_security_version() to service_role;" },
  { id: "effective-assertion", sql: "if public.fireafter_server_owned_write_security_version() is distinct from '20260914070900' then" },
];

const operatorAccountRecoveryContract = { id: "operatorAccountRecovery", path: "supabase/migrations/20260914140000_operator_account_recovery.sql", required: [
    { id: "intent-no-direct-access", sql: "revoke all on table public.operator_account_issuance_attempts from public, anon, authenticated, service_role;" },
    { id: "generation-no-direct-access", sql: "revoke all on table public.operator_account_membership_versions from public, anon, authenticated, service_role;" },
    { id: "generation-trigger", sql: "after insert or update or delete on public.organization_members" },
    { id: "generation-always", sql: "alter table public.organization_members enable always trigger fireafter_account_membership_generation;" },
    { id: "pending-email", sql: "on public.operator_account_issuance_attempts(email_hash) where state <> 'succeeded';" },
    { id: "generation-fence", scope: "fireafter_advance_account_issuance", sql: "if member_generation is distinct from a.membership_generation then" },
    { id: "generation-readback", scope: "fireafter_advance_account_issuance", sql: "if member_generation is distinct from a.membership_generation + 1 then" },
    { id: "at-most-once", scope: "fireafter_begin_account_issuance", sql: "return public.fireafter_get_account_issuance(p_attempt_id);" },
  ] };

const trustedOperatorIdentityContract = { id: "trustedOperatorIdentity", path: "supabase/migrations/20260915120000_trusted_operator_account_identity.sql", required: [
  { id: "lock-timeout", sql: "set local lock_timeout = '2s';" },
  { id: "statement-timeout", sql: "set local statement_timeout = '60s';" },
  { id: "operator-allowlist", sql: "create table public.operator_account_issuance_operators (" },
  { id: "operator-allowlist-owner", sql: "alter table public.operator_account_issuance_operators owner to postgres;" },
  { id: "operator-allowlist-rls", sql: "alter table public.operator_account_issuance_operators enable row level security;" },
  { id: "operator-allowlist-revocation", sql: "revoke all on table public.operator_account_issuance_operators from public, anon, authenticated, service_role;" },
  { id: "operator-allowlist-column-revocation", scope: "fireafter_operator_account_issuance_audit_security_version", sql: "not pg_catalog.has_any_column_privilege('service_role', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')" },
  { id: "attempt-operator-user", sql: "add column if not exists operator_user_id uuid references auth.users(id) on delete restrict;" },
  { id: "legacy-source", sql: "add column if not exists operator_identity_source text not null default 'legacy_operator_supplied'" },
  { id: "trusted-operator-helper", sql: "create function public.fireafter_current_trusted_issuance_operator()" },
  { id: "auth-uid", sql: "auth.uid()" },
  { id: "auth-jwt", sql: "auth.jwt()" },
  { id: "authenticated-role-guard", sql: "current_setting('request.jwt.claim.role', true) is distinct from 'authenticated'" },
  { id: "operator-allowlist-lookup", sql: "from public.operator_account_issuance_operators o" },
  { id: "begin-wrapper", sql: "create function public.fireafter_begin_account_issuance_as_operator(" },
  { id: "get-wrapper", sql: "create function public.fireafter_get_account_issuance_as_operator(p_attempt_id uuid)" },
  { id: "advance-wrapper", sql: "create function public.fireafter_advance_account_issuance_as_operator(" },
  { id: "trusted-source", sql: "operator_identity_source = 'authenticated_supabase_user'" },
  { id: "legacy-function-revocation", sql: "revoke all on function public.fireafter_get_account_issuance(uuid)," },
  { id: "wrapper-revocation", sql: "revoke all on function public.fireafter_begin_account_issuance_as_operator(uuid,text,uuid,text,text,uuid)," },
  { id: "wrapper-grant", sql: "grant execute on function public.fireafter_begin_account_issuance_as_operator(uuid,text,uuid,text,text,uuid)," },
  { id: "probe", sql: "create or replace function public.fireafter_operator_account_issuance_audit_security_version()" },
  { id: "probe-version", sql: "then '20260915120000'::text else null::text end" },
  { id: "probe-assertion", sql: "if public.fireafter_operator_account_issuance_audit_security_version() is distinct from '20260915120000' then" },
  { id: "probe-grant", sql: "grant execute on function public.fireafter_operator_account_issuance_audit_security_version() to service_role;" },
] };

const operatorAccountIssuanceRetentionContract = { id: "operatorAccountIssuanceRetention", path: "supabase/migrations/20260915130000_operator_account_issuance_retention.sql", required: [
  { id: "lock-timeout", sql: "set local lock_timeout = '2s';" },
  { id: "statement-timeout", sql: "set local statement_timeout = '60s';" },
  { id: "legacy-check-removal", sql: "position('event_type' in pg_catalog.lower(pg_catalog.pg_get_constraintdef(c.oid))) > 0" },
  { id: "retention-fk", sql: "c.confdeltype = 'n'" },
  { id: "trigger-function", sql: "create or replace function public.fireafter_validate_operator_account_issuance_event()" },
  { id: "trigger-invariant", sql: "if new.event_type = 'succeeded' and new.user_id is null then" },
  { id: "trigger-owner", sql: "alter function public.fireafter_validate_operator_account_issuance_event() owner to postgres;" },
  { id: "trigger-revocation", sql: "revoke all on function public.fireafter_validate_operator_account_issuance_event() from public, anon, authenticated, service_role;" },
  { id: "trigger", sql: "create trigger fireafter_validate_operator_account_issuance_event" },
  { id: "retention-probe", sql: "retention_controls as (" },
  { id: "check-probe", sql: "check_controls as (" },
  { id: "trigger-probe", sql: "trigger_controls as (" },
  { id: "trigger-probe-invariant", sql: "and p.prosrc like '%new.event_type = ''succeeded'' and new.user_id is null%'" },
  { id: "probe", sql: "create or replace function public.fireafter_operator_account_issuance_audit_security_version()" },
  { id: "probe-version", sql: "then '20260915130000'::text else null::text end" },
  { id: "probe-assertion", sql: "if public.fireafter_operator_account_issuance_audit_security_version() is distinct from '20260915130000' then" },
  { id: "probe-revocation", sql: "revoke all on function public.fireafter_operator_account_issuance_audit_security_version() from public, anon, authenticated, service_role;" },
  { id: "probe-grant", sql: "grant execute on function public.fireafter_operator_account_issuance_audit_security_version() to service_role;" },
] };

const scheduledRefreshContract = [
  { id: "lock-timeout", sql: "set local lock_timeout = '2s';" },
  { id: "statement-timeout", sql: "set local statement_timeout = '60s';" },
  { id: "lease-table", sql: "create table if not exists public.scheduled_refresh_leases (" },
  { id: "lease-foreign-key", sql: "references public.incidents(id) on delete cascade" },
  { id: "lease-rls", sql: "alter table public.scheduled_refresh_leases enable row level security;" },
  { id: "lease-client-revocation", sql: "revoke all on table public.scheduled_refresh_leases from public, anon, authenticated, service_role;" },
  { id: "lease-index", sql: "create index if not exists scheduled_refresh_leases_due_idx" },
  { id: "lease-seed-trigger", sql: "after insert on public.incidents" },
  { id: "claim-rpc", sql: "create function public.fireafter_claim_scheduled_refreshes(" },
  { id: "claim-security-definer", sql: "security definer" },
  { id: "claim-skip-locked", sql: "for update of s skip locked" },
  { id: "claim-worker-fence", sql: "p_worker_id !~ '^[A-Za-z0-9._:-]{1,128}$'" },
  { id: "claim-lease-fence", sql: "attempt_id = pg_catalog.gen_random_uuid()" },
  { id: "settle-rpc", sql: "create function public.fireafter_settle_scheduled_refresh(" },
  { id: "settle-worker-fence", sql: "and worker_id = p_worker_id" },
  { id: "settle-lease-fence", sql: "and lease_until > v_now;" },
  { id: "settle-mismatch", sql: "scheduled refresh lease is no longer owned" },
  { id: "claim-grant", sql: "grant execute on function public.fireafter_claim_scheduled_refreshes(integer,text,integer) to service_role;" },
  { id: "settle-grant", sql: "grant execute on function public.fireafter_settle_scheduled_refresh(uuid,uuid,text,boolean) to service_role;" },
  { id: "claim-revocation", sql: "revoke all on function public.fireafter_claim_scheduled_refreshes(integer,text,integer) from public, anon, authenticated, service_role;" },
  { id: "settle-revocation", sql: "revoke all on function public.fireafter_settle_scheduled_refresh(uuid,uuid,text,boolean) from public, anon, authenticated, service_role;" },
  { id: "security-probe", sql: "create or replace function public.fireafter_scheduled_refresh_security_version()" },
  { id: "probe-version", sql: "then '20260915100000'::text else null::text end" },
  { id: "probe-revocation", sql: "revoke all on function public.fireafter_scheduled_refresh_security_version() from public, anon, authenticated, service_role;" },
  { id: "probe-grant", sql: "grant execute on function public.fireafter_scheduled_refresh_security_version() to service_role;" },
  { id: "effective-assertion", sql: "if public.fireafter_scheduled_refresh_security_version() is distinct from '20260915100000' then" },
];

const scheduledRefreshClaimFixContract = [
  { id: "claim-named-conflict-target", scope: "fireafter_claim_scheduled_refreshes", sql: "on conflict on constraint scheduled_refresh_leases_pkey do nothing" },
  { id: "probe-checks-conflict-target", scope: "fireafter_scheduled_refresh_security_version", sql: "p.prosrc like '%on conflict on constraint scheduled_refresh_leases_pkey do nothing%'" },
  { id: "claim-rpc-replacement", sql: "create or replace function public.fireafter_claim_scheduled_refreshes(" },
  { id: "claim-service-owner", sql: "alter function public.fireafter_claim_scheduled_refreshes(integer,text,integer) owner to postgres;" },
  { id: "claim-service-revocation", sql: "revoke all on function public.fireafter_claim_scheduled_refreshes(integer,text,integer) from public, anon, authenticated, service_role;" },
  { id: "claim-service-grant", sql: "grant execute on function public.fireafter_claim_scheduled_refreshes(integer,text,integer) to service_role;" },
  { id: "expiry-sweep-qualified-predicate", scope: "fireafter_claim_scheduled_refreshes", sql: "where lease.attempt_id is not null and lease.lease_until <= v_now" },
  { id: "probe-checks-fixed-body", scope: "fireafter_scheduled_refresh_security_version", sql: "p.prosrc like '%where lease.attempt_id is not null and lease.lease_until <= v_now%'" },
  { id: "probe-version", scope: "fireafter_scheduled_refresh_security_version", sql: "then '20261002000000'::text else null::text end" },
  { id: "probe-revocation", sql: "revoke all on function public.fireafter_scheduled_refresh_security_version() from public, anon, authenticated, service_role;" },
  { id: "probe-grant", sql: "grant execute on function public.fireafter_scheduled_refresh_security_version() to service_role;" },
  { id: "effective-assertion", sql: "if public.fireafter_scheduled_refresh_security_version() is distinct from '20261002000000' then" },
];

export const MIGRATION_CONTRACTS = [
  { id: "serverOwnedWrites", path: "supabase/migrations/20260904053500_server_owned_operational_writes.sql", required: serverOwnedWriteContract },
  { id: "atomicResponderAction", path: ATOMIC_RPC_BODY_CONTRACTS[0].path, required: atomicResponderContract },
  { id: "atomicBundlePersistence", path: ATOMIC_RPC_BODY_CONTRACTS[1].path, required: atomicBundleContract },
  { id: "operatorAccountIssuanceAudit", path: "supabase/migrations/20260910173914_operator_account_issuance_audit.sql", required: operatorAccountIssuanceContract },
  { id: "serverOwnedReads", path: "supabase/migrations/20260913230300_server_owned_operational_reads.sql", required: operationalReadContract },
  { id: "atomicRpcAttestation", path: "supabase/migrations/20260913234000_atomic_rpc_attestation.sql", required: atomicAttestationContract },
  { id: "responderCommand", path: "supabase/migrations/20260914010000_responder_command_contract.sql", required: responderCommandContract },
  { id: "bundleWriteFencing", path: bundleWriteFencingPath, required: bundleWriteFencingContract },
  { id: "effectiveWritePrivileges", path: effectiveWritePath, required: effectiveWriteContract },
  { id: "importOperationReceipts", path: "supabase/migrations/20260914090000_import_operation_receipts.sql", required: [
    { id: "receipt-table", sql: "primary key (actor_id, operation_id)" },
    { id: "receipt-no-raw-access", sql: "revoke all on table public.import_operation_receipts from public, anon, authenticated, service_role;" },
    { id: "receipt-replay-lock", scope: "fireafter_commit_import", sql: "perform pg_catalog.pg_advisory_xact_lock(90000, pg_catalog.hashtext(p_actor_id::text || ':' || p_operation_id::text));" },
    { id: "receipt-hash-binding", scope: "fireafter_commit_import", sql: "if v_receipt->>'requestHash' is distinct from p_request_hash then" },
    { id: "receipt-current-authority", scope: "fireafter_read_import_receipt", sql: "where organization_id = p_organization_id and user_id = p_actor_id for share;" },
    { id: "receipt-current-incident", scope: "fireafter_read_import_receipt", sql: "if not found or v_organization_id is distinct from p_organization_id then" },
    { id: "receipt-current-version", scope: "fireafter_bundle_persistence_security_version", sql: "then '20260914090000'::text else null::text end" },
    { id: "receipt-function-count", scope: "fireafter_bundle_persistence_security_version", sql: "select count(*) = 4" },
    { id: "receipt-commit-body-pin", scope: "fireafter_bundle_persistence_security_version", sql: "'b3a229f3a69a9f369ad43f19f60f7e8f6b9b8539e7bd74150f8848c607491a7c', true)" },
    { id: "receipt-read-body-pin", scope: "fireafter_bundle_persistence_security_version", sql: "'f84029027a7fd394eacf3988e11d6851d1254107087630bb82553316fd0e76b1', true)" },
    { id: "receipt-fail-closed", sql: "if public.fireafter_bundle_persistence_security_version() is distinct from '20260914090000' then" },
  ] },
  operatorAccountRecoveryContract,
  ISSUANCE_ATTESTATION_CONTRACT,
  trustedOperatorIdentityContract,
  operatorAccountIssuanceRetentionContract,
  { id: "scheduledRefresh", path: "supabase/migrations/20260915100000_scheduled_refresh_leases.sql", required: scheduledRefreshContract },
  { id: "scheduledRefreshClaimFix", path: "supabase/migrations/20261002000000_scheduled_refresh_claim_ambiguity_fix.sql", required: scheduledRefreshClaimFixContract },
  { id: "appendOnlyTriggerHelper", path: "supabase/migrations/20260918130000_append_only_trigger_helper_hardening.sql", required: [
    { id: "fixed-trigger-path", sql: "alter function public.fireafter_prevent_append_only_mutation() set search_path = '';" },
    { id: "probe", sql: "create or replace function public.fireafter_append_only_trigger_security_version()" },
    { id: "body-pin", scope: "fireafter_append_only_trigger_security_version", sql: "'d68b9d2d780419bbf87c6ff655e363e873d0f72c3c3cf5963bc4f36735828143'" },
    { id: "probe-version", scope: "fireafter_append_only_trigger_security_version", sql: "then '20260918130000'::text else null::text end" },
    { id: "probe-owner", sql: "alter function public.fireafter_append_only_trigger_security_version() owner to postgres;" },
    { id: "probe-revocation", sql: "revoke all on function public.fireafter_append_only_trigger_security_version() from public, anon, authenticated, service_role;" },
    { id: "probe-grant", sql: "grant execute on function public.fireafter_append_only_trigger_security_version() to service_role;" },
    { id: "probe-assertion", sql: "if public.fireafter_append_only_trigger_security_version() is distinct from '20260918130000' then" },
  ] },
  { id: "durableIngestion", path: "supabase/migrations/20261007120000_durable_ingestion.sql", required: [
    { id: "jobs-rls", sql: "alter table public.ingestion_jobs enable row level security;" },
    { id: "checkpoints-rls", sql: "alter table public.ingestion_checkpoints enable row level security;" },
    { id: "receipts-rls", sql: "alter table public.ingestion_commit_receipts enable row level security;" },
    { id: "table-denial", sql: "revoke all on public.ingestion_jobs, public.ingestion_checkpoints, public.ingestion_commit_receipts from public, anon, authenticated, service_role;" },
    { id: "lease-fence", sql: "where id=p_id and lease_id=p_lease and lease_until>clock_timestamp() and status='running'" },
    { id: "active-county-dedup", sql: "create unique index ingestion_one_active_county on public.ingestion_jobs(organization_id, incident_key)" },
    { id: "fenced-bundle", sql: "perform public.fireafter_commit_bundle(j.actor_id" },
    { id: "atomic-receipt", sql: "insert into public.ingestion_commit_receipts(job_id,phase,incident_id,revision)" },
    { id: "receipt-retention", sql: "alter table public.ingestion_commit_receipts enable always trigger ingestion_receipts_append_only;" },
    { id: "manifest-integrity", sql: "pg_catalog.encode(pg_catalog.sha256(b),'hex')<>m->>'hash'" },
    { id: "reload-api", sql: "notify pgrst, 'reload schema';" },
  ] },
  { id: "bulkBundleCapacity", path: "supabase/migrations/20261002010000_bulk_bundle_capacity.sql", required: [
    { id: "bundle-timeout", sql: "alter function public.fireafter_commit_bundle(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) set statement_timeout = '30s';" },
    { id: "import-timeout", sql: "alter function public.fireafter_commit_import(uuid,text,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) set statement_timeout = '30s';" },
    { id: "bounded-settings", sql: "array['search_path=\"\"','lock_timeout=2s','statement_timeout=30s']::text[]", occurrences: 2 },
    { id: "preserved-read-settings", sql: "array['search_path=\"\"','lock_timeout=2s','statement_timeout=15s']::text[]" },
    { id: "probe-version", scope: "fireafter_bundle_persistence_security_version", sql: "then '20261002010000'::text else null::text end" },
    { id: "effective-configuration", scope: "fireafter_bundle_persistence_security_version", sql: "p.proargnames = e.names and p.proconfig = e.settings" },
    { id: "anonymous-denial", scope: "fireafter_bundle_persistence_security_version", sql: "not pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')" },
    { id: "authenticated-denial", scope: "fireafter_bundle_persistence_security_version", sql: "not pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')" },
    { id: "receipt-table-denial", scope: "fireafter_bundle_persistence_security_version", sql: "pg_catalog.has_table_privilege(roles.name, c.oid, privileges.name)" },
    { id: "reload-api", sql: "notify pgrst, 'reload schema';" },
  ] },
];

function canonicalSqlIdentity(sql) {
  return sql.replace(/\r\n/g, "\n").replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
}

function bundleRoutineDefinition(content, name) {
  // Deliberately limited to the inspected candidate syntax, not a SQL parser.
  // The full-file seal rejects comment tricks and appended statements as well.
  if (typeof content !== "string") return null;
  const pattern = new RegExp(`create (?:or replace )?function public\\.${name}\\([\\s\\S]*?\\bas \\$\\$([\\s\\S]*?)\\$\\$;`, "gi");
  const matches = [...content.matchAll(pattern)];
  return matches.length === 1 ? { sql: matches[0][0], body: matches[0][1] } : null;
}

function atomicProbeDefinitions(content) {
  return atomicProbeNames.map((name) => {
    // Only the sealed migration's explicit dollar-quoted definition form is
    // supported. Missing/duplicate definitions cannot borrow another probe's SQL.
    const pattern = new RegExp(`create or replace function public\\.${name}\\(\\)[\\s\\S]*?\\$\\$;`, "gi");
    const matches = [...content.matchAll(pattern)];
    return matches.length === 1 ? normalizeSql(matches[0][0]) : "";
  });
}

export function normalizeSql(sql) {
  return sql
    .toLowerCase()
    .replace(/--[^\r\n]*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildMigrationContractReport(fileContents) {
  const migrations = MIGRATION_CONTRACTS.map((contract) => {
    const content = fileContents?.[contract.path];
    const isAttestation = contract.id === "atomicRpcAttestation";
    const definitions = isAttestation && typeof content === "string" ? atomicProbeDefinitions(content) : [];
    const missing = typeof content === "string"
      ? contract.required
        .filter(({ id, sql, occurrences = 1, scope }) => {
          const needle = normalizeSql(sql);
          if (["bundleWriteFencing", "effectiveWritePrivileges", "importOperationReceipts", "operatorAccountRecovery", "issuanceControlAttestation", "trustedOperatorIdentity", "scheduledRefreshClaimFix", "bulkBundleCapacity"].includes(contract.id) && scope) {
            return !normalizeSql(bundleRoutineDefinition(content, scope)?.sql ?? "").includes(needle);
          }
          if (isAttestation && occurrences === 2) {
            return definitions.some((definition) => !definition.includes(needle));
          }
          const target = isAttestation ? id.match(/^(?:target|hash|argument-names|probe)-([01])$/) : null;
          if (target) return !definitions[Number(target[1])].includes(needle);
          return normalizeSql(content).split(needle).length - 1 < occurrences;
        })
        .map(({ id }) => id)
      : contract.required.map(({ id }) => id);
    if (isAttestation) {
      if (typeof content !== "string" || createHash("sha256").update(canonicalSqlIdentity(content)).digest("hex") !== atomicAttestationSha256) {
        missing.push("attestation-artifact");
      }
      for (const [index, expected] of ATOMIC_RPC_BODY_CONTRACTS.entries()) {
        const body = fileContents?.[expected.path]?.match(/as \$\$([\s\S]*?)\$\$;/)?.[1];
        const canonical = typeof body === "string" ? canonicalSqlIdentity(body) : null;
        if (canonical === null || createHash("sha256").update(canonical).digest("hex") !== expected.sha256) {
          missing.push(`approved-body-${index}`);
        }
      }
    }
    if (contract.id === "responderCommand" &&
      (typeof content !== "string" || createHash("sha256").update(canonicalSqlIdentity(content)).digest("hex") !== responderCommandSha256)) {
      missing.push("command-artifact");
    }
    if (contract.id === "bulkBundleCapacity" &&
      (typeof content !== "string" || createHash("sha256").update(canonicalSqlIdentity(content)).digest("hex") !== "0b4982292adcad710c79677403957dde3a42f3b6c397375f7f2dd4b47019db89")) {
      missing.push("reviewed-capacity-artifact");
    }
    if (contract.id === "effectiveWritePrivileges" &&
      (typeof content !== "string" || createHash("sha256").update(canonicalSqlIdentity(content)).digest("hex") !== effectiveWriteSha256)) {
      missing.push("effective-write-artifact");
    }
    if (contract.id === "bundleWriteFencing") {
      if (typeof content !== "string" || createHash("sha256").update(canonicalSqlIdentity(content)).digest("hex") !== bundleWriteFencingSha256) {
        missing.push("bundle-fencing-artifact");
      }
      for (const expected of BUNDLE_RPC_BODY_CONTRACTS) {
        const body = bundleRoutineDefinition(fileContents?.[expected.path], expected.name)?.body;
        if (typeof body !== "string" || createHash("sha256").update(canonicalSqlIdentity(body)).digest("hex") !== expected.sha256) {
          missing.push(`approved-bundle-${expected.id}-body`);
        }
      }
    }
    if (contract.id === "importOperationReceipts" &&
      (typeof content !== "string" || createHash("sha256").update(canonicalSqlIdentity(content)).digest("hex") !== "148c47e4594334c1245d260d9b572d65f71b8b46d71a1adf8a6610999c876c95")) {
      missing.push("import-receipt-artifact");
    }
    if (contract.id === "issuanceControlAttestation") {
      if (typeof content !== "string" || createHash("sha256").update(canonicalSqlIdentity(content)).digest("hex") !== ISSUANCE_ATTESTATION_SHA256) {
        missing.push("issuance-reviewed-candidate");
      }
      for (const expected of ISSUANCE_COORDINATOR_BODIES) {
        const body = bundleRoutineDefinition(fileContents?.[expected.path], expected.name)?.body;
        if (typeof body !== "string" || createHash("sha256").update(canonicalSqlIdentity(body)).digest("hex") !== expected.sha256 ||
          typeof content !== "string" || !content.includes(expected.sha256)) {
          missing.push(`issuance-approved-body-${expected.name}`);
        }
      }
    }
    if (contract.id === "operatorAccountRecovery" &&
      (typeof content !== "string" || createHash("sha256").update(canonicalSqlIdentity(content)).digest("hex") !== "5c01d9346d6d69cb0e936a84ac0d1fd0ec933d7a8b13db0b5823d0cc6ea4038c")) {
      missing.push("account-recovery-artifact");
    }
    if (typeof content === "string" && !hasValidPostgresSyntax(content)) missing.push("postgresql-syntax");
    const failure = typeof content !== "string"
      ? "migration_missing"
      : missing.length > 0
        ? "migration_contract_mismatch"
        : null;

    return {
      id: contract.id,
      path: contract.path,
      ok: failure === null,
      failure,
      missing,
    };
  });
  const ok = migrations.length > 0 && migrations.every((migration) => migration.ok);

  return {
    ok,
    failure: ok ? null : "migration_contract_unverified",
    migrations,
    nextActions: ok
      ? []
      : [...new Set(migrations
        .filter((migration) => !migration.ok)
        .map((migration) => `Restore or reconcile ${migration.path}, then rerun npm.cmd run verify:migration-contract.`))],
  };
}

export function loadMigrationContractFiles(root = process.cwd()) {
  return Object.fromEntries(MIGRATION_CONTRACTS.map((contract) => {
    try {
      return [contract.path, readFileSync(resolve(root, contract.path), "utf8")];
    } catch {
      return [contract.path, null];
    }
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = buildMigrationContractReport(loadMigrationContractFiles());
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}
