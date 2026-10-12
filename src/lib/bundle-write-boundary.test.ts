import { beforeEach, describe, expect, it, vi } from "vitest";
import { getIncidentBundle } from "./fireafter-store";
import { persistBundleToSupabase } from "./fireafter-supabase";
import { getSupabaseAdminClient } from "./supabase";

vi.mock("./supabase", () => ({ getSupabaseAdminClient: vi.fn(), getSupabaseServerClient: vi.fn() }));
const actorId = "10000000-0000-4000-8000-000000000001";
const organizationId = "20000000-0000-4000-8000-000000000002";
const expectedRevision = "30000000-0000-4000-8000-000000000003";

describe("FA10-B1/B2 original bundle boundary regressions", () => {
  const rpc = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    rpc.mockResolvedValue({ error: { code: "FB409", message: "private database diagnostic" } });
    vi.mocked(getSupabaseAdminClient).mockReturnValue({ rpc } as never);
  });

  it("rejects missing write authority instead of invoking persistence", async () => {
    await expect(persistBundleToSupabase(getIncidentBundle(), { assets: [], actions: [], auditEvents: [] }))
      .rejects.toMatchObject({ code: "FB400", status: 400 });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("passes the original authority, organization and revision to the fenced RPC", async () => {
    await persistBundleToSupabase(getIncidentBundle(), {
      assets: [], actions: [], auditEvents: [],
      write: { actorId, organizationId, expectedRevision, operation: "refresh" },
    } as never).catch(() => undefined);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("fireafter_commit_bundle", expect.objectContaining({
      p_actor_id: actorId, p_expected_revision: expectedRevision, p_operation: "refresh",
      p_organization: expect.objectContaining({ id: organizationId }),
      p_incident: expect.objectContaining({ organization_id: organizationId }),
    }));
  });

  it.each([["FB401", 403], ["FB409", 409], ["FB404", 404]])("maps %s without disclosing provider details", async (code, status) => {
    rpc.mockResolvedValue({ error: { code, message: "private database diagnostic" } });
    await expect(persistBundleToSupabase(getIncidentBundle(), {
      assets: [], actions: [], auditEvents: [],
      write: { actorId, organizationId, expectedRevision, operation: "refresh" },
    } as never)).rejects.toMatchObject({ code, status });
  });
});
