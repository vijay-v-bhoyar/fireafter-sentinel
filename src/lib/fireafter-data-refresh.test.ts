import { beforeEach, describe, expect, it, vi } from "vitest";
import { InventoryCapacityError } from "./inventory-error";
import type { AuditEvent, Incident, Recommendation, SourceSnapshot } from "./types";

const principal = { kind: "user" as const, actorId: "10000000-0000-4000-8000-000000000001", organizationId: "20000000-0000-4000-8000-000000000002" };
const persistence = { organizationId: principal.organizationId, expectedRevision: "30000000-0000-4000-8000-000000000003" };
const getSupabaseIncidentBundleMock = vi.fn();
const persistBundleToSupabaseMock = vi.fn();
const runLiveSourceRefreshMock = vi.fn();
const resolveWfigsFireCandidateMock = vi.fn();

vi.mock("./auth", () => ({
  getCurrentUser: vi.fn(async () => null),
}));

vi.mock("./fireafter-store", () => ({
  createIncidentFromLocation: vi.fn(),
  getIncidentBundle: vi.fn(),
  importAssets: vi.fn(),
  recordAction: vi.fn(),
  refreshIncident: vi.fn(),
  searchLocations: vi.fn(() => []),
}));

vi.mock("./fireafter-supabase", () => ({
  getSupabaseIncidentBundle: getSupabaseIncidentBundleMock,
  persistBundleToSupabase: persistBundleToSupabaseMock,
  persistImportedAssetsToSupabase: vi.fn(),
  recordSupabaseAction: vi.fn(),
}));

vi.mock("./live-sources", () => ({
  resolveWfigsFireCandidate: resolveWfigsFireCandidateMock,
  runLiveSourceRefresh: runLiveSourceRefreshMock,
  searchLocationsLive: vi.fn(),
}));

describe("refreshIncidentBundle persistence", () => {
  it("does not commit a partial refresh when inventory processing fails", async () => {
    getSupabaseIncidentBundleMock.mockResolvedValue({ persistence, incident: incidentFixture(), assets: [], recommendations: [], sourceSnapshots: [], actions: [], auditEvents: [] });
    runLiveSourceRefreshMock.mockRejectedValueOnce(new InventoryCapacityError("inference_work"));
    const { refreshIncidentBundle } = await import("./fireafter-data");
    await expect(refreshIncidentBundle("incident-ventura-ca", principal)).rejects.toMatchObject({ code: "inference_work" });
    expect(persistBundleToSupabaseMock).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    getSupabaseIncidentBundleMock.mockReset();
    persistBundleToSupabaseMock.mockReset();
    runLiveSourceRefreshMock.mockReset();
    resolveWfigsFireCandidateMock.mockReset();
  });

  it("persists only the new refresh audit event instead of replaying old audit history", async () => {
    const incident = incidentFixture();
    const oldAuditEvent: AuditEvent = {
      id: "audit-old-action",
      incidentId: incident.id,
      recommendationId: "rec-old",
      eventType: "RecommendationModified",
      actorName: "commander@example.com",
      createdAt: "2026-06-27T14:24:00.000Z",
      summary: "Old action audit event.",
      payload: {
        action: "modify",
        recommendationSnapshot: { id: "rec-old" },
      },
    };
    const oldRecommendation = recommendationFixture({
      id: "rec-old",
      incidentId: incident.id,
    });
    const refreshedRecommendation = recommendationFixture({
      id: "rec-new",
      incidentId: incident.id,
    });
    const sourceSnapshot = sourceSnapshotFixture(incident.id);

    getSupabaseIncidentBundleMock.mockResolvedValue({
      persistence,
      incident,
      locations: [],
      assets: [],
      sourceSnapshots: [sourceSnapshot],
      recommendations: [oldRecommendation],
      actions: [
        {
          id: "action-old",
          recommendationId: oldRecommendation.id,
          action: "modify",
          note: "Old action.",
          actorName: "commander@example.com",
          createdAt: "2026-06-27T14:24:00.000Z",
          recommendationSnapshot: oldRecommendation,
          auditEvent: oldAuditEvent,
        },
      ],
      auditEvents: [oldAuditEvent],
      currentUser: null,
    });
    runLiveSourceRefreshMock.mockResolvedValue({
      incident,
      assets: [],
      sourceSnapshots: [sourceSnapshot],
      recommendations: [refreshedRecommendation],
    });
    persistBundleToSupabaseMock.mockResolvedValue(null);

    const { refreshIncidentBundle } = await import("./fireafter-data");
    const result = await refreshIncidentBundle(incident.id, principal);

    expect(persistBundleToSupabaseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        auditEvents: expect.arrayContaining([
          expect.objectContaining({ id: oldAuditEvent.id }),
          expect.objectContaining({ eventType: "SourcesRefreshed" }),
        ]),
      }),
      expect.objectContaining({
        actions: [],
        auditEvents: [
          expect.objectContaining({
            eventType: "SourcesRefreshed",
            incidentId: incident.id,
          }),
        ],
      }),
    );
    expect(result.auditEvents.map((event) => event.eventType)).toEqual([
      "SourcesRefreshed",
    ]);
  });

  it("persists an explicitly selected WFIGS context and its refresh audit event", async () => {
    const incident = incidentFixture();
    const selectedFire = {
      name: "Validated Canyon Fire",
      acres: 1400,
      perimeterUpdated: "06/27/2026, 10:00 AM",
      source: "NIFC WFIGS Year-to-Date Fire Perimeters",
      sourceKey: "wfigs-ytd",
      sourceUrl: "https://example.test/wfigs-ytd",
      sourceFeatureId: "fc-validated",
      coverageStatus: "available" as const,
    };
    const base = {
      persistence,
      incident,
      locations: [],
      assets: [],
      sourceSnapshots: [],
      recommendations: [],
      actions: [],
      auditEvents: [],
      currentUser: null,
    };
    getSupabaseIncidentBundleMock.mockResolvedValue(base);
    resolveWfigsFireCandidateMock.mockResolvedValue(selectedFire);
    runLiveSourceRefreshMock.mockResolvedValue({
      incident: { ...incident, selectedFire },
      assets: [],
      sourceSnapshots: [],
      recommendations: [],
    });
    persistBundleToSupabaseMock.mockResolvedValue(null);

    const { selectIncidentFireBundle } = await import("./fireafter-data");
    const result = await selectIncidentFireBundle({
      principal,
      incidentId: incident.id,
      sourceKey: "wfigs-ytd",
      sourceFeatureId: "fc-validated",
      actorId: "user-1",
      actorName: "commander@example.com",
    });

    expect(resolveWfigsFireCandidateMock).toHaveBeenCalledWith(
      incident.locationContext,
      incident,
      { sourceKey: "wfigs-ytd", sourceFeatureId: "fc-validated" },
    );
    expect(runLiveSourceRefreshMock).toHaveBeenCalledWith(
      expect.objectContaining({
        incident: expect.objectContaining({ selectedFire }),
        fireContextSnapshots: base.sourceSnapshots,
      }),
    );
    expect(persistBundleToSupabaseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        auditEvents: [expect.objectContaining({ eventType: "FireContextSelected" })],
      }),
      expect.objectContaining({
        actions: [],
        auditEvents: [expect.objectContaining({ eventType: "FireContextSelected" })],
      }),
    );
    const persistedBundle = persistBundleToSupabaseMock.mock.calls[0][0];
    expect(persistedBundle.auditEvents[0]).toMatchObject({
      eventType: "FireContextSelected",
      actorName: "commander@example.com",
      payload: expect.objectContaining({
        actorId: "user-1",
        sourceFeatureId: "fc-validated",
      }),
    });
    expect(result.auditEvents[0].eventType).toBe("FireContextSelected");
  });
});

