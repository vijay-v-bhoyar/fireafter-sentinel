import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ATOMIC_RPC_BODY_CONTRACTS,
  BUNDLE_RPC_BODY_CONTRACTS,
  MIGRATION_CONTRACTS,
  SECURITY_PROBES,
  buildMigrationContractReport,
  loadMigrationContractFiles,
  normalizeSql,
  hasValidPostgresSyntax,
} from "./migration-contract-verifier.mjs";

const currentFiles = loadMigrationContractFiles();

test("bulk capacity keeps exact bounded settings and reviewed authorization controls", () => {
  const path = "supabase/migrations/20261002010000_bulk_bundle_capacity.sql";
  const sql = currentFiles[path];
  for (const [before, after] of [["set statement_timeout = '30s'", "set statement_timeout = '0'"],
    ["not pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')", "true"],
    ["and p.proargnames = e.names and p.proconfig = e.settings", "and true"],
    ["then '20261002010000'", "then '20260914090000'"]]) {
    assert.ok(sql.includes(before));
    const report = buildMigrationContractReport({ ...currentFiles, [path]: sql.replace(before, after) });
    assert.equal(report.ok, false);
  }
});

const issuanceRehearsal = readFileSync("supabase/tests/issuance_control_attestation.sql", "utf8");

test("FA20 rehearsal: capability preflight proves and restores role drift or fails actionably", () => {
  const block = issuanceRehearsal.match(/do \$fa20_capability\$([\s\S]+?)\$fa20_capability\$;/)?.[1];
  assert.ok(block, "Named rollback-only capability block required");
  assert.match(block, /alter role authenticated bypassrls/i);
  assert.match(block, /when insufficient_privilege then\s+raise exception/);
  assert.match(block, /errcode = '42501'/);
  assert.match(block, /when sqlstate 'ZX001' then null/);
  assert.match(block, /is distinct from '20260914150000'/);
  assert.ok(issuanceRehearsal.indexOf("$fa20_capability$") < issuanceRehearsal.indexOf("foreach role_name"));
});

test("FA20 rehearsal: table grant matrix includes INSERT with only the permitted ledger exception", () => {
  const matrix = issuanceRehearsal.match(/foreach privilege_name in array array\[([^\]]+)\] loop([\s\S]+?)execute format\('grant %s on public/);
  assert.ok(matrix);
  assert.deepEqual([...matrix[1].matchAll(/'([A-Z]+)'/g)].map(match => match[1]),
    ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]);
  assert.match(matrix[2], /if privilege_name = 'INSERT' and role_name = 'service_role' and table_name = 'operator_account_issuance_events' then continue; end if;/);
});

