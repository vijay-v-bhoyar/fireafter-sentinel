import { describe, expect, it, vi } from "vitest";
import type { Asset, Incident, Recommendation, SourceSnapshot } from "@/lib/types";
import { SOURCE_LINE_GEOMETRY_VERSION, SOURCE_LINE_UNAVAILABLE_WARNING } from "@/lib/source-line-geometry";
import { projectSourceFreshness } from "@/lib/source-freshness";
import { MAP_STREAM_TYPE, MAP_CAPACITY_CODE, MapStreamCollector } from "@/lib/map-stream-contract";

const getDashboardBundleMock = vi.fn();

vi.mock("@/lib/fireafter-data", () => ({
  getDashboardBundle: getDashboardBundleMock,
}));

vi.mock("@/lib/sensitive-infrastructure", async () => {
  return import("../../../../lib/sensitive-infrastructure");
});

describe("GET /api/map/features", () => {
  it.each(["application/json", MAP_STREAM_TYPE])("returns an explicit capacity failure before any successful oversized %s response", async accept => {
    const value = bundle({ currentUser: null, sensitiveInfrastructureAccess: true });
    const asset = { ...value.assets[0], name: "x".repeat(1024 * 1024) };
    value.assets = Array.from({ length: 65 }, () => asset);
    getDashboardBundleMock.mockResolvedValue(value);
    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/map/features", { headers: { accept } }));
    expect(response.status).toBe(503); expect(response.headers.get("X-FireAfter-Map-Error")).toBe(MAP_CAPACITY_CODE);
    const body = await response.text(); expect(body.length).toBeLessThan(1024); expect(JSON.parse(body).code).toBe(MAP_CAPACITY_CODE);
  });
  it.each([false, true])("streaming preserves the complete existing projection including sensitive redaction: authorized=%s", async authorized => {
    getDashboardBundleMock.mockResolvedValue(bundle({ currentUser: null, sensitiveInfrastructureAccess: authorized }));
    const { GET } = await import("./route");
    const request = () => new Request("http://localhost/api/map/features", { headers: { Accept: MAP_STREAM_TYPE } });
    const expected = await (await GET(new Request("http://localhost/api/map/features"))).json();
    const response = await GET(request()), collector = new MapStreamCollector(expected.incidentId);
    expect(response.headers.get("content-type")).toContain(MAP_STREAM_TYPE);
    for (const line of (await response.text()).trimEnd().split("\n")) collector.accept(JSON.parse(line));
    if (!authorized) {
      // Public aliases intentionally rotate between independently projected requests.
      for (const feature of [...expected.assets.features, ...expected.recommendations.features]) {
        if (!feature.properties.redacted) continue;
        for (const key of ["id", "assetId"]) if (feature.properties[key]) {
          const prefix = feature.properties[key].startsWith("rec-redacted") ? "rec" : "asset";
          feature.properties[key] = expect.stringMatching(new RegExp(`^${prefix}-redacted-v2-[0-9a-f]{32}$`));
        }
      }
    }
    expect(collector.finish()).toEqual(expected); expect(response.headers.get("vary")).toBe("Cookie, Accept");
  });
  it("reports failed hydro acquisition without hiding valid roads or calling the feed legacy", async () => {
    const original = bundle({ currentUser: null, sensitiveInfrastructureAccess: false });
    original.sourceSnapshots.push({ ...pwfdfSnapshot(), sourceKey: "3dhp-flowlines", status: "offline", coverageStatus: "error", rawPayload: {
      available: false, status: "error", reason: "provider_error", inventoryComplete: false,
    } }, { ...pwfdfSnapshot(), sourceKey: "tiger-roads", rawPayload: {
      geometryVersion: SOURCE_LINE_GEOMETRY_VERSION,
      features: [{ id: "road-1", sourceKey: "tiger-roads", sourceName: "TIGERweb", paths: [[[-119.4, 34.2], [-119.3, 34.3]]] }],
    } });
    getDashboardBundleMock.mockResolvedValue(original);
    const { GET } = await import("./route");
    const result = await (await GET(new Request("http://localhost/api/map/features"))).json();
    expect(result.hydrography).toMatchObject({ features: [], sourceFeatureCount: 0, geometryVersion: null, warning: SOURCE_LINE_UNAVAILABLE_WARNING });
    expect(result.roads.features).toHaveLength(1);
    expect(result.roads.warning).toBeUndefined();
    expect(result.pwfdfBasins.features).toHaveLength(1);
  });
  it.each([false, true])("withholds legacy acquisition geometry with refresh guidance before/after projection: %s", async projected => {
    const original = bundle({ currentUser: null, sensitiveInfrastructureAccess: false });
    delete original.sourceSnapshots[0].rawPayload!.analysisGeometryVersion;
    if (projected) original.sourceSnapshots[0] = projectSourceFreshness(original.sourceSnapshots[0], new Date("2026-06-28T00:00:00.000Z"));
    getDashboardBundleMock.mockResolvedValue(original);
    const { GET } = await import("./route");
    const result = await (await GET(new Request("http://localhost/api/map/features"))).json();
    expect(result.pwfdfBasins.features).toEqual([]);
    expect(result.pwfdfBasins.warning).toMatch(/refresh/i);
    expect(result.assets.features.length).toBeGreaterThan(0);
  });

  it("preserves multipart basin geometry through JSON transport", async () => {
    const original = bundle({ currentUser: null, sensitiveInfrastructureAccess: false });
    const raw = original.sourceSnapshots[0].rawPayload!;
    const rows = raw.basins as Array<{ geometry: unknown }>;
    const ring = [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]];
    const geometry = { type: "MultiPolygon", coordinates: [[ring], [ring.map(([x, y]) => [x + 10, y])]] };
    rows[0].geometry = geometry;
    getDashboardBundleMock.mockResolvedValue(original);
    const { GET } = await import("./route");
    const result = await (await GET(new Request("http://localhost/api/map/features"))).json();
    expect(result.pwfdfBasins.features[0].geometry).toEqual(geometry);
    expect(result.pwfdfBasins.warning).toBeUndefined();
  });

  it("does not map a healthy subset when the last persisted basin is invalid", async () => {
    const original = bundle({ currentUser: null, sensitiveInfrastructureAccess: false });
    const rows = original.sourceSnapshots[0].rawPayload!.basins as Array<{ id: string; geometry: unknown }>;
    rows.push({ ...rows[0], id: "pwfdf-Canyon_2026_v1-43", geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 1], [2, 2], [0, 0]]] } });
    getDashboardBundleMock.mockResolvedValue(original);
    const { GET } = await import("./route");
    const result = await (await GET(new Request("http://localhost/api/map/features"))).json();
    expect(result.pwfdfBasins.features).toEqual([]);
    expect(result.pwfdfBasins.warning).toMatch(/could not be validated as a complete collection/);
  });

  it.each([false, true])("rejects duplicate basin identity independently of valid topology: duplicate=%s", async duplicate => {
    const original = bundle({ currentUser: null, sensitiveInfrastructureAccess: false });
    const rows = original.sourceSnapshots[0].rawPayload!.basins as Array<{ id: string; geometry: unknown }>;
    rows.push({ ...rows[0], id: duplicate ? rows[0].id : "pwfdf-Canyon_2026_v1-43" });
    getDashboardBundleMock.mockResolvedValue(original);
    const { GET } = await import("./route");
    const result = await (await GET(new Request("http://localhost/api/map/features"))).json();
    expect(result.pwfdfBasins.features).toHaveLength(duplicate ? 0 : 2);
    if (duplicate) expect(result.pwfdfBasins.warning).toMatch(/could not be validated as a complete collection/);
    else expect(result.pwfdfBasins.warning).toBeUndefined();
  });

  it("returns each complete source part separately with its original provenance", async () => {
    const original = bundle({ currentUser: null, sensitiveInfrastructureAccess: false });
    const paths = [Array.from({ length: 180 }, (_, i) => [-119.4 + i / 10000, 34.2]), [[-119.2, 34.3], [-119.1, 34.4]]];
    original.sourceSnapshots.push({ ...pwfdfSnapshot(), sourceKey: "tiger-roads", rawPayload: {
      geometryVersion: SOURCE_LINE_GEOMETRY_VERSION,
      features: [{ id: "road-1", sourceKey: "tiger-roads", sourceName: "TIGERweb", sourceUrl: "https://example.com/roads", paths }],
    } });
    getDashboardBundleMock.mockResolvedValue(original);
    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/map/features"));
    const result = await response.json();
    expect(result.roads.features.map((item: { geometry: { coordinates: unknown } }) => item.geometry.coordinates)).toEqual(paths);
    expect(result.roads.features.map((item: { properties: unknown }) => item.properties)).toEqual([0, 1].map((partIndex) => expect.objectContaining({ sourceFeatureId: "road-1", partIndex, sourceUrl: "https://example.com/roads" })));
    expect(result.roads.sourceFeatureCount).toBe(1);
    expect(result.roads.geometryVersion).toBe(SOURCE_LINE_GEOMETRY_VERSION);
  });

  it.each([undefined, SOURCE_LINE_GEOMETRY_VERSION])("withholds legacy or invalid lines with an actionable warning (%s)", async (geometryVersion) => {
    const original = bundle({ currentUser: null, sensitiveInfrastructureAccess: false });
    original.sourceSnapshots.push({ ...pwfdfSnapshot(), sourceKey: "tiger-roads", rawPayload: {
      geometryVersion,
      features: [{ id: "road-1", sourceKey: "tiger-roads", sourceName: "TIGERweb", paths: [[[-119, 34], [null, 34], [-118, 34]]] }],
    } });
    getDashboardBundleMock.mockResolvedValue(original);
    const { GET } = await import("./route");
    const result = await (await GET(new Request("http://localhost/api/map/features"))).json();
    expect(result.roads.features).toEqual([]);
    expect(result.roads.warning).toContain("Refresh source geometry");
    expect(result.roads.geometryVersion).toBeNull();
  });

  it("returns a stable error without exposing bundle diagnostics", async () => {
    getDashboardBundleMock.mockRejectedValue(
      new Error("private Supabase transport details"),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const { GET } = await import("./route");
    const response = await GET(
      new Request("http://localhost/api/map/features?incidentId=incident-ventura"),
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: "Map features unavailable" });
    expect(JSON.stringify(body)).not.toContain("private Supabase transport details");
    expect(consoleError).toHaveBeenCalledWith(
      "[fireafter] map features unavailable",
      "private Supabase transport details",
    );
    consoleError.mockRestore();
  });

  it("redacts critical-facility names and precise coordinates for unauthenticated users", async () => {
    getDashboardBundleMock.mockResolvedValue(
      bundle({ currentUser: null, sensitiveInfrastructureAccess: false }),
    );

    const { GET } = await import("./route");
    const response = await GET(
      new Request("http://localhost/api/map/features?incidentId=incident-ventura"),
    );
    const body = await response.json();

    expect(body.assets.features).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          geometry: {
            type: "Point",
            coordinates: [-119.1391, 34.3705],
          },
          properties: expect.objectContaining({
            name: "Critical facility response context",
            type: "Critical Facility",
            redacted: true,
          }),
        }),
      ]),
    );
    expect(JSON.stringify(body)).not.toContain("Ventura County Medical Center");
    expect(JSON.stringify(body)).not.toContain("tnm-123");
  });

  it("returns full critical-facility map context for signed-in response users", async () => {
    getDashboardBundleMock.mockResolvedValue(
      bundle({
        currentUser: {
          id: "user-1",
          email: "commander@example.com",
          organizationId: "org-1",
          role: "incident_commander",
        },
        sensitiveInfrastructureAccess: true,
      }),
    );

    const { GET } = await import("./route");
    const response = await GET(
      new Request("http://localhost/api/map/features?incidentId=incident-ventura"),
    );
    const body = await response.json();

    expect(body.assets.features).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          geometry: {
            type: "Point",
            coordinates: [-119.252, 34.278],
          },
          properties: expect.objectContaining({
            name: "Ventura County Medical Center",
            sourceFeatureIds: ["tnm-123"],
            redacted: false,
          }),
        }),
      ]),
    );
  });

  it("returns validated PWFDF basin polygons with public hazard attributes", async () => {
    getDashboardBundleMock.mockResolvedValue(
      bundle({ currentUser: null, sensitiveInfrastructureAccess: false }),
    );

    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/map/features?incidentId=incident-ventura"));
    const body = await response.json();

    expect(body.pwfdfBasins.features).toEqual([
      expect.objectContaining({
        geometry: expect.objectContaining({ type: "Polygon" }),
        properties: expect.objectContaining({
          id: "pwfdf-Canyon_2026_v1-42",
          combinedHazard: "High",
          probabilityClass: "60-80%",
        }),
      }),
    ]);
  });
});

