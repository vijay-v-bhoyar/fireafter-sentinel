// Fixed reviewed source identities, never learned from the target database.
export const ISSUANCE_ATTESTATION_VERSION = "20260914150000";
export const ISSUANCE_ATTESTATION_PATH = "supabase/migrations/20260914150000_issuance_control_attestation.sql";
export const ISSUANCE_ATTESTATION_SHA256 = "d3aee53084793fefef56df622d3b71bc30fff8482517e8806f2c9e8e482114ed";
export const ISSUANCE_COORDINATOR_BODIES = [
  ["fireafter_track_account_membership", "54ee713a1d4642b1658a1facd51faf1dfc58385b9696662644beaa982db8beba"],
  ["fireafter_get_account_issuance", "97afc10e723eab7730971c3c2bc4e5790786e48472dbdc8546ee64c69b516efa"],
  ["fireafter_begin_account_issuance", "e2ac1aff96381ad36ba0a2cda98cd8b68aae6d7e67f33edc194c8fb3a5966d3a"],
  ["fireafter_advance_account_issuance", "7216e12364cb7b1463f406b013240fd375f9c18764561d6b0eb60e8d03d6a76c"],
].map(([name, sha256]) => ({ name, sha256, path: "supabase/migrations/20260914140000_operator_account_recovery.sql" }));

const scope = "fireafter_operator_account_issuance_audit_security_version";
export const ISSUANCE_ATTESTATION_CONTRACT = {
  id: "issuanceControlAttestation", path: ISSUANCE_ATTESTATION_PATH,
  required: [
    { id: "lock-timeout", sql: "set local lock_timeout = '2s';" },
    { id: "statement-timeout", sql: "set local statement_timeout = '60s';" },
    { id: "ledger-insert-only", sql: "grant insert on table public.operator_account_issuance_events to service_role;" },
    { id: "coordinator-private", sql: "revoke all on table public.operator_account_issuance_events, public.operator_account_issuance_attempts, public.operator_account_membership_versions from public, anon, authenticated, service_role;" },
    ...[
      ["tables", "count(*) = 3 and bool_and(coalesce("],
      ["columns", "count(*) = 13 and bool_and(coalesce("],
      ["column-grants", "not pg_catalog.has_any_column_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')"],
      ["service-mutation-denial", "not pg_catalog.has_table_privilege('service_role', c.oid, 'SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')"],
      ["checks", "c.convalidated and not c.connoinherit and pg_catalog.pg_get_constraintdef(c.oid, false) = r.definition"],
      ["indexes", "i.indisunique and i.indisvalid and i.indisready and i.indimmediate"],
      ["index-predicate", "pg_catalog.pg_get_expr(i.indpred, i.indrelid, false) is not distinct from r.predicate"],
      ["routine-count", "count(*) = 4 and bool_and(coalesce("],
      ["routine-config", "p.proconfig = r.config and p.proowner = 'postgres'::regrole"],
      ["routine-hash", "'UTF8')), 'hex') = r.body_hash"],
      ["trigger-mode", "bool_and(coalesce(t.tgenabled = 'A'"],
      ["rewrite-rules", "not exists(select 1 from pg_catalog.pg_rewrite rw where rw.ev_class = c.oid)"],
      ["membership-rules", "not exists(select 1 from pg_catalog.pg_rewrite rw where rw.ev_class = pg_catalog.to_regclass('public.organization_members'))"],
      ["trigger-events", "t.tgname = 'fireafter_account_membership_generation' and t.tgtype = 29"],
      ["truncate-trigger", "t.tgname = 'fireafter_account_membership_no_truncate' and t.tgtype = 34"],
      ["role-escalation", "not pg_catalog.pg_has_role(r.oid, 'postgres', 'MEMBER')"],
      ["all-controls", "table_controls.valid and column_controls.valid and check_controls.valid and index_controls.valid and routine_controls.valid and trigger_controls.valid and role_controls.valid and probe_controls.valid"],
      ["version", "then '20260914150000'::text else null::text end"],
    ].map(([id, sql]) => ({ id, sql, scope })),
    { id: "effective-assertion", sql: "if public.fireafter_operator_account_issuance_audit_security_version() is distinct from '20260914150000' then" },
  ],
};
