import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ATOMIC_BUNDLE_PERSISTENCE_SECURITY_PROBE_RPC,
  ATOMIC_BUNDLE_PERSISTENCE_SECURITY_RPC,
  ATOMIC_BUNDLE_PERSISTENCE_SECURITY_VERSION,
  ATOMIC_RESPONDER_ACTION_SECURITY_PROBE_RPC,
  ATOMIC_RESPONDER_ACTION_SECURITY_RPC,
  ATOMIC_RESPONDER_ACTION_SECURITY_VERSION,
  OPERATOR_ACCOUNT_ISSUANCE_AUDIT_SECURITY_PROBE_RPC,
  OPERATOR_ACCOUNT_ISSUANCE_AUDIT_SECURITY_VERSION,
  SCHEDULED_REFRESH_SECURITY_PROBE_RPC,
  SCHEDULED_REFRESH_SECURITY_VERSION,
  SERVER_OWNED_WRITE_SECURITY_RPC,
  SERVER_OWNED_WRITE_SECURITY_VERSION,
} from "./operational-write-security";

const migrationPath = resolve(
  process.cwd(),
  "supabase/migrations/20260904053500_server_owned_operational_writes.sql",
);
const migration = readFileSync(migrationPath, "utf8")
  .toLowerCase()
  .replace(/\s+/g, " ");
const verifier = readFileSync(
  resolve(process.cwd(), "scripts/migration-contract-verifier.mjs"),
  "utf8",
);
const atomicMigration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260906120000_atomic_responder_action_audit.sql",
  ),
  "utf8",
)
  .toLowerCase()
  .replace(/\s+/g, " ");
const bundleMigration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260910120000_atomic_bundle_persistence.sql",
  ),
  "utf8",
)
  .toLowerCase()
  .replace(/\s+/g, " ");
const operatorAuditMigration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260910173914_operator_account_issuance_audit.sql",
  ),
  "utf8",
)
  .toLowerCase()
  .replace(/\s+/g, " ");
const scheduledRefreshMigration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260915100000_scheduled_refresh_leases.sql"),
  "utf8",
)
  .toLowerCase()
  .replace(/\s+/g, " ");
const scheduledRefreshClaimFixMigration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20261002000000_scheduled_refresh_claim_ambiguity_fix.sql"),
  "utf8",
)
  .toLowerCase()
  .replace(/\s+/g, " ");
const operatorRetentionMigration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260915130000_operator_account_issuance_retention.sql"),
  "utf8",
)
  .toLowerCase()
  .replace(/\s+/g, " ");