function bundle({
  currentUser,
  sensitiveInfrastructureAccess,
}: {
  currentUser: null | {
    id: string;
    email: string;
    organizationId: string | null;
    role: "incident_commander" | "analyst" | "viewer" | null;
  };
  sensitiveInfrastructureAccess: boolean;
}) {
  return {
    incident: incident(),
    locations: [],
    assets: [criticalFacility()],
    sourceSnapshots: [pwfdfSnapshot()],
    recommendations: [criticalRecommendation()],
    actions: [],
    auditEvents: [],
    currentUser,
    sensitiveInfrastructureAccess,
  };
}

function pwfdfSnapshot(): SourceSnapshot {
  return {
    id: "source-pwfdf",
    incidentId: "incident-ventura",
    sourceKey: "usgs-pwfdf",
    sourceName: "USGS PWFDF",
    fetchedAt: "2026-06-28T00:00:00.000Z",
    sourceUpdatedAt: "2026-06-27T00:00:00.000Z",
    status: "online",
    stale: false,
    freshnessLabel: "1 day ago",
    detail: "One basin loaded.",
    coverageStatus: "available",
    rawPayload: {
      analysisGeometryVersion: "2026-09-14-provider-resolution-v1",
      assessment: {
        fireName: "Canyon",
        fireId: "Canyon_2026_v1",
        assessmentDate: "2026-06-27T00:00:00.000Z",
      },
      basins: [{
        id: "pwfdf-Canyon_2026_v1-42",
        fireId: "Canyon_2026_v1",
        assessmentDate: "2026-06-27T00:00:00.000Z",
        probabilityClass: "60-80%",
        volumeClass: "10,000-100,000",
        combinedHazard: "High",
        geometry: {
          type: "Polygon",
          coordinates: [[
            [-119.4, 34.4], [-119.2, 34.4], [-119.2, 34.6],
            [-119.4, 34.6], [-119.4, 34.4],
          ]],
        },
      }],
    },
  };
}

