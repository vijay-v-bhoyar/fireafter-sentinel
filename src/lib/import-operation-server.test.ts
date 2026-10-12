import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ context: vi.fn(), rpc: vi.fn(), client: vi.fn() }));
vi.mock("./fireafter-supabase", () => ({ getIncidentAuthorizationContext: mocks.context }));
vi.mock("./supabase", () => ({ getSupabaseAdminClient: mocks.client }));
import { importRequestHash, lookupImportOperation } from "./import-operation-server";
const operationId = "10000000-0000-4000-8000-000000000001", incidentId = "20000000-0000-4000-8000-000000000002";
const principal = { kind: "user" as const, actorId: "30000000-0000-4000-8000-000000000003", organizationId: "40000000-0000-4000-8000-000000000004" };
const input = { incidentId: "domain-incident", operationId, principal, fileName: "GIS.csv", content: "private content" };
const receipt = { operationId, incidentId, requestHash: importRequestHash(incidentId, input.fileName, input.content), auditEventId: "50000000-0000-4000-8000-000000000005", revision: "60000000-0000-4000-8000-000000000006", assetCount: 2, committedAt: "2026-09-14T09:00:00Z" };
beforeEach(() => { vi.clearAllMocks(); mocks.context.mockResolvedValue({ databaseIncidentId: incidentId, domainIncidentId: input.incidentId, organizationId: principal.organizationId }); mocks.client.mockReturnValue({ rpc: mocks.rpc }); mocks.rpc.mockResolvedValue({ data: receipt, error: null }); });
describe("FA10-R1/R3 receipt server boundary", () => {
  it("uses canonical database identity and authenticated actor only", async () => {
    expect((await lookupImportOperation(input)).receipt).toEqual(receipt);
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("fireafter_read_import_receipt", { p_actor_id: principal.actorId, p_organization_id: principal.organizationId, p_incident_id: incidentId, p_operation_id: operationId });
  });
  it("binds exact filename/content and canonical incident without storing raw content in the request", async () => {
    for (const change of [{ fileName: "other.csv" }, { content: "private content " }]) await expect(lookupImportOperation({ ...input, ...change })).rejects.toMatchObject({ code: "FB408" });
    expect(JSON.stringify(mocks.rpc.mock.calls)).not.toContain(input.content);
    expect(importRequestHash("other", input.fileName, input.content)).not.toBe(receipt.requestHash);
  });
  it("returns a missing receipt only on explicit database null", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    expect((await lookupImportOperation(input)).receipt).toBeNull();
    mocks.rpc.mockResolvedValue({ error: null });
    await expect(lookupImportOperation(input)).rejects.toMatchObject({ code: "FB503" });
  });
  it("denies cross-organization lookup without an RPC", async () => {
    await expect(lookupImportOperation({ ...input, principal: { ...principal, organizationId: incidentId } })).rejects.toMatchObject({ code: "FB401" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each(["FB401", "FB408", "FB503"])("maps database %s without exposing diagnostics", async code => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code, message: "PRIVATE_DATABASE_DIAGNOSTIC" } });
    await expect(lookupImportOperation(input)).rejects.toMatchObject({ code });
  });
  it("fails closed on missing RPC or configuration; no mock fallback", async () => {
    mocks.rpc.mockResolvedValue({ error: { code: "PGRST202", message: "private schema" } });
    await expect(lookupImportOperation(input)).rejects.toMatchObject({ code: "FB503" });
    mocks.client.mockReturnValue(null);
    await expect(lookupImportOperation(input)).rejects.toMatchObject({ code: "FB503" });
  });
});
