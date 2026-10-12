import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MIGRATION_CONTRACTS, SECURITY_PROBES } from "./migration-contract-verifier.mjs";
import {
  buildProbeResult,
  buildVerificationReport,
} from "./write-boundary-verifier.mjs";

const serverProbe = {
  rpc: "fireafter_server_owned_write_security_version",
  expectedVersion: "20260914070900",
  migration: "supabase/migrations/20260914070900_effective_write_privileges.sql",
};

test("FA19-C2 refuses an omitted or duplicate required probe", () => {
  const complete = SECURITY_PROBES.map((probe) => buildProbeResult(probe, { data: probe.expectedVersion, error: null }));
  assert.equal(buildVerificationReport("project.supabase.co", complete).ok, true);
  assert.equal(buildVerificationReport("project.supabase.co", complete.slice(0, -1)).ok, false);
  assert.equal(buildVerificationReport("project.supabase.co", [...complete.slice(0, -1), complete[0]]).ok, false);
});

test("FA19-C2 fails the six-probe gate when raw-read protection is unavailable", () => {
  const results = SECURITY_PROBES.map((probe) => buildProbeResult(probe,
    { data: probe.name === "serverOwnedReads" ? null : probe.expectedVersion, error: null }));
  const report = buildVerificationReport("project.supabase.co", results);
  assert.equal(report.ok, false);
  assert.equal(report.probes.length, 6);
  assert.match(report.nextActions.join(" "), /20260913230300_server_owned_operational_reads/);
});

test("accepts an exact live server-owned-write version", () => {
  const result = buildProbeResult(serverProbe, {
    data: "20260914070900",
    error: null,
  });

  assert.deepEqual(result, {
    ok: true,
    rpc: serverProbe.rpc,
    expectedVersion: "20260914070900",
    observedVersion: "20260914070900",
    failure: null,
    migration: serverProbe.migration,
    nextAction: null,
  });
});

test("FA09 rejects historical write proof even if a caller labels it successful", () => {
  const current = SECURITY_PROBES.find(({ name }) => name === "serverOwnedWrites");
  const result = buildProbeResult(current, { data: "20260904053500", error: null });
  assert.equal(result.ok, false);
  assert.equal(result.failure, "security_version_mismatch");
  assert.match(result.nextAction, /20260914070900_effective_write_privileges/);
  const results = SECURITY_PROBES.map(probe => buildProbeResult(probe, { data: probe.expectedVersion, error: null }));
  const old = results.find(probe => probe.rpc === current.rpc);
  old.ok = true;
  old.observedVersion = "20260904053500";
  assert.equal(buildVerificationReport("test-project.supabase.co", results).ok, false);
});

test("classifies an unavailable probe without retaining provider details", () => {
  const result = buildProbeResult(serverProbe, {
    data: null,
    error: { message: "secret provider diagnostic" },
  });

  assert.equal(result.ok, false);
  assert.equal(result.failure, "security_probe_unavailable");
  assert.match(result.nextAction, /configured Supabase project and service-role access/);
  assert.match(result.nextAction, /20260914070900_effective_write_privileges\.sql/);
  assert.equal("message" in result, false);
  assert.equal(JSON.stringify(result).includes("secret provider diagnostic"), false);
});

test("fails closed on a missing or mismatched version", () => {
  assert.equal(
    buildProbeResult(serverProbe, { data: null, error: null }).failure,
    "live_controls_not_verified",
  );
  assert.equal(
    buildProbeResult(serverProbe, { data: "older", error: null }).failure,
    "security_version_mismatch",
  );
  assert.match(
    buildProbeResult(serverProbe, { data: null, error: null }).nextAction,
    /Apply .*20260914070900_effective_write_privileges\.sql/,
  );
  assert.match(
    buildProbeResult(serverProbe, { data: "older", error: null }).nextAction,
    /Reconcile .*20260914070900_effective_write_privileges\.sql/,
  );
});