function incident(): Incident {
  return {
    id: "incident-ventura",
    locationId: "ventura-county-ca",
    county: "Ventura County",
    state: "CA",
    title: "Ventura County Storm Watch",
    code: "CA-FA-06111-001",
    status: "Storm Watch",
    stormWindow: "Next 48-72 hrs",
    rainfallForecast: "0.75 - 1.25 in",
    lastRefresh: "10:24 AM PDT",
    dataFreshness: "High",
    activeAlerts: 1,
    selectedFire: {
      name: "Canyon Fire",
      acres: 1200,
      perimeterUpdated: "2026-06-28T00:00:00.000Z",
      source: "NIFC WFIGS",
      sourceKey: "wfigs",
      coverageStatus: "available",
    },
    locationContext: {
      id: "ventura-county-ca",
      county: "Ventura County",
      state: "CA",
      label: "Ventura County, CA",
      centroid: [-119.1391, 34.3705],
      bbox: [-119.4778, 33.9905, -118.6325, 34.9011],
      fips: "06111",
      fireWeatherZone: "auto",
      population: 0,
      wildfireContext: "Live Census TIGERweb county geometry loaded.",
      sourceKey: "tigerweb-counties",
      coverageStatus: "available",
    },
    coverageStatus: "available",
  };
}

