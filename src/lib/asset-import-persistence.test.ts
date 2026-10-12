import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { operationId, databaseIncidentId, importReceipt, importOperation } from "../test/import-operation-fixture";
import { createIncident, getIncidentBundle } from "./fireafter-store";

const principal = { kind: "user" as const, actorId: "10000000-0000-4000-8000-000000000001", organizationId: "20000000-0000-4000-8000-000000000002" };
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), read: vi.fn(), persistImport: vi.fn(), refresh: vi.fn(), persistBundle: vi.fn(), authorize: vi.fn() }));
vi.mock("./import-operation-server", () => ({ lookupImportOperation: mocks.lookup }));
vi.mock("./auth", () => ({ getCurrentUser: vi.fn(async () => null), requireIncidentAccess: mocks.authorize, AuthError: class extends Error { status = 403; } }));
vi.mock("./fireafter-supabase", () => ({ getSupabaseIncidentBundle: mocks.read, getSupabaseIncidentBundleByDatabaseId: mocks.read, persistImportedAssetsToSupabase: mocks.persistImport,
  persistBundleToSupabase: mocks.persistBundle, getIncidentAuthorizationContext: vi.fn(async () => null), recordSupabaseAction: vi.fn() }));
vi.mock("./live-sources", () => ({ runLiveSourceRefresh: mocks.refresh, searchLocationsLive: vi.fn(), resolveWfigsFireCandidate: vi.fn() }));
import { importIncidentAssets } from "./fireafter-data";
import { POST } from "../app/api/assets/import/route";
import { fetchOperationResponse } from "./refresh-operation";
import { createResponseBudget } from "./bounded-response";

