import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BundleWriteError } from "./bundle-write";
import { getIncidentBundle } from "./fireafter-store";

const mocks = vi.hoisted(() => ({ read: vi.fn(), persist: vi.fn(), refresh: vi.fn(), search: vi.fn() }));
vi.mock("./auth", () => ({ getCurrentUser: vi.fn(async () => null) }));
vi.mock("./supabase", () => ({ getSupabaseAdminClient: vi.fn(() => null), getSupabaseServerClient: vi.fn(() => null) }));
vi.mock("./fireafter-supabase", async (original) => ({
  ...await original<typeof import("./fireafter-supabase")>(),
  getSupabaseIncidentBundle: mocks.read,
  persistBundleToSupabase: mocks.persist,
}));
vi.mock("./live-sources", async (original) => ({
  ...await original<typeof import("./live-sources")>(),
  searchLocationsLive: mocks.search,
  runLiveSourceRefresh: mocks.refresh,
}));

import { createIncidentBundle } from "./fireafter-data";
import { buildSupabasePayload } from "./fireafter-supabase";

const principal = { kind: "user" as const, actorId: "10000000-0000-4000-8000-000000000001", organizationId: "20000000-0000-4000-8000-000000000002" };
const location = { id: "contract-county", county: "Contract County", state: "CA", fips: "06001", label: "Contract County, CA", centroid: [-122, 38] as [number, number], bbox: [-123, 37, -121, 39] as [number, number, number, number] };

describe("production incident creation bundle contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NODE_ENV", "production");
    mocks.search.mockResolvedValue([location]);
    mocks.read.mockResolvedValue(null);
    mocks.refresh.mockImplementation(async ({ incident }) => ({ incident: { ...incident, lastRefresh: "Just now" }, assets: [], sourceSnapshots: [], recommendations: [], changedSources: [] }));
    mocks.persist.mockImplementation(async (bundle, options) => ({ ...bundle, assets: options.assets, actions: [], auditEvents: options.auditEvents, locations: [location] }));
  });
  afterEach(() => vi.unstubAllEnvs());

  it("sends exactly the create and completed-refresh events, with no historical audit replay", async () => {
    await createIncidentBundle(location.id, principal);
    expect(mocks.persist).toHaveBeenCalledTimes(1);
    const [bundle, options] = mocks.persist.mock.calls[0];
    const wire = JSON.parse(JSON.stringify(buildSupabasePayload(bundle, options)));
    expect(wire.auditEvents.map((event: { event_type: string }) => event.event_type).sort())
      .toEqual(["IncidentCreated", "SourcesRefreshed"]);
    expect(wire.auditEvents.every((event: { recommendation_id: unknown }) => event.recommendation_id === null)).toBe(true);
    expect(options.write).toEqual({ actorId: principal.actorId, organizationId: principal.organizationId, expectedRevision: null, operation: "create" });
    expect(options.actions).toEqual([]);
    expect(wire.responderActions).toEqual([]);
    expect(options.auditEvents.find((event: { eventType: string }) => event.eventType === "SourcesRefreshed").payload)
      .toMatchObject({ sourceSnapshotIds: [], recommendationCount: 0 });
  });

  it("uses this request's refresh result, not mutable process inventory", async () => {
    mocks.refresh.mockImplementationOnce(async ({ incident }) => {
      const memory = getIncidentBundle(incident.id);
      memory.incident.title = "Concurrent process state";
      return { incident: { ...incident, title: "This request evidence" }, assets: [], sourceSnapshots: [], recommendations: [], changedSources: [] };
    });
    await createIncidentBundle(location.id, principal);
    expect(mocks.persist.mock.calls[0][0].incident.title).toBe("This request evidence");
    expect(mocks.refresh).toHaveBeenCalledWith(expect.objectContaining({ assets: [], previousRecommendations: [], previousSourceSnapshots: [] }));
  });

  it("does not persist a successful-create audit when refresh fails", async () => {
    mocks.refresh.mockRejectedValueOnce(new Error("Source acquisition failed"));
    await expect(createIncidentBundle(location.id, principal)).rejects.toThrow("Source acquisition failed");
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it("preserves commit conflict instead of retrying or claiming success", async () => {
    mocks.persist.mockRejectedValueOnce(new BundleWriteError("FB409"));
    await expect(createIncidentBundle(location.id, principal)).rejects.toMatchObject({ code: "FB409", status: 409 });
    expect(mocks.persist).toHaveBeenCalledTimes(1);
  });
});