function incidentFixture(): Incident {
  return {
    id: "incident-utah-county-ut",
    title: "Utah Fire",
    county: "Utah County",
    state: "UT",
    code: "UT-FA-49049-001",
    locationId: "utah-county-ut",
    status: "Stale Data",
    stormWindow: "Next 48-72 hrs",
    rainfallForecast: "No measurable rainfall in NWS grid",
    lastRefresh: "11:41 PM EDT",
    dataFreshness: "Low",
    activeAlerts: 2,
    selectedFire: {
      name: "Cherry",
      acres: 34224,
      perimeterUpdated: "Just now",
      source: "NIFC WFIGS",
    },
    locationContext: {
      id: "utah-county-ut",
      county: "Utah County",
      state: "UT",
      label: "Utah County, UT",
      fips: "49049",
      centroid: [-111.7, 40.1],
      bbox: [-112.2, 39.8, -111.2, 40.5],
      fireWeatherZone: "UTZ111",
      population: 684986,
      wildfireContext: "Live county context",
    },
  };
}

function recommendationFixture(overrides: Partial<Recommendation> = {}): Recommendation {
  return {
    id: "rec-old",
    incidentId: "incident-utah-county-ut",
    assetId: "asset-1",
    assetName: "E 800 N @ Hydro Connector",
    assetType: "Inferred Crossing",
    locationLabel: "Hydro Connector",
    coordinates: [-111.72, 40.1],
    recommendedAction: "Monitor inferred crossing and review if rainfall forecast increases.",
    finalScore: 0.15,
    score100: 15,
    riskLevel: "Very Low",
    confidenceLevel: "Low",
    reasonCodes: ["High Burn Severity"],
    limitations: ["Verified culvert inventory is unavailable."],
    changedSinceLastRefresh: "Source-Backed Candidate",
    sourcesUpdatedLabel: "Just now",
    dataFreshnessHours: 1,
    scoreBreakdown: {
      rainfallThreat: 0,
      burnSeverity: 0.5,
      slopeTerrain: 0.4,
      downstreamExposure: 0.3,
      dataFreshness: 0.9,
      confidenceMultiplier: 0.31,
      baseScore: 0.2,
      finalScore: 0.15,
    },
    evidence: [
      {
        sourceKey: "3dhp-flowlines",
        sourceName: "USGS 3DHP",
        summary: "Flowline candidate supports inferred crossing.",
      },
    ],
    sourceSnapshotIds: ["source-1"],
    createdAt: "2026-06-27T14:24:00.000Z",
    ...overrides,
  };
}

function sourceSnapshotFixture(incidentId: string): SourceSnapshot {
  return {
    id: "source-1",
    incidentId,
    sourceName: "NIFC WFIGS Year-to-Date Fire Perimeters",
    sourceKey: "wfigs-ytd",
    sourceUrl:
      "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters_YearToDate/FeatureServer/0/query",
    fetchedAt: "2026-06-29T04:48:00.000Z",
    sourceUpdatedAt: "2026-06-29T04:48:00.000Z",
    status: "online",
    stale: false,
    freshnessLabel: "Just now",
    coverageStatus: "available",
    detail: "1 feature",
    rawPayload: { featureCount: 1 },
    derivedSignals: {},
  };
}