describe("server-owned operational write migration", () => {
  it("fails fast instead of waiting indefinitely for policy-table locks", () => {
    expect(migration).toContain("set local lock_timeout = '2s'");
    expect(migration).toContain("set local statement_timeout = '60s'");
  });

  it("revokes browser-role writes from every operational table", () => {
    const tables = [
      "public.organizations",
      "public.organization_members",
      "public.incidents",
      "public.source_runs",
      "public.source_snapshots",
      "public.assets",
      "public.recommendations",
      "public.responder_actions",
      "public.audit_events",
    ];

    expect(migration).toContain("revoke insert, update, delete");
    expect(migration).toContain("from public, anon, authenticated");
    for (const table of tables) {
      expect(migration).toContain(
        `alter table ${table} enable row level security`,
      );
      expect(migration).toContain(table);
    }
  });

  it("removes direct incident and responder-action mutation policies", () => {
    expect(migration).toContain(
      'drop policy if exists "members can manage incidents" on public.incidents',
    );
    expect(migration).toContain(
      'drop policy if exists "members can create actions" on public.responder_actions',
    );
  });

  it("exposes service-role-only probes for both live write controls", () => {
    expect(migration).toContain(
      `function public.${SERVER_OWNED_WRITE_SECURITY_RPC}()`,
    );
    expect(migration).toContain("count(*) = 9 as all_tables_present");
    expect(migration).toContain("bool_and(c.relrowsecurity) as rls_enabled");
    expect(migration).toContain("pg_catalog.has_table_privilege(");
    expect(migration).toContain("from pg_catalog.pg_policies");
    expect(migration).toContain(
      "roles && array['public'::name, 'anon'::name, 'authenticated'::name]",
    );
    expect(migration).toContain("then '20260904053500'::text");
    expect(migration).toContain(
      `grant execute on function public.${SERVER_OWNED_WRITE_SECURITY_RPC}() to service_role`,
    );
    expect(verifier).toContain(`rpc: "${SERVER_OWNED_WRITE_SECURITY_RPC}"`);
    expect(verifier).toContain(`expectedVersion: "${SERVER_OWNED_WRITE_SECURITY_VERSION}"`);
    expect(verifier).toContain(
      `rpc: "${ATOMIC_RESPONDER_ACTION_SECURITY_PROBE_RPC}"`,
    );
    expect(verifier).toContain(
      `expectedVersion: "${ATOMIC_RESPONDER_ACTION_SECURITY_VERSION}"`,
    );
    expect(verifier).toContain(
      `rpc: "${ATOMIC_BUNDLE_PERSISTENCE_SECURITY_PROBE_RPC}"`,
    );
    expect(verifier).toContain(
      `expectedVersion: "${ATOMIC_BUNDLE_PERSISTENCE_SECURITY_VERSION}"`,
    );
  });

  it("does not expose the security probe to browser roles", () => {
    expect(migration).toContain(
      `revoke all on function public.${SERVER_OWNED_WRITE_SECURITY_RPC}() from public, anon, authenticated`,
    );
  });

  it("requires a service-role-only atomic responder action RPC", () => {
    expect(atomicMigration).toContain(
      "create or replace function public.fireafter_record_responder_action( p_action jsonb, p_audit_event jsonb )",
    );
    expect(atomicMigration).toContain("language plpgsql");
    expect(atomicMigration).toContain("security definer");
    expect(atomicMigration).toContain("insert into public.responder_actions");
    expect(atomicMigration).toContain("insert into public.audit_events");
    expect(atomicMigration).toContain("on conflict (id) do nothing");
    expect(atomicMigration).toContain(
      `function public.${ATOMIC_RESPONDER_ACTION_SECURITY_PROBE_RPC}()`,
    );
    expect(atomicMigration).toContain(
      "then '20260906120000'::text",
    );
    expect(atomicMigration).toContain(
      "grant execute on function public.fireafter_record_responder_action(jsonb, jsonb) to service_role",
    );
    expect(atomicMigration).toContain(
      `grant execute on function public.${ATOMIC_RESPONDER_ACTION_SECURITY_PROBE_RPC}() to service_role`,
    );
  });

  it("does not expose either atomic RPC to browser roles", () => {
    expect(atomicMigration).toContain(
      "revoke all on function public.fireafter_record_responder_action(jsonb, jsonb) from public, anon, authenticated",
    );
    expect(atomicMigration).toContain(
      `revoke all on function public.${ATOMIC_RESPONDER_ACTION_SECURITY_PROBE_RPC}() from public, anon, authenticated`,
    );
  });

  it("requires the forward command RPC rather than invoking the historical writer", () => {
    expect(ATOMIC_RESPONDER_ACTION_SECURITY_RPC).toBe("fireafter_record_responder_command");
    expect(ATOMIC_RESPONDER_ACTION_SECURITY_VERSION).toBe("20260914010000");
  });

  it("retains the historical atomic bundle helper contract", () => {
    expect(bundleMigration).toContain(
      "create or replace function public.fireafter_persist_bundle(",
    );
    expect(bundleMigration).toContain("language plpgsql");
    expect(bundleMigration).toContain("security definer");
    expect(bundleMigration).toContain("delete from public.source_snapshots");
    expect(bundleMigration).toContain("insert into public.incidents");
    expect(bundleMigration).toContain("insert into public.recommendations");
    expect(bundleMigration).toContain("on conflict (id) do nothing");
    expect(bundleMigration).toContain(
      `function public.${ATOMIC_BUNDLE_PERSISTENCE_SECURITY_PROBE_RPC}()`,
    );
    expect(bundleMigration).toContain(
      "then '20260910120000'::text",
    );
    expect(bundleMigration).toContain(
      "grant execute on function public.fireafter_persist_bundle(jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb) to service_role",
    );
    expect(bundleMigration).toContain(
      `grant execute on function public.${ATOMIC_BUNDLE_PERSISTENCE_SECURITY_PROBE_RPC}() to service_role`,
    );
    expect(bundleMigration).toContain(
      "revoke all on function public.fireafter_persist_bundle(jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb) from public, anon, authenticated",
    );
    expect(bundleMigration).toContain(
      `revoke all on function public.${ATOMIC_BUNDLE_PERSISTENCE_SECURITY_PROBE_RPC}() from public, anon, authenticated`,
    );
  });

  it("requires the final fenced bundle RPC and revokes the historical service-role bypass", () => {
    const sql = readFileSync("supabase/migrations/20260914034000_bundle_write_fencing.sql", "utf8").toLowerCase().replace(/\s+/g, " ");
    expect(ATOMIC_BUNDLE_PERSISTENCE_SECURITY_RPC).toBe("fireafter_commit_bundle");
    expect(sql).toContain(`create function public.${ATOMIC_BUNDLE_PERSISTENCE_SECURITY_RPC}(`);
    expect(sql).toContain("p_expected_revision is distinct from v_current_revision");
    expect(sql).toContain("where organization_id = v_organization_id and user_id = p_actor_id for share");
    expect(sql).toContain("revoke all on function public.fireafter_persist_bundle(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) from public, anon, authenticated, service_role");
    expect(sql).toContain("then '20260914034000'::text");
    const receiptSql = readFileSync("supabase/migrations/20260914090000_import_operation_receipts.sql", "utf8");
    expect(receiptSql).toContain("then '20260914090000'::text");
    const capacitySql = readFileSync("supabase/migrations/20261002010000_bulk_bundle_capacity.sql", "utf8");
    expect(capacitySql).toContain(`then '${ATOMIC_BUNDLE_PERSISTENCE_SECURITY_VERSION}'::text`);
    expect(capacitySql).toContain("set statement_timeout = '30s'");
    const rehearsal = readFileSync("supabase/tests/bundle_write_fencing.sql", "utf8");
    expect(rehearsal).toContain("r.command_id=v_command_id");
    expect(rehearsal).not.toMatch(/\bcommand_id\s*=\s*command_id\b/);
    const responderRehearsal = readFileSync("supabase/tests/responder_command_contract.sql", "utf8");
    expect(responderRehearsal).toContain("fireafter_bundle_persistence_security_version() is distinct from '20260914034000'");
  });

  it("probes the operator issuance ledger without granting browser access", () => {
    expect(operatorAuditMigration).toContain(
      "create table if not exists public.operator_account_issuance_events",
    );
    expect(operatorAuditMigration).toContain(
      "alter table public.operator_account_issuance_events enable row level security",
    );
    expect(operatorAuditMigration).toContain(
      "revoke all on table public.operator_account_issuance_events from public, anon, authenticated",
    );
    expect(operatorAuditMigration).toContain(
      "grant insert on table public.operator_account_issuance_events to service_role",
    );
    expect(operatorAuditMigration).toContain(
      `function public.${OPERATOR_ACCOUNT_ISSUANCE_AUDIT_SECURITY_PROBE_RPC}()`,
    );
    expect(operatorAuditMigration).toContain("then '20260910173914'::text");
    const forward = readFileSync(resolve(process.cwd(), "supabase/migrations/20260915130000_operator_account_issuance_retention.sql"), "utf8");
    expect(forward).toContain(`then '${OPERATOR_ACCOUNT_ISSUANCE_AUDIT_SECURITY_VERSION}'::text`);
    expect(forward).toContain("wrapper_controls.valid and legacy_controls.valid");
    expect(operatorAuditMigration).toContain(
      `revoke all on function public.${OPERATOR_ACCOUNT_ISSUANCE_AUDIT_SECURITY_PROBE_RPC}() from public, anon, authenticated`,
    );
    expect(operatorAuditMigration).toContain(
      `grant execute on function public.${OPERATOR_ACCOUNT_ISSUANCE_AUDIT_SECURITY_PROBE_RPC}() to service_role`,
    );
  });

  it("requires Auth deletion retention without weakening succeeded-event insertion", () => {
    expect(operatorRetentionMigration).toContain("c.confdeltype = 'n'");
    expect(operatorRetentionMigration).toContain("create or replace function public.fireafter_validate_operator_account_issuance_event()");
    expect(operatorRetentionMigration).toContain("if new.event_type = 'succeeded' and new.user_id is null then");
    expect(operatorRetentionMigration).toContain("using errcode = '23514'");
    expect(operatorRetentionMigration).toContain("create trigger fireafter_validate_operator_account_issuance_event");
    expect(operatorRetentionMigration).toContain("retention_controls as (");
    expect(operatorRetentionMigration).toContain("check_controls as (");
    expect(operatorRetentionMigration).toContain("trigger_controls as (");
    expect(operatorRetentionMigration).toContain("p.prosrc like '%new.event_type = ''succeeded'' and new.user_id is null%'");
    expect(operatorRetentionMigration).toContain(`then '${OPERATOR_ACCOUNT_ISSUANCE_AUDIT_SECURITY_VERSION}'::text`);
    expect(readFileSync(resolve(process.cwd(), "supabase/tests/operator_account_issuance_retention.sql"), "utf8"))
      .toContain("delete from auth.users");
  });

  it("requires durable scheduled-refresh leases with worker and expiry fencing", () => {
    expect(scheduledRefreshMigration).toContain(
      "create table if not exists public.scheduled_refresh_leases",
    );
    expect(scheduledRefreshMigration).toContain("attempt_id uuid unique");
    expect(scheduledRefreshMigration).toContain(
      "alter table public.scheduled_refresh_leases enable row level security",
    );
    expect(scheduledRefreshMigration).toContain(
      "revoke all on table public.scheduled_refresh_leases from public, anon, authenticated, service_role",
    );
    expect(scheduledRefreshMigration).toContain("for update of s skip locked");
    expect(scheduledRefreshMigration).toContain(
      "p_worker_id !~ '^[a-za-z0-9._:-]{1,128}$'",
    );
    expect(scheduledRefreshMigration).toContain(
      "and worker_id = p_worker_id and lease_until > v_now",
    );
    expect(scheduledRefreshMigration).toContain(
      "function public." + SCHEDULED_REFRESH_SECURITY_PROBE_RPC + "()",
    );
    expect(scheduledRefreshClaimFixMigration).toContain(
      "update public.scheduled_refresh_leases as lease",
    );
    expect(scheduledRefreshClaimFixMigration).toContain(
      "where lease.attempt_id is not null and lease.lease_until <= v_now",
    );
    expect(scheduledRefreshClaimFixMigration).toContain(
      "p.prosrc like '%where lease.attempt_id is not null and lease.lease_until <= v_now%'",
    );
    expect(scheduledRefreshClaimFixMigration).toContain(
      "then '" + SCHEDULED_REFRESH_SECURITY_VERSION + "'::text",
    );
    expect(scheduledRefreshClaimFixMigration).toContain(
      "revoke all on function public." + SCHEDULED_REFRESH_SECURITY_PROBE_RPC + "() from public, anon, authenticated, service_role",
    );
  });
});