test("FA20 rehearsal: full populated history is compared both ways before rollback and success", () => {
  assert.match(issuanceRehearsal, /create temporary view fa20_rehearsal_rows/i);
  assert.match(issuanceRehearsal, /create temporary table fa20_rehearsal_before on commit drop as/i);
  for (const table of ["operator_account_issuance_events", "operator_account_issuance_attempts", "operator_account_membership_versions", "organization_members"]) {
    assert.match(issuanceRehearsal, new RegExp(`'${table}'[^;]*to_jsonb\\(r\\)[^;]*from public\\.${table} r`, "i"));
  }
  assert.match(issuanceRehearsal, /count\(distinct table_name\)[\s\S]+?<> 4/);
  const restore = issuanceRehearsal.match(/do \$fa20_restore\$([\s\S]+?)\$fa20_restore\$;/)?.[1];
  assert.ok(restore);
  assert.equal((restore.match(/except all/gi) ?? []).length, 2);
  assert.match(restore, /is distinct from '20260914150000'/);
  assert.ok(issuanceRehearsal.indexOf("fa20_rehearsal_before on commit") < issuanceRehearsal.indexOf("foreach role_name"));
  assert.match(issuanceRehearsal, /rollback;\s*\\echo 'Catalog drift and row restoration passed;/);
});

test("FA20 rehearsal: outer SQL parses but does not establish PLpgSQL or database execution", () => {
  assert.match(issuanceRehearsal, /\\set ON_ERROR_STOP on/);
  const sql = issuanceRehearsal.split(/\r?\n/).filter(line => !line.startsWith("\\")).join("\n");
  assert.equal(hasValidPostgresSyntax(sql), true);
});

test("FA20 rehearsal: preservation oracle rejects self-comparisons, missing locks and exposed snapshots", () => {
  const required = [
    "lock table public.operator_account_issuance_events, public.operator_account_issuance_attempts, public.operator_account_membership_versions, public.organization_members in access exclusive mode;",
    "revoke all on table pg_temp.fa20_rehearsal_rows from public, anon, authenticated, service_role;",
    "revoke all on table pg_temp.fa20_rehearsal_before from public, anon, authenticated, service_role;",
    "(select table_name, row_data from pg_temp.fa20_rehearsal_before except all select table_name, row_data from pg_temp.fa20_rehearsal_rows)",
    "(select table_name, row_data from pg_temp.fa20_rehearsal_rows except all select table_name, row_data from pg_temp.fa20_rehearsal_before)",
  ];
  const check = sql => {
    const normalized = normalizeSql(sql);
    for (const clause of required) assert.ok(normalized.includes(clause), clause);
  };
  const normalized = normalizeSql(issuanceRehearsal);
  check(issuanceRehearsal);
  for (const clause of required) {
    const changed = normalized.replace(clause, clause.startsWith("(select")
      ? clause.replaceAll("pg_temp.fa20_rehearsal_rows", "pg_temp.fa20_rehearsal_before") : "");
    assert.notEqual(changed, normalized);
    assert.throws(() => check(changed));
  }
});

test("FA20 issuance rejects rewrite rules that can suppress event persistence", () => {
  const sql = currentFiles["supabase/migrations/20260914150000_issuance_control_attestation.sql"];
  assert.ok(sql.includes("not exists(select 1 from pg_catalog.pg_rewrite rw where rw.ev_class = c.oid)"));
  assert.ok(sql.includes("rw.ev_class = pg_catalog.to_regclass('public.organization_members')"));
});

test("FA20 issuance requires the forward candidate and independently rejects each owned clause deletion", () => {
  const contract = MIGRATION_CONTRACTS.find(item => item.id === "issuanceControlAttestation");
  const original = currentFiles[contract.path];
  const probe = SECURITY_PROBES.find(item => item.name === "operatorAccountIssuanceAudit");
  assert.equal(probe.expectedVersion, "20260915130000");
  assert.equal(probe.migration, "supabase/migrations/20260915130000_operator_account_issuance_retention.sql");
  assert.equal(buildMigrationContractReport(currentFiles).ok, true);
  const normalized = normalizeSql(original);
  for (const clause of contract.required) {
    const needle = normalizeSql(clause.sql);
    assert.ok(normalized.includes(needle), clause.id);
    const result = buildMigrationContractReport({ ...currentFiles, [contract.path]: normalized.replace(needle, "removed_control") });
    assert.equal(result.ok, false, clause.id);
    assert.ok(result.migrations.find(item => item.id === contract.id).missing.includes(clause.id), clause.id);
  }
});

test("FA20 issuance rejects added authority, null-ignoring aggregates, altered gates and missing prerequisite bodies", () => {
  const contract = MIGRATION_CONTRACTS.find(item => item.id === "issuanceControlAttestation");
  const original = currentFiles[contract.path];
  for (const changed of [undefined,
    original + "\ngrant update on public.operator_account_issuance_events to service_role;",
    original.replace("table_controls.valid and column_controls.valid", "true or table_controls.valid and column_controls.valid"),
    original.replace("count(*) = 4 and bool_and(coalesce(", "count(*) = 4 and bool_and(nullif("),
    original.replace("p.proconfig = r.config", "true")]) {
    assert.equal(buildMigrationContractReport({ ...currentFiles, [contract.path]: changed }).ok, false);
  }
  const prerequisite = "supabase/migrations/20260914140000_operator_account_recovery.sql";
  const result = buildMigrationContractReport({ ...currentFiles, [prerequisite]: undefined });
  const missing = result.migrations.find(item => item.id === contract.id).missing;
  for (const name of ["track_account_membership", "get_account_issuance", "begin_account_issuance", "advance_account_issuance"]) {
    assert.ok(missing.includes(`issuance-approved-body-fireafter_${name}`));
  }
});

test("FA20 issuance keeps predicates in their owner and accepts only CRLF/outer whitespace normalization", () => {
  const contract = MIGRATION_CONTRACTS.find(item => item.id === "issuanceControlAttestation");
  const original = currentFiles[contract.path];
  const clause = contract.required.find(item => item.id === "routine-config");
  const changed = original.replace(clause.sql, "true") + `\n-- ${clause.sql}\n`;
  const report = buildMigrationContractReport({ ...currentFiles, [contract.path]: changed });
  assert.ok(report.migrations.find(item => item.id === contract.id).missing.includes(clause.id));
  assert.equal(buildMigrationContractReport({ ...currentFiles, [contract.path]: "\r\n" + original.replace(/\r?\n/g, "\r\n") + "\t\r\n" }).ok, true);
});

test("FA10 PostgreSQL parser rejects stray SQL even if required clauses remain", () => {
  const path = SECURITY_PROBES.find(probe => probe.name === "atomicBundlePersistence").migration;
  const changed = currentFiles[path] + "\n+\nselect 1;";
  assert.equal(hasValidPostgresSyntax(changed), false);
  const report = buildMigrationContractReport({ ...currentFiles, [path]: changed });
  assert.ok(report.migrations.find(migration => migration.path === path).missing.includes("postgresql-syntax"));
});

test("PostgreSQL syntax checking distinguishes SQL bodies, comments and strings", () => {
  assert.equal(hasValidPostgresSyntax("select '+'; -- +\n"), true);
  assert.equal(hasValidPostgresSyntax("select from;"), false);
  assert.equal(hasValidPostgresSyntax("create function f() returns int language sql as $$ select from; $$;"), false);
  assert.equal(hasValidPostgresSyntax("create function f() returns int language sql as $$ select 1; $$;"), true);
});

test("FA09 current write probe detects effective column-only mutations", () => {
  const probe = SECURITY_PROBES.find(({ name }) => name === "serverOwnedWrites");
  const sql = normalizeSql(currentFiles[probe.migration]);
  for (const role of ["anon", "authenticated"]) {
    assert.ok(sql.includes(`not pg_catalog.has_any_column_privilege('${role}', c.oid, 'insert,update,references')`));
  }
});

test("FA09 current write probe detects destructive non-DML grants", () => {
  const probe = SECURITY_PROBES.find(({ name }) => name === "serverOwnedWrites");
  const sql = normalizeSql(currentFiles[probe.migration]);
  for (const role of ["anon", "authenticated"]) {
    assert.ok(sql.includes(`not pg_catalog.has_table_privilege('${role}', c.oid, 'insert,update,delete,truncate,references,trigger')`));
  }
});

test("FA09 migration aborts rather than claiming success with residual effective grants", () => {
  const probe = SECURITY_PROBES.find(({ name }) => name === "serverOwnedWrites");
  assert.ok(normalizeSql(currentFiles[probe.migration]).includes(
    `if public.fireafter_server_owned_write_security_version() is distinct from '${probe.expectedVersion}' then`));
});

test("FA09 current contract cannot reuse the historical write attestation", () => {
  const probe = SECURITY_PROBES.find(({ name }) => name === "serverOwnedWrites");
  assert.equal(probe.expectedVersion, "20260914070900");
  assert.notEqual(probe.migration, "supabase/migrations/20260904053500_server_owned_operational_writes.sql");
});

test("FA09 rejects predicate removal, comment laundering, always-true gates and extra authority", () => {
  const contract = MIGRATION_CONTRACTS.find(({ id }) => id === "effectiveWritePrivileges");
  const original = currentFiles[contract.path];
  assert.equal(buildMigrationContractReport(currentFiles).ok, true);
  const predicate = "not pg_catalog.has_any_column_privilege('anon', c.oid, 'INSERT,UPDATE,REFERENCES')";
  for (const changed of [
    original.replace(predicate, "true"),
    original.replace(predicate, `true /* ${predicate} */`),
    original.replace(predicate, "true") + `\n/* ${predicate} */`,
    original.replace("select case when table_controls.all_tables_present", "select case when true or table_controls.all_tables_present"),
    original.replace("and role_controls.browser_roles_restricted", "or role_controls.browser_roles_restricted"),
    original + "\ngrant truncate on public.assets to authenticated;",
    original + "\ngrant update (role) on public.organization_members to public;",
    original + "\ngrant execute on function public.fireafter_server_owned_write_security_version() to anon;",
    original + "\n" + original.match(/create or replace function[\s\S]*?\$\$;/)[0],
  ]) {
    assert.notEqual(changed, original);
    const report = buildMigrationContractReport({ ...currentFiles, [contract.path]: changed });
    assert.equal(report.ok, false);
    assert.ok(report.migrations.find(({ id }) => id === contract.id).missing.includes("effective-write-artifact"));
    assert.equal(JSON.stringify(report).includes(changed), false);
  }
});

test("FA09 checks every forward contract clause independently of its artifact seal", () => {
  const contract = MIGRATION_CONTRACTS.find(({ id }) => id === "effectiveWritePrivileges");
  const original = normalizeSql(currentFiles[contract.path]);
  for (const clause of contract.required) {
    const needle = normalizeSql(clause.sql);
    assert.ok(original.includes(needle), clause.id);
    const changed = original.replace(needle, "removed_fa09_clause");
    const report = buildMigrationContractReport({ ...currentFiles, [contract.path]: changed });
    assert.ok(report.migrations.find(({ id }) => id === contract.id).missing.includes(clause.id), clause.id);
  }
});

test("FA09 a predicate outside the probe cannot satisfy its owning-function clause", () => {
  const contract = MIGRATION_CONTRACTS.find(({ id }) => id === "effectiveWritePrivileges");
  const original = currentFiles[contract.path];
  const predicate = "not pg_catalog.has_any_column_privilege('anon', c.oid, 'INSERT,UPDATE,REFERENCES')";
  const changed = original.replace(predicate, "true") + `\n/* ${predicate} */`;
  assert.equal(changed.split(predicate).length, original.split(predicate).length);
  const report = buildMigrationContractReport({ ...currentFiles, [contract.path]: changed });
  const missing = report.migrations.find(({ id }) => id === contract.id).missing;
  assert.ok(missing.includes("anon-column-denial"));
  assert.ok(missing.includes("effective-write-artifact"));
});

test("FA09 accepts CRLF and outer whitespace but rejects missing or internally changed candidates", () => {
  const contract = MIGRATION_CONTRACTS.find(({ id }) => id === "effectiveWritePrivileges");
  const original = currentFiles[contract.path];
  assert.equal(buildMigrationContractReport({ ...currentFiles, [contract.path]: " \t\r\n" + original.replace(/\r?\n/g, "\r\n") + "\n" }).ok, true);
  for (const content of [null, original.replace("Forward candidate only:", "Changed candidate:")]) {
    assert.equal(buildMigrationContractReport({ ...currentFiles, [contract.path]: content }).ok, false);
  }
});

for (const weakenedProbe of [0, 1]) {
  test(`rejects a permission predicate moved out of atomic probe ${weakenedProbe}`, () => {
    const contract = MIGRATION_CONTRACTS.find(({ id }) => id === "atomicRpcAttestation");
    const original = currentFiles[contract.path];
    const predicate = "and not pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')";
    let occurrence = 0;
    const changed = original.replaceAll(predicate, () => occurrence++ === weakenedProbe ? "" : `${predicate}\n    ${predicate}`);
    assert.equal(occurrence, 2);
    assert.notEqual(changed, original);
    assert.equal(changed.split(predicate).length, original.split(predicate).length);
    assert.equal(buildMigrationContractReport(currentFiles).ok, true);
    const report = buildMigrationContractReport({ ...currentFiles, [contract.path]: changed });
    assert.equal(report.ok, false, "Each probe must independently deny browser execution");
    assert.deepEqual(report.migrations.find(({ id }) => id === contract.id).missing,
      ["anon-denial", "attestation-artifact"], "The candidate seal must not mask a regression in per-probe checks");
  });
}

test("rejects an always-true atomic attestation despite retained predicate text", () => {
  const contract = MIGRATION_CONTRACTS.find(({ id }) => id === "atomicRpcAttestation");
  const original = currentFiles[contract.path];
  const changed = original.replace("select case when", "select case when true or");
  assert.notEqual(changed, original);
  assert.equal(buildMigrationContractReport(currentFiles).ok, true);
  assert.equal(buildMigrationContractReport({ ...currentFiles, [contract.path]: changed }).ok, false);
});

test("requires every atomic attestation clause in both probes", () => {
  const contract = MIGRATION_CONTRACTS.find(({ id }) => id === "atomicRpcAttestation");
  const original = currentFiles[contract.path];
  assert.equal(buildMigrationContractReport({ ...currentFiles, [contract.path]: original }).ok, true);
  for (const clause of contract.required) {
    const pattern = new RegExp(clause.sql.trim().split(/\s+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"), "i");
    assert.ok(pattern.test(original), clause.id);
    const changed = original.replace(pattern, "removed_atomic_attestation_clause");
    assert.notEqual(changed, original);
    const result = buildMigrationContractReport({ ...currentFiles, [contract.path]: changed });
    assert.equal(result.ok, false, clause.id);
    const missing = result.migrations.find(({ id }) => id === contract.id).missing;
    assert.ok(missing.includes(clause.id), clause.id);
    assert.ok(missing.includes("attestation-artifact"));
  }
});

test("accepts CRLF and outer ASCII whitespace without changing the attestation identity", () => {
  const contract = MIGRATION_CONTRACTS.find(({ id }) => id === "atomicRpcAttestation");
  const changed = " \t\r\n" + currentFiles[contract.path].replace(/\r?\n/g, "\r\n") + " \t\r\n";
  assert.equal(buildMigrationContractReport({ ...currentFiles, [contract.path]: changed }).ok, true);
});

test("rejects extra grants, duplicate definitions and comment-hidden predicates", () => {
  const contract = MIGRATION_CONTRACTS.find(({ id }) => id === "atomicRpcAttestation");
  const original = currentFiles[contract.path];
  const definition = original.match(/create or replace function[\s\S]*?\$\$;/)[0];
  const predicate = "not pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')";
  for (const changed of [
    original + "\ngrant execute on function public.fireafter_record_responder_action(jsonb,jsonb) to authenticated;",
    original + "\n" + definition,
    original.replace(predicate, `true /* ${predicate} */`),
  ]) {
    assert.notEqual(changed, original);
    const report = buildMigrationContractReport({ ...currentFiles, [contract.path]: changed });
    assert.equal(report.ok, false);
    assert.ok(report.migrations.find(({ id }) => id === contract.id).missing.includes("attestation-artifact"));
    assert.equal(JSON.stringify(report).includes(changed), false);
  }
});

test("detects changed approved bodies even when historical required SQL clauses remain", () => {
  for (const contract of MIGRATION_CONTRACTS.filter(({ id }) => ["atomicResponderAction", "atomicBundlePersistence"].includes(id))) {
    const original = currentFiles[contract.path];
    const changed = original.replace("as $$", () => "as $$\n-- changed body identity");
    assert.notEqual(changed, original);
    const report = buildMigrationContractReport({ ...currentFiles, [contract.path]: changed });
    assert.equal(report.migrations.find(({ id }) => id === contract.id).ok, true);
    assert.equal(report.ok, false);
    assert.match(report.migrations.find(({ id }) => id === "atomicRpcAttestation").missing.join(" "), /approved-body-/);
  }
});

test("accepts all repository migration security contracts", () => {
  const report = buildMigrationContractReport(currentFiles);

  assert.equal(report.ok, true);
  assert.deepEqual(report.nextActions, []);
  assert.deepEqual(report.migrations.map(({ id, failure, missing }) => ({ id, failure, missing })), [
    { id: "serverOwnedWrites", failure: null, missing: [] },
    { id: "atomicResponderAction", failure: null, missing: [] },
    { id: "atomicBundlePersistence", failure: null, missing: [] },
    { id: "operatorAccountIssuanceAudit", failure: null, missing: [] },
    { id: "serverOwnedReads", failure: null, missing: [] },
    { id: "atomicRpcAttestation", failure: null, missing: [] },
    { id: "responderCommand", failure: null, missing: [] },
    { id: "bundleWriteFencing", failure: null, missing: [] },
    { id: "effectiveWritePrivileges", failure: null, missing: [] },
    { id: "importOperationReceipts", failure: null, missing: [] },
    { id: "operatorAccountRecovery", failure: null, missing: [] },
    { id: "issuanceControlAttestation", failure: null, missing: [] },
    { id: "trustedOperatorIdentity", failure: null, missing: [] },
    { id: "operatorAccountIssuanceRetention", failure: null, missing: [] },
    { id: "scheduledRefresh", failure: null, missing: [] },
    { id: "scheduledRefreshClaimFix", failure: null, missing: [] },
    { id: "appendOnlyTriggerHelper", failure: null, missing: [] },
    { id: "durableIngestion", failure: null, missing: [] },
    { id: "bulkBundleCapacity", failure: null, missing: [] },
  ]);
});

test("FA10 rejects drift in the reviewed command transaction or its permission boundary", () => {
  const contract = MIGRATION_CONTRACTS.find(({ id }) => id === "responderCommand");
  const original = currentFiles[contract.path];
  assert.equal(buildMigrationContractReport(currentFiles).ok, true);
  for (const changed of [
    original.replace("for share;", "for key share;"),
    original.replace("return v_receipt.response;", "return null;"),
    original.replace("if not found or v_role not in", "if false and v_role not in"),
    original + "\ngrant execute on function public.fireafter_record_responder_command(uuid,uuid,uuid,uuid,jsonb,jsonb,jsonb) to authenticated;",
  ]) {
    assert.notEqual(changed, original);
    const report = buildMigrationContractReport({ ...currentFiles, [contract.path]: changed });
    assert.equal(report.ok, false);
    assert.ok(report.migrations.find(({ id }) => id === contract.id).missing.includes("command-artifact"));
  }
});

test("fails closed when a migration file is missing", () => {
  const files = { ...currentFiles };
  delete files[MIGRATION_CONTRACTS[1].path];

  const report = buildMigrationContractReport(files);
  const missing = report.migrations.find(({ id }) => id === "atomicResponderAction");

  assert.equal(report.ok, false);
  assert.equal(report.failure, "migration_contract_unverified");
  assert.equal(missing.failure, "migration_missing");
  assert.ok(missing.missing.includes("atomic-responder-rpc"));
  assert.match(report.nextActions[0], /20260906120000_atomic_responder_action_audit\.sql/);
});

test("identifies the exact weakened clause without exposing SQL contents", () => {
  const files = {
    ...currentFiles,
    [MIGRATION_CONTRACTS[2].path]: currentFiles[MIGRATION_CONTRACTS[2].path]
      .replace("security definer", "security invoker"),
  };

  const report = buildMigrationContractReport(files);
  const bundle = report.migrations.find(({ id }) => id === "atomicBundlePersistence");

  assert.equal(report.ok, false);
  assert.equal(bundle.failure, "migration_contract_mismatch");
  assert.deepEqual(bundle.missing, ["atomic-bundle-security-definer"]);
  assert.equal("content" in bundle, false);
  assert.equal(JSON.stringify(report).includes("security invoker"), false);
});

test("durable ingestion requires the existing bundle write fence", () => {
  const contract = MIGRATION_CONTRACTS.find(({ id }) => id === "durableIngestion");
  const original = currentFiles[contract.path];
  const changed = original.replace("perform public.fireafter_commit_bundle(j.actor_id", "perform public.unfenced_bundle(j.actor_id");
  assert.notEqual(changed, original);
  const report = buildMigrationContractReport({ ...currentFiles, [contract.path]: changed });
  assert.equal(report.ok, false);
  assert.ok(report.migrations.find(({ id }) => id === contract.id).missing.includes("fenced-bundle"));
});

test("does not claim a pass for an empty contract set", () => {
  const report = buildMigrationContractReport({});

  assert.equal(report.ok, false);
  assert.equal(report.migrations.length, 19);
  assert.equal(report.migrations.some(migration => migration.id === "operatorAccountRecovery"), true);
  assert.ok(report.migrations.every(({ ok }) => ok === false));
});

test("requires the operator issuance ledger to remain service-role-only", () => {
  const files = { ...currentFiles };
  const contract = MIGRATION_CONTRACTS.find(
    ({ id }) => id === "operatorAccountIssuanceAudit",
  );
  files[contract.path] = files[contract.path].replace(
    "revoke all on table public.operator_account_issuance_events from public, anon, authenticated;",
    "revoke insert on table public.operator_account_issuance_events from public, anon, authenticated;",
  );

  const report = buildMigrationContractReport(files);
  const issuance = report.migrations.find(
    ({ id }) => id === "operatorAccountIssuanceAudit",
  );

  assert.equal(report.ok, false);
  assert.deepEqual(issuance.missing, ["operator-issuance-client-revocation"]);
  assert.equal("content" in issuance, false);
  assert.equal(JSON.stringify(report).includes("revoke insert"), false);
});

test("requires table and column read denial and an effective-privilege probe", () => {
  const contract = MIGRATION_CONTRACTS.find(({ id }) => id === "serverOwnedReads");
  const original = normalizeSql(currentFiles[contract.path]);
  assert.equal(buildMigrationContractReport({ ...currentFiles, [contract.path]: original }).ok, true);
  for (const clause of contract.required) {
    const needle = normalizeSql(clause.sql);
    assert.ok(original.includes(needle), `Missing mutation target: ${clause.id}`);
    const changed = original.replace(needle, "removed_read_security_contract");
    assert.notEqual(changed, original);
    const files = { ...currentFiles, [contract.path]: changed };
    const result = buildMigrationContractReport(files);
    assert.equal(result.ok, false, clause.id);
    const missing = result.migrations.find(({ id }) => id === "serverOwnedReads").missing;
    assert.ok(missing.includes(clause.id));
    assert.ok(missing.every(id => id === clause.id || id === "postgresql-syntax"));
  }
});

test("FA10 requires the bundle migration even when the other contracts pass", () => {
  const contract = MIGRATION_CONTRACTS.find(({ id }) => id === "bundleWriteFencing");
  assert.equal(contract.path, "supabase/migrations/20260914034000_bundle_write_fencing.sql");
  const files = { ...currentFiles };
  delete files[contract.path];
  const report = buildMigrationContractReport(files);
  assert.equal(report.migrations.length, 19);
  assert.equal(report.ok, false);
  assert.ok(report.migrations.filter(({ id }) => id !== contract.id).every(({ ok }) => ok));
  assert.equal(report.migrations.find(({ id }) => id === contract.id).failure, "migration_missing");
  assert.match(report.nextActions.join(" "), /20260914034000_bundle_write_fencing\.sql/);
});

test("FA10 preserves historical body pins and independently checks the wrapper and helper bodies", () => {
  assert.deepEqual(ATOMIC_RPC_BODY_CONTRACTS.map(({ sha256 }) => sha256), [
    "8011fd1cb4a16fe7ee059ff7d80161c13fe4192aa0d7b6552b122292131a2075",
    "8da7cbfdbdec493d6df5322aada6c599de0748964649f91dccbb3b7af3295b8b",
  ]);
  const contract = MIGRATION_CONTRACTS.find(({ id }) => id === "bundleWriteFencing");
  for (const expected of BUNDLE_RPC_BODY_CONTRACTS) {
    const original = currentFiles[expected.path];
    const changed = original.replace("as $$", () => "as $$\n-- body changed without updating the embedded hash");
    assert.notEqual(changed, original);
    const files = { ...currentFiles, [expected.path]: changed };
    assert.ok(files[contract.path].includes(expected.sha256));
    const report = buildMigrationContractReport(files);
    assert.equal(report.ok, false);
    assert.ok(report.migrations.find(({ id }) => id === contract.id).missing.includes(`approved-bundle-${expected.id}-body`));
    if (expected.id === "helper") {
      assert.ok(report.migrations.find(({ id }) => id === "atomicRpcAttestation").missing.includes("approved-body-1"));
    }
  }
});

test("FA10 requires every new bundle clause in its owning definition", () => {
  const contract = MIGRATION_CONTRACTS.find(({ id }) => id === "bundleWriteFencing");
  const original = currentFiles[contract.path];
  for (const clause of contract.required) {
    const pattern = new RegExp(clause.sql.trim().split(/\s+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"), "i");
    assert.ok(pattern.test(original), `Missing mutation target: ${clause.id}`);
    const changed = original.replace(pattern, "removed_bundle_fencing_clause");
    const report = buildMigrationContractReport({ ...currentFiles, [contract.path]: changed });
    assert.equal(report.ok, false, clause.id);
    const missing = report.migrations.find(({ id }) => id === contract.id).missing;
    assert.ok(missing.includes(clause.id), clause.id);
    assert.ok(missing.includes("bundle-fencing-artifact"), clause.id);
  }
});

test("FA10 cannot borrow bundle-probe permission predicates from the wrapper", () => {
  const contract = MIGRATION_CONTRACTS.find(({ id }) => id === "bundleWriteFencing");
  const original = currentFiles[contract.path];
  const predicate = "not pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')";
  const changed = original.replace(predicate, "true")
    .replace("as $$", () => `as $$\n${predicate};`);
  assert.notEqual(changed, original);
  assert.equal(changed.split(predicate).length, original.split(predicate).length);
  const report = buildMigrationContractReport({ ...currentFiles, [contract.path]: changed });
  const missing = report.migrations.find(({ id }) => id === contract.id).missing;
  assert.equal(report.ok, false);
  assert.ok(missing.includes("anon-denial"));
  assert.ok(missing.includes("bundle-fencing-artifact"));
});

test("FA10 rejects bundle OR true, hidden predicates, permission drift and duplicate definitions", () => {
  const contract = MIGRATION_CONTRACTS.find(({ id }) => id === "bundleWriteFencing");
  const original = currentFiles[contract.path];
  const predicate = "not pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')";
  const wrapper = original.match(/create function public\.fireafter_commit_bundle\([\s\S]*?\$\$;/)[0];
  const probe = original.match(/create or replace function public\.fireafter_bundle_persistence_security_version\([\s\S]*?\$\$;/)[0];
  for (const changed of [
    original.replace("controls.verified is not distinct from true", "(controls.verified is not distinct from true OR true)"),
    original.replace(predicate, `true /* ${predicate} */`),
    original.replace("if p_expected_revision is distinct from v_current_revision then", "if false then"),
    original + "\ngrant execute on function public.fireafter_commit_bundle(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) to authenticated;",
    original + "\ngrant execute on function public.fireafter_persist_bundle(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) to service_role;",
    original + "\ngrant execute on function public.fireafter_bundle_persistence_security_version() to anon;",
    original + "\n" + wrapper,
    original + "\n" + probe,
  ]) {
    assert.notEqual(changed, original);
    const report = buildMigrationContractReport({ ...currentFiles, [contract.path]: changed });
    assert.equal(report.ok, false);
    assert.ok(report.migrations.find(({ id }) => id === contract.id).missing.includes("bundle-fencing-artifact"));
    assert.equal(JSON.stringify(report).includes(changed), false);
  }
});

test("FA10 rejects a missing, renamed or duplicated helper body independently of the new artifact", () => {
  const helper = BUNDLE_RPC_BODY_CONTRACTS.find(({ id }) => id === "helper");
  const original = currentFiles[helper.path];
  const definition = original.match(/create or replace function public\.fireafter_persist_bundle\([\s\S]*?\$\$;/)[0];
  for (const changed of [null, original.replace("function public.fireafter_persist_bundle(", "function public.renamed_bundle("), original + "\n" + definition]) {
    const report = buildMigrationContractReport({ ...currentFiles, [helper.path]: changed });
    assert.equal(report.ok, false);
    const missing = report.migrations.find(({ id }) => id === "bundleWriteFencing").missing;
    assert.ok(missing.includes("approved-bundle-helper-body"));
    assert.equal(missing.includes("bundle-fencing-artifact"), false);
  }
});

test("FA10 accepts only line-ending and outer ASCII whitespace normalization for the new seal", () => {
  const contract = MIGRATION_CONTRACTS.find(({ id }) => id === "bundleWriteFencing");
  const original = currentFiles[contract.path];
  const changed = " \t\r\n" + original.replace(/\r?\n/g, "\r\n") + " \t\r\n";
  assert.equal(buildMigrationContractReport({ ...currentFiles, [contract.path]: changed }).ok, true);
  const internalChange = original.replace("Candidate only:", "Candidate identity changed:");
  assert.notEqual(internalChange, original);
  const report = buildMigrationContractReport({ ...currentFiles, [contract.path]: internalChange });
  assert.equal(report.ok, false);
  assert.deepEqual(report.migrations.find(({ id }) => id === contract.id).missing, ["bundle-fencing-artifact"]);
});

test("scheduled-refresh forward migration requires qualified lease columns", () => {
  const contract = MIGRATION_CONTRACTS.find(({ id }) => id === "scheduledRefreshClaimFix");
  const original = currentFiles[contract.path];
  assert.equal(buildMigrationContractReport(currentFiles).ok, true);

  const changed = original.replace(
    "where lease.attempt_id is not null and lease.lease_until <= v_now",
    "where attempt_id is not null and lease_until <= v_now",
  );
  assert.notEqual(changed, original);
  const report = buildMigrationContractReport({ ...currentFiles, [contract.path]: changed });
  const migration = report.migrations.find(({ id }) => id === contract.id);
  assert.equal(report.ok, false);
  assert.equal(migration.failure, "migration_contract_mismatch");
  assert.ok(migration.missing.includes("expiry-sweep-qualified-predicate"));
});

test("scheduled-refresh rejects an ambiguous conflict target even when the probe retains the fixed text", () => {
  const contract = MIGRATION_CONTRACTS.find(({ id }) => id === "scheduledRefreshClaimFix");
  const original = currentFiles[contract.path];
  const changed = original.replace(
    "on conflict on constraint scheduled_refresh_leases_pkey do nothing;",
    "on conflict (incident_id) do nothing;",
  );
  assert.notEqual(changed, original);
  const report = buildMigrationContractReport({ ...currentFiles, [contract.path]: changed });
  assert.equal(report.ok, false);
  assert.ok(report.migrations.find(({ id }) => id === contract.id).missing.includes("claim-named-conflict-target"));
});

test("scheduled-refresh rejects a probe that does not check the conflict target", () => {
  const contract = MIGRATION_CONTRACTS.find(({ id }) => id === "scheduledRefreshClaimFix");
  const original = currentFiles[contract.path];
  const changed = original.replace(
    "p.prosrc like '%on conflict on constraint scheduled_refresh_leases_pkey do nothing%'",
    "true",
  );
  assert.notEqual(changed, original);
  const report = buildMigrationContractReport({ ...currentFiles, [contract.path]: changed });
  assert.equal(report.ok, false);
  assert.ok(report.migrations.find(({ id }) => id === contract.id).missing.includes("probe-checks-conflict-target"));
});

test("scheduled-refresh probe and application share the forward correction version", () => {
  const source = readFileSync(new URL("../src/lib/operational-write-security.ts", import.meta.url), "utf8");
  const version = source.match(/export const SCHEDULED_REFRESH_SECURITY_VERSION\s*=\s*"([^"]+)";/)?.[1];
  const probe = SECURITY_PROBES.find(({ name }) => name === "scheduledRefresh");
  assert.equal(version, "20261002000000");
  assert.equal(probe.expectedVersion, version);
  assert.equal(probe.migration, "supabase/migrations/20261002000000_scheduled_refresh_claim_ambiguity_fix.sql");
  assert.equal(MIGRATION_CONTRACTS.find(({ id }) => id === "scheduledRefreshClaimFix").path, probe.migration);
});
