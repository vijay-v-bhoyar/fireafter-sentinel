import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSupabaseAdminClient } from "./supabase";
import { checkSupabaseRealitySchema } from "./fireafter-supabase";
import { buildOperationalHealth, type DeploymentReadinessChecks } from "./readiness";
import { GET } from "@/app/api/readiness/route";
import * as controls from "./operational-write-security";

vi.mock("./supabase", () => ({ getSupabaseAdminClient: vi.fn(), getSupabaseServerClient: vi.fn(), hasSupabaseEnv: () => true, hasSupabaseAdminEnv: () => true }));
vi.mock("./fireafter-data", () => ({ getDashboardBundle: async () => emptyBundle(), createEmptyDashboardBundle: () => emptyBundle() }));

const marker = "PRIVATE_DIAGNOSTIC_7f4a";
const secretShaped = `${marker}\npostgres://test-user:test-only-password@internal.example/db?token=test-only-token`;
function emptyBundle() {
  return { incident: { id: "readiness-test", locationId: "unselected", county: "No county selected", state: "US",
    title: "Search a county to start", code: "FA-UNSELECTED", status: "Monitoring" as const,
    stormWindow: "No active storm window", rainfallForecast: "Not available", lastRefresh: "Never", dataFreshness: "Low" as const,
    activeAlerts: 0, selectedFire: { name: "No fire context selected", acres: 0, perimeterUpdated: "Not available", source: "No source selected" } },
    assets: [], sourceSnapshots: [], recommendations: [], actions: [], auditEvents: [], locations: [] };
}
function client(diagnostic?: unknown, thrown = false, failedRpc?: string, wrongVersion = false) {
  const versions: Record<string, string> = {
    [controls.SERVER_OWNED_WRITE_SECURITY_RPC]: controls.SERVER_OWNED_WRITE_SECURITY_VERSION,
    [controls.SERVER_OWNED_READ_SECURITY_RPC]: controls.SERVER_OWNED_READ_SECURITY_VERSION,
    [controls.ATOMIC_RESPONDER_ACTION_SECURITY_PROBE_RPC]: controls.ATOMIC_RESPONDER_ACTION_SECURITY_VERSION,
    [controls.ATOMIC_BUNDLE_PERSISTENCE_SECURITY_PROBE_RPC]: controls.ATOMIC_BUNDLE_PERSISTENCE_SECURITY_VERSION,
    [controls.OPERATOR_ACCOUNT_ISSUANCE_AUDIT_SECURITY_PROBE_RPC]: controls.OPERATOR_ACCOUNT_ISSUANCE_AUDIT_SECURITY_VERSION,
    [controls.SCHEDULED_REFRESH_SECURITY_PROBE_RPC]: controls.SCHEDULED_REFRESH_SECURITY_VERSION,
  };
  return { from: () => ({ select: () => ({ limit: async () => {
    if (thrown) throw diagnostic;
    return { data: [], error: diagnostic ?? null };
  } }) }), rpc: async (name: string) => name === failedRpc
    ? { data: wrongVersion ? "obsolete-version" : null, error: wrongVersion ? null : { message: secretShaped } }
    : { data: versions[name], error: null } };
}
const checks: DeploymentReadinessChecks = { supabaseConfigured: true, supabaseSchemaReady: true,
  serverOwnedWritesVerified: true, serverOwnedReadsVerified: true, atomicResponderActionWriteVerified: true,
  atomicBundlePersistenceWriteVerified: true, operatorAccountIssuanceAuditVerified: true,
  scheduledRefreshVerified: true,
  nasaFirmsConfigured: true, nwsUserAgentConfigured: true, cronSecretConfigured: true };