function criticalFacility(): Asset {
  return {
    id: "asset-hospital-1",
    incidentId: "incident-ventura",
    name: "Ventura County Medical Center",
    type: "Critical Facility",
    locationLabel: "3291 Loma Vista Rd",
    coordinates: [-119.252, 34.278],
    source: "USGS TNM Structures",
    confidence: "Medium",
    localOrUploaded: false,
    sourceKey: "tnm-structures",
    sourceFeatureId: "tnm-123",
    sourceFeatureIds: ["tnm-123"],
    coverageStatus: "available",
  };
}

function criticalRecommendation(): Recommendation {
  return {
    id: "rec-critical-1",
    incidentId: "incident-ventura",
    assetId: "asset-hospital-1",
    assetName: "Ventura County Medical Center",
    assetType: "Critical Facility",
    locationLabel: "3291 Loma Vista Rd",
    coordinates: [-119.252, 34.278],
    recommendedAction: "Review response access and monitor nearby drainage.",
    finalScore: 0.64,
    score100: 64,
    riskLevel: "High",
    confidenceLevel: "Medium",
    reasonCodes: ["Critical Facility Exposure", "Downstream Exposure"],
    limitations: ["Facility exposure is screening context only."],
    changedSinceLastRefresh: "Source-Backed Candidate",
    sourcesUpdatedLabel: "Fresh",
    dataFreshnessHours: 1,
    scoreBreakdown: {
      rainfallThreat: 0.6,
      burnSeverity: 0.5,
      slopeTerrain: 0.5,
      downstreamExposure: 0.8,
      dataFreshness: 1,
      confidenceMultiplier: 0.8,
      baseScore: 0.8,
      finalScore: 0.64,
    },
    createdAt: "2026-06-28T00:00:00.000Z",
  };
}
