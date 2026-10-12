import { describe, expect, it, vi } from "vitest";
import { checkSupabaseRealitySchema } from "./fireafter-supabase";
import { SERVER_OWNED_WRITE_SECURITY_VERSION } from "./operational-write-security";

vi.mock("./supabase", () => ({ getSupabaseAdminClient: vi.fn(), getSupabaseServerClient: vi.fn() }));

describe("FA09 schema gate (test transport, not database execution)", () => {
  it.each(["20260914070900", "20260904053500", null, "wrong", { version: "20260914070900" }])(
    "accepts only the new exact write version: %j", async data => {
      const rpc = vi.fn(async () => ({ data, error: null }));
      const client = { from: () => ({ select: () => ({ limit: async () => ({ data: [], error: null }) }) }), rpc };
      const result = await checkSupabaseRealitySchema(client);
      expect(SERVER_OWNED_WRITE_SECURITY_VERSION).toBe("20260914070900");
      expect(rpc).toHaveBeenCalledWith("fireafter_server_owned_write_security_version");
      expect(result.serverOwnedWritesVersion).toBe(data === "20260914070900" ? data : null);
      expect(result.serverOwnedWritesProbeError).toBeNull();
    },
  );
  it.each([false, true])("keeps provider failure safe with thrown=%s", async thrown => {
    const rpc = vi.fn(async () => {
      if (thrown) throw new Error("FA09_PRIVATE_PROVIDER_MARKER");
      return { data: "20260914070900", error: { message: "FA09_PRIVATE_PROVIDER_MARKER" } };
    });
    const client = { from: () => ({ select: () => ({ limit: async () => ({ data: [], error: null }) }) }), rpc };
    const result = await checkSupabaseRealitySchema(client);
    expect(result.serverOwnedWritesVersion).toBeNull();
    expect(result.serverOwnedWritesProbeError).toBe("Server-owned operational-write security probe is unavailable.");
    expect(JSON.stringify(result)).not.toContain("FA09_PRIVATE_PROVIDER_MARKER");
  });
});
