import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { checkSupabaseRealitySchema } from "./fireafter-supabase";

vi.mock("./supabase", () => ({ getSupabaseAdminClient: vi.fn(), getSupabaseServerClient: vi.fn() }));

const rpcName = "fireafter_server_owned_read_security_version";
const version = "20260913230300";
const migrationPath = "supabase/migrations/20260913230300_server_owned_operational_reads.sql";
const tables = ["incidents", "source_runs", "source_snapshots", "assets", "recommendations", "responder_actions", "audit_events"];

describe("FA19-C1 migration contract (static, not database proof)", () => {
  it("revokes raw table and column reads without changing membership self-read", () => {
    const sql = existsSync(migrationPath) ? readFileSync(migrationPath, "utf8") : "";
    expect(sql).toContain("revoke select on table");
    for (const table of tables) expect(sql).toContain(`public.${table}`);
    expect(sql).toContain("revoke select (%s) on table public.%I from public, anon, authenticated");
    expect(sql).toContain("has_any_column_privilege");
    expect(sql).toContain("count(*) = 7");
    expect(sql).toContain("grant select on table");
    expect(sql).not.toMatch(/revoke[^;]*organization_members/i);
    expect(sql).not.toMatch(/\b(delete from|truncate|drop table)\b/i);
    expect(sql).toContain("set local lock_timeout = '2s'");
    expect(sql).toContain("set local statement_timeout = '60s'");
  });
});

describe("FA19-C2 schema probe", () => {
  it.each([version, null, "wrong-version", { unexpected: version }])("accepts only the exact live read version: %j", async (data) => {
    const rpc = vi.fn(async () => ({ data, error: null }));
    const client = { from: () => ({ select: () => ({ limit: async () => ({ data: [], error: null }) }) }), rpc };
    const result = await checkSupabaseRealitySchema(client);
    expect(rpc).toHaveBeenCalledWith(rpcName);
    expect(result).toMatchObject({ serverOwnedReadsVersion: data === version ? version : null,
      serverOwnedReadsProbeError: null });
  });

  it.each(["returned", "thrown"])("fails closed with safe diagnostics on %s errors", async (mode) => {
    const rpc = vi.fn(async () => {
      if (mode === "thrown") throw new Error("PRIVATE_PROVIDER_DIAGNOSTIC");
      return { data: version, error: { message: "PRIVATE_PROVIDER_DIAGNOSTIC" } };
    });
    const client = { from: () => ({ select: () => ({ limit: async () => ({ data: [], error: null }) }) }), rpc };
    const result = await checkSupabaseRealitySchema(client);
    expect(result).toMatchObject({ serverOwnedReadsVersion: null,
      serverOwnedReadsProbeError: "Server-owned operational-read security probe is unavailable." });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_PROVIDER_DIAGNOSTIC");
  });

  it("does not attest read security without a database client", async () => {
    expect(await checkSupabaseRealitySchema(null)).toMatchObject({ serverOwnedReadsVersion: null,
      serverOwnedReadsProbeError: "Server-owned operational-read security probe is unavailable." });
  });
});