beforeEach(() => { vi.clearAllMocks(); vi.spyOn(console, "warn").mockImplementation(() => undefined); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("FA22 public readiness privacy", () => {
  it.each([
    { name: "returned database error", value: { code: "42501", message: secretShaped, details: secretShaped }, thrown: false },
    { name: "thrown Error", value: new Error(secretShaped), thrown: true },
    { name: "thrown object", value: { name: marker, message: secretShaped, cause: secretShaped }, thrown: true },
    { name: "thrown string", value: secretShaped, thrown: true },
    { name: "thrown null", value: null, thrown: true },
  ])("keeps $name private from producer through actual GET serialization", async ({ value, thrown }) => {
    vi.mocked(getSupabaseAdminClient).mockReturnValue(client(value, thrown) as never);
    const schema = await checkSupabaseRealitySchema();
    expect(schema.ready).toBe(false);
    expect(schema.errors).toHaveLength(5);
    expect(JSON.stringify(schema)).not.toContain(marker);
    expect(schema.errors.every(message => /verify Supabase/.test(message))).toBe(true);
    const response = await GET(new Request("http://localhost/api/readiness"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain(marker);
    expect(body.deployment.status).toBe("blocked");
    expect(body.deployment.blockers).toContain("Supabase reality-upgrade migration has not been verified.");
    expect(body.deployment.actions.join(" ")).toMatch(/connectivity.*permissions.*migrations/i);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(marker);
    expect(vi.mocked(console.warn).mock.calls).toEqual(
      Array.from({ length: 2 }, () => ["source_runs", "incidents", "source_snapshots", "assets", "recommendations"].map(table =>
        ["[fireafter] schema probe failed", { operation: "schema_probe", table, code: "schema_probe_failed" }])).flat(),
    );
  });

  it.each([secretShaped, "Unknown upstream error", " ", "x".repeat(10_000)])("does not forward arbitrary formatter diagnostics", error => {
    const report = buildOperationalHealth(emptyBundle(), { ...checks, errors: [error, error] });
    expect(report.deployment.actions).toHaveLength(1);
    expect(report.deployment.actions[0]).toMatch(/connectivity.*permissions.*migrations/i);
    expect(report.deployment.actions).not.toContain(error);
    expect(report.deployment.status).toBe("needs_attention");
  });

  it("preserves successful schema and all six live control results", async () => {
    vi.mocked(getSupabaseAdminClient).mockReturnValue(client() as never);
    const schema = await checkSupabaseRealitySchema();
    expect(schema.ready).toBe(true);
    expect(schema.errors).toEqual([]);
    expect(schema.serverOwnedReadsVersion).toBe(controls.SERVER_OWNED_READ_SECURITY_VERSION);
    expect(schema.serverOwnedWritesVersion).toBe(controls.SERVER_OWNED_WRITE_SECURITY_VERSION);
    expect(schema.atomicResponderActionVersion).toBe(controls.ATOMIC_RESPONDER_ACTION_SECURITY_VERSION);
    expect(schema.atomicBundlePersistenceVersion).toBe(controls.ATOMIC_BUNDLE_PERSISTENCE_SECURITY_VERSION);
    expect(schema.operatorAccountIssuanceAuditVersion).toBe(controls.OPERATOR_ACCOUNT_ISSUANCE_AUDIT_SECURITY_VERSION);
    expect(schema.scheduledRefreshVersion).toBe(controls.SCHEDULED_REFRESH_SECURITY_VERSION);
    expect(buildOperationalHealth(emptyBundle(), checks).deployment.actions).toEqual([]);
    vi.stubEnv("NASA_FIRMS_MAP_KEY", "test-only-key");
    vi.stubEnv("FIREAFTER_NWS_USER_AGENT", "test-only-contact");
    vi.stubEnv("CRON_SECRET", "test-only-cron");
    const response = await GET(new Request("http://localhost/api/readiness"));
    const report = await response.json();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(report.deployment.status).toBe("operational");
    expect(report.deployment.blockers).toEqual([]);
    expect(report.deployment.actions).toEqual([]);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it.each([
    [controls.SERVER_OWNED_WRITE_SECURITY_RPC, "Server-owned operational-write migration has not been verified.", controls.SERVER_OWNED_WRITE_SECURITY_VERSION],
    [controls.SERVER_OWNED_READ_SECURITY_RPC, "Server-owned operational-read migration has not been verified.", controls.SERVER_OWNED_READ_SECURITY_VERSION],
    [controls.ATOMIC_RESPONDER_ACTION_SECURITY_PROBE_RPC, "Atomic responder-action persistence migration has not been verified.", controls.ATOMIC_RESPONDER_ACTION_SECURITY_VERSION],
    [controls.ATOMIC_BUNDLE_PERSISTENCE_SECURITY_PROBE_RPC, "Atomic incident-bundle persistence migration has not been verified.", controls.ATOMIC_BUNDLE_PERSISTENCE_SECURITY_VERSION],
    [controls.OPERATOR_ACCOUNT_ISSUANCE_AUDIT_SECURITY_PROBE_RPC, "Operator account issuance audit migration has not been verified.", controls.OPERATOR_ACCOUNT_ISSUANCE_AUDIT_SECURITY_VERSION],
  ].flatMap(([rpc, blocker, version]) => [{ rpc, blocker, version, wrongVersion: false }, { rpc, blocker, version, wrongVersion: true }]))
  ("keeps $rpc blocked with wrongVersion=$wrongVersion", async ({ rpc, blocker, version, wrongVersion }) => {
    vi.mocked(getSupabaseAdminClient).mockReturnValue(client(undefined, false, rpc, wrongVersion) as never);
    const response = await GET(new Request("http://localhost/api/readiness"));
    const report = await response.json();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(report.deployment.status).toBe("blocked");
    expect(report.deployment.blockers).toEqual([blocker]);
    const evidence = report.deployment.evidence.join(" ");
    for (const expected of [controls.SERVER_OWNED_WRITE_SECURITY_VERSION, controls.SERVER_OWNED_READ_SECURITY_VERSION,
      controls.ATOMIC_RESPONDER_ACTION_SECURITY_VERSION, controls.ATOMIC_BUNDLE_PERSISTENCE_SECURITY_VERSION,
      controls.OPERATOR_ACCOUNT_ISSUANCE_AUDIT_SECURITY_VERSION]) {
      if (expected === version) expect(evidence).not.toContain(expected);
      else expect(evidence).toContain(expected);
    }
    expect(JSON.stringify(report)).not.toContain(marker);
    expect(JSON.stringify(report)).not.toContain("obsolete-version");
  });
});