describe("FA12-C3 real parser through API and production facade with test-only persistence", () => {
  const incident = createIncident("ventura-ca");
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    vi.clearAllMocks();
    mocks.lookup.mockResolvedValue({ context: { databaseIncidentId, organizationId: principal.organizationId }, requestHash: importOperation.requestHash, receipt: null });
    mocks.read.mockResolvedValue({ ...structuredClone(getIncidentBundle(incident.id)), persistence: { databaseIncidentId, organizationId: principal.organizationId, expectedRevision: null } });
    mocks.authorize.mockResolvedValue({ id: principal.actorId, email: "operator@example.com", organizationId: principal.organizationId });
    mocks.persistImport.mockImplementation(async input => ({ ...input, receipt: importReceipt, replayed: false }));
    mocks.refresh.mockImplementation(async (input) => ({ ...input, recommendations: [], sourceSnapshots: [] }));
    mocks.persistBundle.mockImplementation(async (bundle) => bundle);
  });
  afterEach(() => vi.unstubAllEnvs());
  const request = (content: string) => new Request("http://localhost/api/assets/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operationId, incidentId: incident.id, fileName: "assets.csv", content }) });

  it("rejects invalid operation policy before real facade lookup or persistence", async () => {
    vi.stubEnv("FIREAFTER_REFRESH_MAX_REQUESTS", "invalid");
    const response = await POST(request("name,lat,lon\nSaved,34.4,-119.2"));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "refresh_config" });
    expect(mocks.lookup).not.toHaveBeenCalled();
    expect(mocks.persistImport).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it.each(["bytes", "caller cancellation"])("retains validated import evidence on refresh %s", async mode => {
    vi.stubEnv("FIREAFTER_REFRESH_MAX_BYTES", "1024");
    const controller = new AbortController();
    const transport = vi.fn(async () => new Response("x".repeat(2048)));
    mocks.refresh.mockImplementation(async () => {
      if (mode === "caller cancellation") controller.abort();
      await fetchOperationResponse("https://test.invalid/refresh", undefined, createResponseBudget(4096, 5000), transport);
    });
    const input = new Request(request("name,lat,lon\nSaved,34.4,-119.2"), { signal: controller.signal });
    const response = await POST(input);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.importOutcome).toEqual({ state: "persisted", refresh: "unconfirmed", auditEventId: body.auditEvent.id });
    expect(body.operationId).toBe(operationId); expect(body.bundle).toBeNull();
    expect(mocks.persistImport).toHaveBeenCalledTimes(1);
    expect(mocks.persistBundle).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledTimes(mode === "bytes" ? 1 : 0);
  });

  it("does not checkpoint an invalid commit receipt", async () => {
    mocks.persistImport.mockImplementation(async input => ({ ...input, receipt: { ...importReceipt, revision: "invalid" }, replayed: false }));
    const response = await POST(request("name,lat,lon\nSaved,34.4,-119.2"));
    expect(response.ok).toBe(false);
    expect((await response.json()).importOutcome).toBeUndefined();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it.each(["requests", "deadline"])("keeps a validated committed import when follow-up refresh exhausts %s", async mode => {
    vi.stubEnv("FIREAFTER_REFRESH_MAX_REQUESTS", "1");
    vi.stubEnv("FIREAFTER_REFRESH_TIMEOUT_MS", mode === "deadline" ? "250" : "5000");
    const transport = vi.fn(async () => new Response("ok"));
    mocks.refresh.mockImplementation(async () => {
      if (mode === "deadline") await new Promise(resolve => setTimeout(resolve, 350));
      for (let i = 0; i < 2; i++) await fetchOperationResponse("https://test.invalid/refresh", undefined, createResponseBudget(1024, 5000), transport);
      throw new Error("Refresh must stop before this point");
    });
    const response = await POST(request("name,lat,lon\nSaved,34.4,-119.2"));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.importOutcome).toEqual({ state: "persisted", refresh: "unconfirmed", auditEventId: body.auditEvent.id });
    expect(body.operationId).toBe(operationId);
    expect(body.bundle).toBeNull();
    expect(mocks.persistImport).toHaveBeenCalledTimes(1);
    expect(mocks.persistBundle).not.toHaveBeenCalled();
    if (mode === "deadline") await new Promise(resolve => setTimeout(resolve, 150));
    expect(transport).toHaveBeenCalledTimes(mode === "deadline" ? 0 : 1);
  });

  it("does not persist, refresh, append audit, or modify fixture state for rejected input", async () => {
    const before = structuredClone(getIncidentBundle(incident.id));
    const response = await POST(request("name,lat,lon\nA,invalid,-119.2"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ assets: [], auditEvent: null, bundle: null, importErrors: [expect.any(String)] });
    expect(mocks.persistImport).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.persistBundle).not.toHaveBeenCalled();
    expect(getIncidentBundle(incident.id)).toEqual(before);
  });

  it("persists only valid parsed rows with the authorized actor and unverified confidence", async () => {
    const before = structuredClone(getIncidentBundle(incident.id));
    const response = await POST(request('name,lat,lon\n"A, north",34.4,-119.2\nBad,invalid,-119.3'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.assets).toHaveLength(1);
    expect(body.assets[0]).toMatchObject({ name: "A, north", confidence: "Low", geometry: { type: "Point", coordinates: [-119.2, 34.4] } });
    expect(body.importErrors).toHaveLength(1);
    expect(body.importOutcome).toEqual({ state: "persisted", refresh: "completed", auditEventId: body.auditEvent.id });
    expect(body.bundle).not.toBeNull();
    expect(mocks.persistImport).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ actorOrganizationId: principal.organizationId, assets: body.assets, auditEvent: expect.objectContaining({ actorName: "operator@example.com" }) }));
    expect(getIncidentBundle(incident.id)).toEqual(before);
  });

  it("FA10-I1 carries the first read context unchanged through import preparation", async () => {
    const persistence = { organizationId: principal.organizationId, databaseIncidentId: "90000000-0000-4000-8000-000000000009", expectedRevision: "30000000-0000-4000-8000-000000000003" };
    mocks.read.mockResolvedValue({ ...structuredClone(getIncidentBundle(incident.id)), persistence });
    await importIncidentAssets({ operationId, principal, incidentId: incident.id, fileName: "assets.csv", content: "name,lat,lon\nA,34.4,-119.2" });
    expect(mocks.persistImport.mock.calls[0][0].persistence).toEqual(persistence);
  });

  it("rejects a different canonical incident before preparation or dispatch", async () => {
    mocks.read.mockResolvedValue({ ...structuredClone(getIncidentBundle(incident.id)), persistence: {
      organizationId: principal.organizationId, databaseIncidentId: principal.organizationId,
      expectedRevision: importReceipt.revision,
    } });
    await expect(importIncidentAssets({ operationId, principal, incidentId: incident.id, fileName: "assets.csv", content: "name,lat,lon\nA,34.4,-119.2" })).rejects.toMatchObject({ code: "FB409" });
    expect(mocks.persistImport).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("returns only the authoritative receipt on a late database replay, without refreshing again", async () => {
    mocks.persistImport.mockImplementation(async input => ({ ...input, receipt: importReceipt, replayed: true }));
    const result = await importIncidentAssets({ operationId, principal, incidentId: incident.id, fileName: "assets.csv", content: "name,lat,lon\nA,34.4,-119.2" });
    expect(result).toEqual({ operationId, recovered: true, receipt: importReceipt, assets: [], auditEvent: null, importErrors: [], bundle: null });
    expect(mocks.read).toHaveBeenCalledExactlyOnceWith(databaseIncidentId);
    expect(mocks.persistImport).toHaveBeenCalledOnce();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("FA10-I2 canonicalizes an authorized UUID alias before parsing an import", async () => {
    await expect(importIncidentAssets({ operationId, principal, incidentId: "90000000-0000-4000-8000-000000000009", fileName: "assets.csv", content: "name,lat,lon\nA,34.4,-119.2" })).resolves.toMatchObject({ assets: [expect.objectContaining({ incidentId: incident.id })] });
  });

  it("keeps persistence failure visible without falling back to memory", async () => {
    const before = structuredClone(getIncidentBundle(incident.id));
    mocks.persistImport.mockRejectedValue(new Error("test persistence unavailable"));
    await expect(importIncidentAssets({ operationId, principal, incidentId: incident.id, fileName: "assets.csv", content: "name,lat,lon\nA,34.4,-119.2" })).rejects.toThrow("test persistence unavailable");
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(getIncidentBundle(incident.id)).toEqual(before);
  });

  it("FA10-O1 reports a confirmed import separately from an unconfirmed refresh", async () => {
    mocks.refresh.mockRejectedValue(new Error("PRIVATE_REFRESH_PROVIDER_DIAGNOSTIC"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await POST(request("name,lat,lon\nSaved,34.4,-119.2\nRejected,invalid,-119.3"));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = await response.json();
      expect(body.assets).toHaveLength(1);
      expect(body.importErrors).toHaveLength(1);
      expect(body.bundle).toBeNull();
      expect(body.importOutcome).toEqual({ state: "persisted", refresh: "unconfirmed", auditEventId: body.auditEvent.id });
      expect(mocks.persistImport).toHaveBeenCalledTimes(1);
      expect(mocks.persistBundle).not.toHaveBeenCalled();
      expect(JSON.stringify(body)).not.toContain("PRIVATE_REFRESH_PROVIDER_DIAGNOSTIC");
      expect(JSON.stringify([warn.mock.calls, error.mock.calls])).not.toContain("PRIVATE_REFRESH_PROVIDER_DIAGNOSTIC");
    } finally { warn.mockRestore(); error.mockRestore(); }
  });

  it("FA10-O1 does not refresh or claim persistence after an empty acknowledgement", async () => {
    mocks.persistImport.mockResolvedValue(null);
    const response = await POST(request("name,lat,lon\nSaved,34.4,-119.2"));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "FB503" });
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("FA10-O1 preserves import confirmation when the separate refresh write loses its acknowledgement", async () => {
    mocks.persistBundle.mockRejectedValue(new Error("PRIVATE_REFRESH_WRITE_UNCERTAIN"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const response = await POST(request("name,lat,lon\nSaved,34.4,-119.2"));
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.importOutcome).toEqual({ state: "persisted", refresh: "unconfirmed", auditEventId: body.auditEvent.id });
      expect(body.bundle).toBeNull();
      expect(mocks.persistImport).toHaveBeenCalledTimes(1);
      expect(mocks.refresh).toHaveBeenCalledTimes(1);
      expect(mocks.persistBundle).toHaveBeenCalledTimes(1);
      expect(JSON.stringify([body, warn.mock.calls])).not.toContain("PRIVATE_REFRESH_WRITE_UNCERTAIN");
    } finally { warn.mockRestore(); }
  });
});