test("requires every named security control for an aggregate pass", () => {
  const report = buildVerificationReport("project.supabase.co", [
    buildProbeResult(serverProbe, { data: "20260914070900", error: null }),
    buildProbeResult(
      {
        rpc: "fireafter_responder_action_security_version",
        expectedVersion: "20260906120000",
        migration: "supabase/migrations/20260906120000_atomic_responder_action_audit.sql",
      },
      { data: null, error: true },
    ),
    buildProbeResult(
      {
        rpc: "fireafter_bundle_persistence_security_version",
        expectedVersion: "20260910120000",
        migration: "supabase/migrations/20260910120000_atomic_bundle_persistence.sql",
      },
      { data: "20260910120000", error: null },
    ),
    buildProbeResult(
      {
        rpc: "fireafter_operator_account_issuance_audit_security_version",
        expectedVersion: "20260915130000",
        migration: "supabase/migrations/20260915130000_operator_account_issuance_retention.sql",
      },
      { data: "20260915130000", error: null },
    ),
  ]);

  assert.equal(report.ok, false);
  assert.equal(report.failure, "security_controls_unverified");
  assert.equal(report.probes.length, 4);
  assert.equal(report.nextActions.length, 3);
  assert.match(report.nextActions[0], /20260906120000_atomic_responder_action_audit\.sql/);
});

test("FA24 aggregate rejects the old issuance proof even when other controls pass", () => {
  const results = SECURITY_PROBES.map(probe => buildProbeResult(probe, {
    data: probe.name === "operatorAccountIssuanceAudit" ? "20260910173914" : probe.expectedVersion, error: null,
  }));
  const report = buildVerificationReport("project.supabase.co", results);
  assert.equal(report.ok, false);
  assert.match(report.nextActions.join(" "), /20260915130000_operator_account_issuance_retention/);
});

test("passes only when all exact security controls are present", () => {
  const report = buildVerificationReport("project.supabase.co", SECURITY_PROBES.map((probe) =>
    buildProbeResult(probe, { data: probe.expectedVersion, error: null })));

  assert.equal(report.ok, true);
  assert.equal(report.failure, null);
  assert.deepEqual(report.nextActions, []);
});

test("FA20 rejects either historical atomic probe and names the forward migration", () => {
  for (const [name, oldVersion] of [["atomicResponderAction", "20260906120000"], ["atomicBundlePersistence", "20260910120000"], ["atomicBundlePersistence", "20260913234000"]]) {
    const probe = SECURITY_PROBES.find((item) => item.name === name);
    assert.equal(probe.expectedVersion, name === "atomicResponderAction" ? "20260914010000" : "20261002010000");
    const report = buildVerificationReport("project.supabase.co", SECURITY_PROBES.map((item) =>
      buildProbeResult(item, { data: item.name === name ? oldVersion : item.expectedVersion, error: null })));
    assert.equal(report.ok, false);
    assert.match(report.nextActions.join(" "), name === "atomicResponderAction"
      ? /20260914010000_responder_command_contract/ : /20261002010000_bulk_bundle_capacity/);
  }
});

test("FA10 CLI and application agree on the current bundle version and probe", () => {
  // Read application constants only; do not import the credential-loading CLI.
  const source = readFileSync(new URL("../src/lib/operational-write-security.ts", import.meta.url), "utf8");
  const version = source.match(/export const ATOMIC_BUNDLE_PERSISTENCE_SECURITY_VERSION\s*=\s*"([^"]+)";/)?.[1];
  const rpc = source.match(/export const ATOMIC_BUNDLE_PERSISTENCE_SECURITY_PROBE_RPC\s*=\s*"([^"]+)";/)?.[1];
  const probe = SECURITY_PROBES.find(({ name }) => name === "atomicBundlePersistence");
  assert.equal(version, "20261002010000");
  assert.equal(probe.expectedVersion, version);
  assert.equal(rpc, "fireafter_bundle_persistence_security_version");
  assert.equal(probe.rpc, rpc);
  assert.equal(probe.migration, "supabase/migrations/20261002010000_bulk_bundle_capacity.sql");
  assert.equal(MIGRATION_CONTRACTS.find(({ id }) => id === "bulkBundleCapacity").path, probe.migration);
  assert.equal(MIGRATION_CONTRACTS.find(({ id }) => id === "bundleWriteFencing").path, "supabase/migrations/20260914034000_bundle_write_fencing.sql");
  assert.equal(SECURITY_PROBES.length, 6);
  assert.equal(buildProbeResult(probe, { data: version, error: null }).ok, true);
});

test("FA10 rejects a self-consistent stale bundle result at the aggregate gate", () => {
  const results = SECURITY_PROBES.map((probe) => buildProbeResult(probe, { data: probe.expectedVersion, error: null }));
  const bundle = results.find(({ rpc }) => rpc === "fireafter_bundle_persistence_security_version");
  bundle.expectedVersion = "20260913234000";
  bundle.observedVersion = "20260913234000";
  assert.equal(bundle.ok, true);
  assert.equal(buildVerificationReport("project.supabase.co", results).ok, false);
});
