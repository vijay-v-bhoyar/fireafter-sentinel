import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Incident, Recommendation, SourceSnapshot } from "@/lib/types";
import {
  ATOMIC_BUNDLE_PERSISTENCE_SECURITY_VERSION,
  ATOMIC_RESPONDER_ACTION_SECURITY_VERSION,
  OPERATOR_ACCOUNT_ISSUANCE_AUDIT_SECURITY_VERSION,
} from "@/lib/operational-write-security";

const getDashboardBundleMock = vi.fn();
const checkSupabaseRealitySchemaMock = vi.fn();
const createEmptyDashboardBundleMock = (incidentId?: string) => ({
  incident: {
    id: incidentId ?? "no-incident-selected",
    locationId: "unselected",
    county: "No county selected",
    state: "US",
    title: "Search a county to start",
    code: "FA-UNSELECTED",
    status: "Monitoring",
    stormWindow: "No active storm window",
    rainfallForecast: "Not available",
    lastRefresh: "Never",
    dataFreshness: "Low",
    activeAlerts: 0,
    selectedFire: {
      name: "No fire context selected",
      acres: 0,
      perimeterUpdated: "Not available",
      source: "No source selected",
      coverageStatus: "not_available",
    },
    coverageStatus: "not_available",
  },
  locations: [],
  assets: [],
  sourceSnapshots: [],
  recommendations: [],
  actions: [],
  auditEvents: [],
});

vi.mock("@/lib/fireafter-data", () => ({
  getDashboardBundle: getDashboardBundleMock,
  createEmptyDashboardBundle: createEmptyDashboardBundleMock,
}));

vi.mock("@/lib/fireafter-supabase", () => ({
  checkSupabaseRealitySchema: checkSupabaseRealitySchemaMock,
}));

vi.mock("@/lib/supabase", () => ({
  hasSupabaseEnv: () => true,
  hasSupabaseAdminEnv: () => true,
}));

vi.mock("@/lib/readiness", async () => {
  return import("../../../lib/readiness");
});

describe("GET /api/readiness", () => {
  it.each([null, "wrong-version", "20260913230300"])("FA19-C2 propagates live read-boundary proof: %s", async (version) => {
    getDashboardBundleMock.mockResolvedValue(createEmptyDashboardBundleMock());
    checkSupabaseRealitySchemaMock.mockResolvedValue({ ready: true, errors: [],
      serverOwnedReadsVersion: version, serverOwnedReadsProbeError: null });
    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/readiness"));
    const result = await response.json();
    const blocked = result.deployment.blockers.join(" ").includes("Server-owned operational-read");
    expect(blocked).toBe(version !== "20260913230300");
    expect(result.overallStatus).toBe("blocked"); // Other evidence remains absent.
  });
  beforeEach(() => {
    getDashboardBundleMock.mockReset();
    checkSupabaseRealitySchemaMock.mockResolvedValue({
      ready: true,
      serverOwnedWritesVersion: null,
      serverOwnedWritesProbeError: null,
      atomicResponderActionVersion: ATOMIC_RESPONDER_ACTION_SECURITY_VERSION,
      atomicResponderActionProbeError: null,
      atomicBundlePersistenceVersion: ATOMIC_BUNDLE_PERSISTENCE_SECURITY_VERSION,
      atomicBundlePersistenceProbeError: null,
      operatorAccountIssuanceAuditVersion:
        OPERATOR_ACCOUNT_ISSUANCE_AUDIT_SECURITY_VERSION,
      operatorAccountIssuanceAuditProbeError: null,
      errors: [],
    });
  });

  it("returns product promise gates for Settings", async () => {
    getDashboardBundleMock.mockResolvedValue({
      incident: incident(),
      locations: [],
      assets: [],
      sourceSnapshots: [source("nws"), source("wfigs")],
      recommendations: [recommendation()],
      actions: [],
      auditEvents: [],
      currentUser: null,
    });

    const { GET } = await import("./route");
    const response = await GET(
      new Request("http://localhost/api/readiness?incidentId=incident-ventura"),
    );
    const body = await response.json();

    expect(body.productPromise).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "data_integration",
          label: "Data integration",
        }),
        expect.objectContaining({
          id: "ranked_action_queue",
          nextAction: expect.stringContaining("Action Queue"),
        }),
      ]),
    );
    expect(body.overallStatus).toBe("blocked");
    expect(body.deployment.blockers).toContain(
      "Server-owned operational-write migration has not been verified.",
    );
  });

  it("returns a blocked diagnostic report when dashboard persistence is unavailable", async () => {
    getDashboardBundleMock.mockRejectedValue(new Error("Supabase connection refused"));

    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/readiness"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.overallStatus).toBe("blocked");
    expect(body.deployment.blockers).toContain(
      "Dashboard persistence probe did not complete; verify Supabase connectivity and schema before operational use.",
    );
  });
});

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

function source(sourceKey: string): SourceSnapshot {
  return {
    id: `source-${sourceKey}`,
    incidentId: "incident-ventura",
    sourceKey,
    sourceName: sourceKey,
    fetchedAt: "2026-06-28T00:00:00.000Z",
    sourceUpdatedAt: "2026-06-28T00:00:00.000Z",
    status: "online",
    stale: false,
    freshnessLabel: "Fresh",
    detail: "Source returned data.",
    coverageStatus: "available",
    warnings: [],
  };
}

function recommendation(): Recommendation {
  return {
    id: "rec-1",
    incidentId: "incident-ventura",
    assetId: "asset-1",
    assetName: "SR-33 @ Matilija Creek",
    assetType: "Road Crossing",
    locationLabel: "Matilija Creek",
    coordinates: [-119.303, 34.481],
    recommendedAction: "Inspect road crossing and review debris conditions with road crew.",
    finalScore: 0.72,
    score100: 72,
    riskLevel: "High",
    confidenceLevel: "High",
    reasonCodes: ["Rainfall Threshold Proximity", "Burn Severity"],
    limitations: ["Screening-level source data; field validation remains required."],
    changedSinceLastRefresh: "Source-Backed Candidate",
    sourcesUpdatedLabel: "Fresh",
    dataFreshnessHours: 1,
    scoreBreakdown: {
      rainfallThreat: 0.7,
      burnSeverity: 0.4,
      slopeTerrain: 0.8,
      downstreamExposure: 0.9,
      dataFreshness: 1,
      confidenceMultiplier: 0.95,
      baseScore: 0.76,
      finalScore: 0.72,
    },
    evidence: [
      {
        sourceKey: "tiger-roads",
        sourceName: "TIGERweb Roads",
        summary: "Road line matched nearby hydrography.",
      },
    ],
    sourceSnapshotIds: ["source-nws", "source-wfigs"],
    createdAt: "2026-06-28T00:00:00.000Z",
  };
}
