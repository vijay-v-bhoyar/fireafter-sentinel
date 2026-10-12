import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Incident, Recommendation } from "@/lib/types";

const getDashboardBundleMock = vi.fn();

vi.mock("@/lib/fireafter-data", () => ({
  getDashboardBundle: getDashboardBundleMock,
}));

vi.mock("@/lib/error-message", () => ({
  errorMessage: (error: unknown, fallback: string) =>
    error instanceof Error && error.message ? error.message : fallback,
}));

describe("GET /api/export/geojson", () => {
  beforeEach(() => {
    getDashboardBundleMock.mockReset();
  });

  it("exports a queue without source evidence as unassessed rather than a current low-risk action", async () => {
    getDashboardBundleMock.mockResolvedValue({
      incident: incident(),
      locations: [],
      assets: [],
      sourceSnapshots: [],
      recommendations: [recommendation()],
      actions: [],
      auditEvents: [],
      currentUser: null,
    });

    const { GET } = await import("./route");
    const response = await GET(
      new Request("http://localhost/api/export/geojson?incidentId=incident-utah-county-ut"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/geo+json");
    expect(response.headers.get("content-disposition")).toContain(
      "fireafter-utah-county-ut-action-queue.geojson",
    );
    expect(body).toMatchObject({
      type: "FeatureCollection",
      fireafter: {
        incidentId: "incident-utah-county-ut",
        decisionSupport: true,
      },
      features: [
        {
          type: "Feature",
          geometry: {
            type: "Point",
            coordinates: [-111.4518, 40.0599],
          },
          properties: {
            assetName: "Diamond Fork culvert Utah County GIS OBJECTID 4",
            recommendedAction:
              "Review missing or uncertain evidence with a qualified responder before using this ranking. Unknown does not mean low hazard.",
            riskLevel: "Unknown",
            score100: 28,
          },
        },
      ],
    });
  });

  it("redacts critical-facility identifiers and precise coordinates in public exports", async () => {
    const privateAssetId = "hospital-40.1234--111.111";
    const privateFeatureId = "tnm-hospital-OBJECTID-991";
    const privateRecommendation = {
      ...recommendation(),
      id: `recommendation-${privateAssetId}`,
      assetId: privateAssetId,
      assetName: "Utah Valley Medical Center",
      assetType: "Critical Facility" as const,
      locationLabel: "1034 North 500 West",
      coordinates: [-111.111, 40.1234] as [number, number],
      evidence: [{
        sourceKey: "tnm-structures",
        sourceName: "USGS TNM Structures",
        sourceFeatureId: privateFeatureId,
        summary: "Utah Valley Medical Center facility record",
      }],
      sourceSnapshotIds: [`tnm-structures:${privateFeatureId}`],
    };
    const locationContext = {
      id: "utah-county-ut",
      county: "Utah County",
      state: "UT",
      label: "Utah County, UT",
      centroid: [-111.8, 40.2] as [number, number],
      fips: "49049",
      fireWeatherZone: "UTZ005",
      population: 0,
      wildfireContext: "Live Census TIGERweb county geometry.",
    } satisfies NonNullable<Incident["locationContext"]>;

    getDashboardBundleMock.mockResolvedValue({
      incident: { ...incident(), locationContext },
      locations: [],
      assets: [],
      sourceSnapshots: [],
      recommendations: [privateRecommendation],
      actions: [],
      auditEvents: [],
      currentUser: null,
      sensitiveInfrastructureAccess: false,
    });

    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/export/geojson"));
    const body = await response.json();
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(serialized).not.toContain(privateAssetId);
    expect(serialized).not.toContain(privateFeatureId);
    expect(serialized).not.toContain("Utah Valley Medical Center");
    expect(serialized).not.toContain("1034 North 500 West");
    expect(serialized).not.toContain("-111.111");
    expect(body.features[0]).toMatchObject({
      geometry: { coordinates: [-111.8, 40.2] },
      properties: {
        assetId: expect.stringMatching(/^asset-redacted-v2-[0-9a-f]{32}$/),
        assetName: "Critical facility response context",
        locationLabel: "Utah County response area",
        sourceSnapshotIds: [],
      },
    });
  });

  it("preserves sensitive facility details for an authorized response bundle", async () => {
    const privateRecommendation = {
      ...recommendation(),
      id: "rec-authorized-hospital",
      assetId: "hospital-private-point-id",
      assetName: "Authorized Medical Center",
      assetType: "Critical Facility" as const,
      locationLabel: "Restricted address",
      coordinates: [-111.111, 40.1234] as [number, number],
    };
    getDashboardBundleMock.mockResolvedValue({
      incident: incident(),
      locations: [],
      assets: [],
      sourceSnapshots: [],
      recommendations: [privateRecommendation],
      actions: [],
      auditEvents: [],
      currentUser: { id: "responder-1", email: "responder@example.com", organizationId: "org-1", role: "incident_commander" },
      sensitiveInfrastructureAccess: true,
    });

    const { GET } = await import("./route");
    const body = await (await GET(new Request("http://localhost/api/export/geojson"))).json();

    expect(body.features[0]).toMatchObject({
      geometry: { coordinates: [-111.111, 40.1234] },
      properties: {
        id: "rec-authorized-hospital",
        assetId: "hospital-private-point-id",
        assetName: "Authorized Medical Center",
        locationLabel: "Restricted address",
      },
    });
  });

  it("returns structured JSON when export generation fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    getDashboardBundleMock.mockRejectedValueOnce(new Error("Supabase unavailable"));

    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/export/geojson"));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: "GeoJSON export unavailable" });
    expect(consoleError).toHaveBeenCalledWith(
      "[fireafter] GeoJSON export unavailable",
      "Supabase unavailable",
    );
    consoleError.mockRestore();
  });
});

function incident(): Incident {
  return {
    id: "incident-utah-county-ut",
    locationId: "utah-county-ut",
    county: "Utah County",
    state: "UT",
    title: "Utah Fire",
    code: "UT-FA-49049-001",
    status: "Storm Watch",
    stormWindow: "Next 48-72 hrs",
    rainfallForecast: "No measurable rainfall in NWS grid",
    lastRefresh: "10:16 PM UTC",
    dataFreshness: "Low",
    activeAlerts: 4,
    selectedFire: {
      name: "Cherry",
      acres: 34252,
      perimeterUpdated: "2026-07-08T10:16:00.000Z",
      source: "NIFC WFIGS",
    },
  };
}

function recommendation(): Recommendation {
  return {
    id: "rec-upload-1",
    incidentId: "incident-utah-county-ut",
    assetId: "asset-upload-1",
    assetName: "Diamond Fork culvert Utah County GIS OBJECTID 4",
    assetType: "Culvert",
    locationLabel: "Diamond Fork",
    coordinates: [-111.4518, 40.0599],
    recommendedAction: "Monitor culvert and review if rainfall forecast increases.",
    finalScore: 0.276,
    score100: 28,
    riskLevel: "Low",
    confidenceLevel: "Medium",
    reasonCodes: ["High Burn Severity"],
    limitations: ["Some signals are derived from mixed public sources."],
    changedSinceLastRefresh: "Local Asset Recalculated",
    sourcesUpdatedLabel: "Just now",
    dataFreshnessHours: 0.69,
    scoreBreakdown: {
      rainfallThreat: 0,
      burnSeverity: 1,
      slopeTerrain: 1,
      downstreamExposure: 0.15,
      dataFreshness: 0.72,
      confidenceMultiplier: 0.85,
      baseScore: 0.32,
      finalScore: 0.276,
    },
    evidence: [
      {
        sourceKey: "local-upload",
        sourceName: "County upload",
        summary: "County/local uploaded asset record.",
      },
    ],
    sourceSnapshotIds: ["nws", "wfigs"],
    createdAt: "2026-07-08T22:00:00.000Z",
  };
}
