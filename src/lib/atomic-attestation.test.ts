import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { checkSupabaseRealitySchema } from "./fireafter-supabase";
import {
  ATOMIC_RESPONDER_ACTION_SECURITY_VERSION,
  ATOMIC_BUNDLE_PERSISTENCE_SECURITY_VERSION,
  ATOMIC_BUNDLE_PERSISTENCE_SECURITY_RPC,
  ATOMIC_BUNDLE_PERSISTENCE_SECURITY_PROBE_RPC,
} from "./operational-write-security";

vi.mock("./supabase", () => ({ getSupabaseAdminClient: vi.fn(), getSupabaseServerClient: vi.fn() }));

const historicalVersion = "20260913234000";
const version = "20261002010000";
const path = "supabase/migrations/20260913234000_atomic_rpc_attestation.sql";
const originals = [
  "supabase/migrations/20260906120000_atomic_responder_action_audit.sql",
  "supabase/migrations/20260910120000_atomic_bundle_persistence.sql",
];

describe("FA20 atomic attestation (local contracts, not executed SQL)", () => {
  it("requires the stronger version for both atomic controls", () => {
    expect(ATOMIC_RESPONDER_ACTION_SECURITY_VERSION).toBe("20260914010000");
    expect(ATOMIC_BUNDLE_PERSISTENCE_SECURITY_VERSION).toBe(version);
    expect(ATOMIC_BUNDLE_PERSISTENCE_SECURITY_RPC).toBe("fireafter_commit_bundle");
    expect(ATOMIC_BUNDLE_PERSISTENCE_SECURITY_PROBE_RPC).toBe("fireafter_bundle_persistence_security_version");
  });

  it("does not accept the historical existence-only probes", async () => {
    const rpc = vi.fn(async (name: string) => ({ error: null,
      data: name === "fireafter_responder_action_security_version" ? "20260906120000" : "20260910120000" }));
    const client = { from: () => ({ select: () => ({ limit: async () => ({ data: [], error: null }) }) }), rpc };
    const result = await checkSupabaseRealitySchema(client);
    expect(result.atomicResponderActionVersion).toBeNull();
    expect(result.atomicBundlePersistenceVersion).toBeNull();
  });

  it.each([version, historicalVersion, "20260914034000", "20260914010000", null, {}, 123, "unrecognized"])("requires exact provider proof: %j", async (data) => {
    const rpc = vi.fn(async () => ({ data, error: null }));
    const client = { from: () => ({ select: () => ({ limit: async () => ({ data: [], error: null }) }) }), rpc };
    const result = await checkSupabaseRealitySchema(client);
    expect(result.atomicResponderActionVersion).toBe(data === "20260914010000" ? "20260914010000" : null);
    expect(result.atomicBundlePersistenceVersion).toBe(data === version ? version : null);
  });

  it.each(["returned", "thrown"])("fails closed on %s provider errors", async (mode) => {
    const rpc = vi.fn(async () => {
      if (mode === "thrown") throw new Error("PRIVATE_PROVIDER_DETAIL");
      return { data: version, error: { message: "PRIVATE_PROVIDER_DETAIL" } };
    });
    const client = { from: () => ({ select: () => ({ limit: async () => ({ data: [], error: null }) }) }), rpc };
    const result = await checkSupabaseRealitySchema(client);
    expect(result.atomicResponderActionVersion).toBeNull();
    expect(result.atomicBundlePersistenceVersion).toBeNull();
    expect(JSON.stringify(result)).not.toContain("PRIVATE_PROVIDER_DETAIL");
  });

  it("preserves the historical attestation phase and its approved helper bodies", () => {
    expect(existsSync(path)).toBe(true);
    const sql = readFileSync(path, "utf8");
    for (const original of originals) {
      const body = readFileSync(original, "utf8").match(/as \$\$([\s\S]*?)\$\$;/)?.[1];
      expect(body).toBeDefined();
      const canonical = body!.replace(/\r\n/g, "\n").replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
      const hash = createHash("sha256").update(canonical).digest("hex");
      expect(sql).toContain(hash);
      expect(createHash("sha256").update(canonical + "\nreturn;").digest("hex")).not.toBe(hash);
    }
    expect(sql).toContain("pg_catalog.sha256");
    expect(sql).toContain("p.prosrc");
    expect(sql).toContain("p.prosecdef");
    expect(sql).toContain("p.proconfig = array['search_path=public']::text[]");
    expect(sql).toContain("pg_catalog.pg_get_userbyid(p.proowner) = 'postgres'");
    for (const role of ["anon", "authenticated"]) {
      expect(sql).toContain(`not pg_catalog.has_function_privilege('${role}', p.oid, 'EXECUTE')`);
    }
    expect(sql).toContain("pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')");
    expect(sql).toContain(`is distinct from '${historicalVersion}'`);
  });
});
