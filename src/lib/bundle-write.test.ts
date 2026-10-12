import { importOperation } from "../test/import-operation-fixture";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { bundleWrite, bundleWriteFailure, validateBundleWrite } from "./bundle-write";
import { toClientDashboardBundle } from "./fireafter-data";
import { getIncidentBundle } from "./fireafter-store";
import { persistBundleToSupabase } from "./fireafter-supabase";
import { getSupabaseAdminClient } from "./supabase";

vi.mock("./supabase", () => ({ getSupabaseAdminClient: vi.fn(), getSupabaseServerClient: vi.fn() }));
const actorId = "10000000-0000-4000-8000-000000000001";
const organizationId = "20000000-0000-4000-8000-000000000002";
const expectedRevision = "30000000-0000-4000-8000-000000000003";
const principal = { kind: "user" as const, actorId, organizationId };
const persistence = { organizationId, expectedRevision };

describe("FA10 bundle write validation and serialization", () => {
  it.each(["asset", "recommendation", "source"])("FA10-I2 rejects reserved own identity keys before parsing: %s", (kind) => {
    const rowIds = { asset: {}, recommendation: {}, source: {}, [kind]: Object.fromEntries([["__proto__", actorId]]) };
    expect(() => validateBundleWrite({ ...persistence, actorId, operation: "import", importOperation, rowIds })).toThrow();
  });
  it("FA10-I2 permits bounded server row identity maps only for existing writes", () => {
    const context = { ...persistence, databaseIncidentId: actorId, rowIds: { asset: { legacy: actorId }, recommendation: {}, source: {} } };
    expect(bundleWrite(principal, context, "import", importOperation).rowIds).toEqual(context.rowIds);
    expect(() => bundleWrite(principal, { ...context, expectedRevision: null }, "create")).toThrow();
  });
  it.each([
    { asset: { legacy: "invalid" }, recommendation: {}, source: {} },
    { asset: { first: actorId, second: actorId }, recommendation: {}, source: {} },
    { asset: {}, recommendation: {}, source: {}, unrelated: {} },
  ])("FA10-I2 rejects invalid or ambiguous row identity maps %#", (rowIds) => {
    expect(() => validateBundleWrite({ ...persistence, actorId, operation: "import", importOperation, rowIds })).toThrow();
  });
  beforeEach(() => vi.clearAllMocks());
  it.each(["refresh", "import", "fire_context"] as const)("binds user %s to the read revision", (operation) => {
    expect(bundleWrite(principal, persistence, operation, operation === "import" ? importOperation : undefined)).toEqual({ ...persistence, actorId, operation, ...(operation === "import" ? { importOperation } : {}) });
  });
  it("distinguishes legacy absence and new creation from a malformed revision", () => {
    expect(bundleWrite(principal, { organizationId, expectedRevision: null }, "create").expectedRevision).toBeNull();
    expect(bundleWrite(principal, { organizationId, expectedRevision: null }, "refresh").expectedRevision).toBeNull();
    expect(() => bundleWrite(principal, persistence, "create")).toThrow();
    expect(() => bundleWrite(principal, { organizationId, expectedRevision: "" }, "refresh")).toThrow();
  });
  it.each([undefined, {}, { actorId, organizationId, operation: "refresh" },
    { actorId: null, organizationId, expectedRevision, operation: "refresh" },
    { actorId, organizationId, expectedRevision, operation: "cron_refresh" },
    { actorId, organizationId, expectedRevision, operation: "refresh", approved: true },
    { actorId, organizationId: "malformed", expectedRevision, operation: "refresh" }])("rejects malformed or implicit authority %#", (input) => {
    expect(() => validateBundleWrite(input)).toThrow();
  });
  it("rejects cross-organization writes and implicit cron authority", () => {
    expect(() => bundleWrite({ ...principal, organizationId: actorId }, persistence, "refresh")).toThrow();
    expect(() => bundleWrite(undefined as never, persistence, "refresh")).toThrow();
    expect(() => bundleWrite(principal, undefined, "refresh")).toThrow();
  });
  it("grants the explicit cron principal only refresh scope", () => {
    expect(bundleWrite({ kind: "cron" }, persistence, "refresh")).toEqual({ ...persistence, actorId: null, operation: "cron_refresh" });
    for (const operation of ["create", "import", "fire_context"] as const) {
      expect(() => bundleWrite({ kind: "cron" }, persistence, operation)).toThrow();
    }
  });
  it("does not serialize server persistence context or mutate its source", () => {
    const input = { ...getIncidentBundle(), persistence };
    expect(toClientDashboardBundle(input)).not.toHaveProperty("persistence");
    expect(input.persistence).toEqual(persistence);
  });
  it.each([new Error("private connection string"), { code: "PGRST202", message: "private URL" }, { code: "toString" }, null])("treats unknown failures as unconfirmed without provider diagnostics %#", (error) => {
    expect(bundleWriteFailure(error)).toMatchObject({ code: "FB503", status: 503 });
    expect(bundleWriteFailure(error).message).not.toMatch(/private|connection string|PGRST/);
  });
  it("stamps canonical authority on audit rows, not caller-supplied metadata", async () => {
    const rpc = vi.fn().mockResolvedValue({ error: { code: "FB409" } });
    vi.mocked(getSupabaseAdminClient).mockReturnValue({ rpc } as never);
    const bundle = getIncidentBundle();
    await persistBundleToSupabase(bundle, { write: bundleWrite(principal, persistence, "refresh"), actions: [], assets: [], auditEvents: [{
      id: "test-event", incidentId: bundle.incident.id, eventType: "SourcesRefreshed", actorName: "Test actor",
      createdAt: "2026-09-14T00:00:00Z", summary: "Test event", payload: { actorId: "spoofed", operation: "create", expectedRevision: "spoofed" },
    }] }).catch(() => undefined);
    expect(rpc.mock.calls[0][1].p_audit_events).toEqual([expect.objectContaining({ actor_id: actorId,
      payload: expect.objectContaining({ actorId, operation: "refresh", expectedRevision }) })]);
  });
  it("missing persistence configuration never returns a pretend successful bundle", async () => {
    vi.mocked(getSupabaseAdminClient).mockReturnValue(null);
    await expect(persistBundleToSupabase(getIncidentBundle(), { write: bundleWrite(principal, persistence, "refresh") })).rejects.toMatchObject({ code: "FB503" });
  });
  it("marks a committed write with failed read-back unconfirmed", async () => {
    const rpc = vi.fn().mockResolvedValue({ error: null });
    vi.mocked(getSupabaseAdminClient).mockReturnValue({ rpc, from() { throw new Error("private read-back failure"); } } as never);
    await expect(persistBundleToSupabase(getIncidentBundle(), { write: bundleWrite(principal, persistence, "refresh") })).rejects.toMatchObject({ code: "FB503", status: 503 });
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
