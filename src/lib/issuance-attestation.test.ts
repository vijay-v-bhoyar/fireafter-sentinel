import { describe, expect, it, vi } from "vitest";
import { checkSupabaseRealitySchema } from "./fireafter-supabase";
import { OPERATOR_ACCOUNT_ISSUANCE_AUDIT_SECURITY_VERSION } from "./operational-write-security";

vi.mock("./supabase", () => ({ getSupabaseAdminClient: vi.fn(), getSupabaseServerClient: vi.fn() }));
const version = "20260915130000";

describe("FA20 issuance attestation: application contract, not executed SQL", () => {
  it("requires the forward catalog and coordinator proof", () => {
    expect(OPERATOR_ACCOUNT_ISSUANCE_AUDIT_SECURITY_VERSION).toBe(version);
  });
  it.each(["20260910173914", version, null, 123, {}, "unrecognized"])("only accepts exact current proof: %j", async data => {
    const client = { from: () => ({ select: () => ({ limit: async () => ({ data: [], error: null }) }) }),
      rpc: vi.fn(async () => ({ data, error: null })) };
    const result = await checkSupabaseRealitySchema(client);
    expect(result.operatorAccountIssuanceAuditVersion).toBe(data === version ? version : null);
  });
  it.each(["returned", "thrown"])("redacts %s provider failure", async mode => {
    const client = { from: () => ({ select: () => ({ limit: async () => ({ data: [], error: null }) }) }),
      rpc: vi.fn(async () => {
        if (mode === "thrown") throw new Error("PRIVATE_ISSUANCE_DIAGNOSTIC");
        return { data: version, error: { message: "PRIVATE_ISSUANCE_DIAGNOSTIC" } };
      }) };
    const result = await checkSupabaseRealitySchema(client);
    expect(result.operatorAccountIssuanceAuditVersion).toBeNull();
    expect(JSON.stringify(result)).not.toContain("PRIVATE_ISSUANCE_DIAGNOSTIC");
  });
});
