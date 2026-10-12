import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Asset, Incident, Recommendation } from "./types";
import { OutboundResponseError } from "./bounded-response";

const getCurrentUserMock = vi.fn();
const getSupabaseIncidentBundleMock = vi.fn();
const getIncidentAuthorizationContextMock = vi.fn();

vi.mock("./auth", () => ({
  getCurrentUser: getCurrentUserMock,
}));

vi.mock("./fireafter-supabase", () => ({
  getIncidentAuthorizationContext: getIncidentAuthorizationContextMock,
  getSupabaseIncidentBundle: getSupabaseIncidentBundleMock,
  persistBundleToSupabase: vi.fn(),
  persistImportedAssetsToSupabase: vi.fn(),
  recordSupabaseAction: vi.fn(),
}));

describe("FireAfter sensitive bundle authorization", () => {
  it("projects county-only assets and recommendations without rewriting the persisted bundle", async () => {
    const stored = bundle();
    stored.incident.locationContext!.boundary = { type: "Polygon", coordinates: [[
      [-119.3, 34.2], [-119.2, 34.2], [-119.2, 34.3], [-119.3, 34.3], [-119.3, 34.2],
    ]] };
    const outside = { ...asset(), id: "neighboring-county", coordinates: [-119.4, 34.4] as [number, number] };
    stored.assets.push(outside);
    stored.recommendations.push({ ...recommendation(outside), id: "neighboring-rec" });
    const before = JSON.stringify(stored);
    getSupabaseIncidentBundleMock.mockResolvedValue(stored);
    getCurrentUserMock.mockResolvedValue(null);
    const { getDashboardBundle } = await import("./fireafter-data");
    const result = await getDashboardBundle(stored.incident.id);
    expect(result.assets).toHaveLength(1);
    expect(result.recommendations).toHaveLength(1);
    expect(JSON.stringify(stored)).toBe(before);
    const { GET: map } = await import("../app/api/map/features/route");
    const { GET: exported } = await import("../app/api/export/geojson/route");
    expect((await (await map(new Request("http://localhost/api/map/features"))).json()).assets.features).toHaveLength(1);
    expect((await (await exported(new Request("http://localhost/api/export/geojson"))).json()).features).toHaveLength(1);
  });

  it("shows unavailable evidence if saved live county topology is invalid", async () => {
    const stored = bundle();
    stored.incident.locationContext!.boundary = { type: "Polygon", coordinates: [] };
    getSupabaseIncidentBundleMock.mockResolvedValue(stored);
    getCurrentUserMock.mockResolvedValue(null);
    const { getDashboardBundle } = await import("./fireafter-data");
    const result = await getDashboardBundle(stored.incident.id);
    expect(result.dataAvailability).toBe("unavailable");
    expect(result.assets).toEqual([]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns an explicitly unavailable public shell when persisted reads time out", async () => {
    vi.stubEnv("NODE_ENV", "production");
    getSupabaseIncidentBundleMock.mockRejectedValue(new OutboundResponseError("timeout"));
    getCurrentUserMock.mockResolvedValue(null);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const { getClientDashboardBundle } = await import("./fireafter-data");
    const bundle = await getClientDashboardBundle();

    expect(bundle.dataAvailability).toBe("unavailable");
    expect(bundle.incident.id).toBe("no-incident-selected");
    expect(bundle.assets).toEqual([]);
    expect(bundle.recommendations).toEqual([]);
    expect(JSON.stringify(bundle)).not.toContain("Upstream response");
    expect(consoleWarn).toHaveBeenCalledWith(
      "[fireafter] public dashboard persistence unavailable",
      { errorName: "OutboundResponseError" },
    );
    consoleWarn.mockRestore();
  });

  it.each([
    [null, null, false], ["viewer", "org-1", false], ["analyst", null, false],
    ["incident_commander", "org-2", false], ["analyst", "ownership-error", false],
    ["analyst", "org-1", true], ["incident_commander", "org-1", true],
  ] as const)("FA18-C3 protects persisted upload metadata in dashboard/map/export for %s %s", async (role, organizationId, allowed) => {
    const marker = "FA18_PRIVATE_UPLOADED_SITE";
    const { importAssets } = await import("./fireafter-store");
    const imported = importAssets({ incidentId: "incident-ventura", incident: incident(),
      actorName: marker, fileName: `${marker}.csv`,
      content: `name,type,lat,lon,road,stream\n${marker},hospital,34.278,-119.252,${marker},${marker}` });
    const stored = { ...bundle(), assets: imported.assets,
      recommendations: [{ ...recommendation(imported.assets[0]), limitations: [marker],
        changedSinceLastRefresh: marker, sourcesUpdatedLabel: marker }],
      auditEvents: [imported.auditEvent] };
    getSupabaseIncidentBundleMock.mockResolvedValue(stored);
    getCurrentUserMock.mockResolvedValue(role ? { id: "user-1", email: "user@example.com", role,
      organizationId: organizationId === "ownership-error" ? "org-1" : organizationId } : null);
    if (organizationId === "ownership-error") getIncidentAuthorizationContextMock.mockRejectedValue(new Error("ownership unavailable"));
    else getIncidentAuthorizationContextMock.mockResolvedValue({ organizationId: "org-1" });
    const before = JSON.stringify(stored);
    const { getClientDashboardBundle } = await import("./fireafter-data");
    const dashboard = await getClientDashboardBundle("incident-ventura");
    const { GET: map } = await import("../app/api/map/features/route");
    const { GET: exported } = await import("../app/api/export/geojson/route");
    const mapResponse = await map(new Request("http://localhost/api/map/features?incidentId=incident-ventura"));
    const exportResponse = await exported(new Request("http://localhost/api/export/geojson?incidentId=incident-ventura"));
    expect(mapResponse.status).toBe(200);
    expect(exportResponse.status).toBe(200);
    const responses = [JSON.stringify(dashboard), await mapResponse.text(), await exportResponse.text()];
    for (const response of responses) expect(response.includes(marker)).toBe(allowed);
    expect(dashboard.sensitiveInfrastructureAccess).toBe(allowed);
    expect(dashboard.recommendations[0].assetId).toBe(dashboard.assets[0].id);
    const nextDashboard = await getClientDashboardBundle("incident-ventura");
    if (allowed) {
      expect(dashboard.assets[0].id).toBe(stored.assets[0].id);
      expect(nextDashboard.assets[0].id).toBe(dashboard.assets[0].id);
    } else {
      expect(dashboard.assets[0].id).toMatch(/^asset-redacted-v2-[0-9a-f]{32}$/);
      expect(nextDashboard.assets[0].id).not.toBe(dashboard.assets[0].id);
    }
    expect(JSON.stringify(stored)).toBe(before);
  });

  it.each([null, "viewer", "incident_commander", "analyst"])(
    "never grants access to legacy FIRMS credentials for role %s", async (role) => {
      const url = "https://firms.modaps.eosdis.nasa.gov/api/area/csv/synthetic-role-key/VIIRS/1,2,3,4/3";
      const stored = bundle();
      stored.recommendations[0].evidence = [{
        sourceKey: "firms", sourceName: "NASA FIRMS", sourceUrl: url, summary: `See ${url}`,
      }];
      getSupabaseIncidentBundleMock.mockResolvedValue(stored);
      getCurrentUserMock.mockResolvedValue(role ? {
        id: "fixture-user", email: "fixture@example.com", organizationId: "org-1", role,
      } : null);
      getIncidentAuthorizationContextMock.mockResolvedValue({ organizationId: "org-1" });
      const { getDashboardBundle } = await import("./fireafter-data");
      const result = await getDashboardBundle("incident-ventura");
      expect(JSON.stringify(result)).not.toContain("synthetic-role-key");
      expect(stored.recommendations[0].evidence[0].sourceUrl).toBe(url);
    },
  );

  beforeEach(() => {
    getCurrentUserMock.mockReset();
    getSupabaseIncidentBundleMock.mockReset();
    getIncidentAuthorizationContextMock.mockReset();
    getSupabaseIncidentBundleMock.mockResolvedValue(bundle());
  });

  it("returns full sensitive context to a same-organization commander", async () => {
    getCurrentUserMock.mockResolvedValue({
      id: "user-1",
      email: "commander@example.com",
      organizationId: "org-1",
      role: "incident_commander",
    });
    getIncidentAuthorizationContextMock.mockResolvedValue({
      databaseIncidentId: "db-incident-1",
      domainIncidentId: "incident-ventura",
      organizationId: "org-1",
    });

    const { getDashboardBundle } = await import("./fireafter-data");
    const result = await getDashboardBundle("incident-ventura");

    expect(result.sensitiveInfrastructureAccess).toBe(true);
    expect(result.assets[0].name).toBe("Ventura County Medical Center");
    expect(result.recommendations[0].coordinates).toEqual([-119.252, 34.278]);
  });

  it("rechecks authorization on every dashboard read even when source reuse is requested", async () => {
    getCurrentUserMock.mockResolvedValue({ id: "user-1", email: "commander@example.com",
      organizationId: "org-1", role: "incident_commander" });
    getIncidentAuthorizationContextMock.mockResolvedValue({ organizationId: "org-1" });
    const { getDashboardBundle } = await import("./fireafter-data");
    const authorized = await getDashboardBundle("incident-ventura");
    expect(authorized.sensitiveInfrastructureAccess).toBe(true);
    getCurrentUserMock.mockResolvedValue({ id: "user-1", email: "commander@example.com",
      organizationId: "org-1", role: "viewer" });
    const downgraded = await getDashboardBundle("incident-ventura");
    expect(downgraded.sensitiveInfrastructureAccess).toBe(false);
    expect(JSON.stringify(downgraded)).not.toContain("Ventura County Medical Center");
    getCurrentUserMock.mockResolvedValue(null);
    const signedOut = await getDashboardBundle("incident-ventura");
    expect(signedOut.sensitiveInfrastructureAccess).toBe(false);
    expect(getCurrentUserMock).toHaveBeenCalledTimes(3);
    expect(getSupabaseIncidentBundleMock.mock.calls).toEqual(Array.from({ length: 3 }, () =>
      ["incident-ventura", { sourceCache: true }]));
  });

  it("redacts sensitive context from a commander in another organization", async () => {
    getCurrentUserMock.mockResolvedValue({
      id: "user-2",
      email: "other@example.com",
      organizationId: "org-2",
      role: "incident_commander",
    });
    getIncidentAuthorizationContextMock.mockResolvedValue({
      databaseIncidentId: "db-incident-1",
      domainIncidentId: "incident-ventura",
      organizationId: "org-1",
    });

    const { getDashboardBundle } = await import("./fireafter-data");
    const result = await getDashboardBundle("incident-ventura");

    expect(result.sensitiveInfrastructureAccess).toBe(false);
    expect(result.assets[0].name).toBe("Critical facility response context");
    expect(result.recommendations[0].coordinates).toEqual([-119.1391, 34.3705]);
    expect(JSON.stringify(result)).not.toContain("Ventura County Medical Center");
  });

  it("fails closed when incident ownership cannot be verified", async () => {
    getCurrentUserMock.mockResolvedValue({
      id: "user-1",
      email: "commander@example.com",
      organizationId: "org-1",
      role: "incident_commander",
    });
    getIncidentAuthorizationContextMock.mockRejectedValue(
      new Error("ownership lookup unavailable"),
    );

    const { getDashboardBundle } = await import("./fireafter-data");
    const result = await getDashboardBundle("incident-ventura");

    expect(result.sensitiveInfrastructureAccess).toBe(false);
    expect(result.assets[0].name).toBe("Critical facility response context");
  });
});

function bundle() {
  const criticalAsset = asset();
  return {
    incident: incident(),
    locations: [],
    assets: [criticalAsset],
    sourceSnapshots: [],
    recommendations: [recommendation(criticalAsset)],
    actions: [],
    auditEvents: [],
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
    },
  };
}

function asset(): Asset {
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
    sourceFeatureIds: ["tnm-123"],
  };
}

function recommendation(sourceAsset: Asset): Recommendation {
  return {
    id: "rec-critical-1",
    incidentId: "incident-ventura",
    assetId: sourceAsset.id,
    assetName: sourceAsset.name,
    assetType: sourceAsset.type,
    locationLabel: sourceAsset.locationLabel,
    coordinates: sourceAsset.coordinates,
    recommendedAction: "Review response access and nearby drainage.",
    finalScore: 0.64,
    score100: 64,
    riskLevel: "High",
    confidenceLevel: "Medium",
    reasonCodes: ["Critical Facility Exposure"],
    limitations: ["Screening context only."],
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
    sourceSnapshotIds: ["source-tnm"],
    createdAt: "2026-06-28T00:00:00.000Z",
  };
}
