import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Recommendation } from "@/lib/types";

const getDashboardBundleMock = vi.fn();

vi.mock("@/lib/fireafter-data", () => ({
  getDashboardBundle: getDashboardBundleMock,
}));

vi.mock("@/lib/error-message", () => ({
  errorMessage: (error: unknown, fallback: string) =>
    error instanceof Error && error.message ? error.message : fallback,
}));

describe("GET /api/recommendations", () => {
  beforeEach(() => {
    getDashboardBundleMock.mockReset();
  });

  it("returns ranked recommendations with queue-clarity fields for API consumers", async () => {
    getDashboardBundleMock.mockResolvedValue({
      incident: {
        id: "incident-ventura",
        status: "Storm Watch",
        title: "Ventura",
        county: "Ventura County",
        state: "CA",
        code: "CA-FA-",
        locationId: "ventura-ca",
        stormWindow: "",
        rainfallForecast: "",
        lastRefresh: "",
        dataFreshness: "High",
        activeAlerts: 0,
        selectedFire: { name: "", acres: 0, perimeterUpdated: "", source: "" },
      },
      locations: [],
      assets: [],
      sourceSnapshots: [],
      recommendations: [recommendation(), recommendation({ id: "rec-2" })],
      actions: [],
      auditEvents: [],
      currentUser: null,
    });

    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/recommendations?incidentId=incident-ventura"));
    const body = await response.json();

    expect(Array.isArray(body.recommendations)).toBe(true);
    expect(body.recommendations).toHaveLength(2);

    const top = body.recommendations[0] as Recommendation;
    expect(top).toMatchObject({
      id: "rec-1",
      assetName: expect.any(String),
      assetType: expect.any(String),
      locationLabel: expect.any(String),
      recommendedAction: expect.any(String),
      changedSinceLastRefresh: expect.any(String),
      sourcesUpdatedLabel: expect.any(String),
      confidenceLevel: expect.any(String),
      limitations: expect.any(Array),
      evidence: expect.any(Array),
      scoreBreakdown: expect.any(Object),
    });

    expect(typeof top.scoreBreakdown.finalScore).toBe("number");
    expect(Array.isArray(top.reasonCodes)).toBe(true);
    expect(Array.isArray(top.limitations)).toBe(true);
    expect(Array.isArray(top.evidence)).toBe(true);
    expect(typeof top.dataFreshnessHours).toBe("number");
    expect(top.dataFreshnessHours).toBeGreaterThanOrEqual(0);

    const requiredTopRows: Recommendation[] = body.recommendations.slice(0, Math.min(10, body.recommendations.length));
    for (const row of requiredTopRows) {
      const limitations = row.limitations ?? [];
      const evidence = row.evidence ?? [];
      const reasonCodes = row.reasonCodes ?? [];
      expect(row.assetName.trim().length).toBeGreaterThan(0);
      expect(row.assetType.trim().length).toBeGreaterThan(0);
      expect(row.locationLabel.trim().length).toBeGreaterThan(0);
      expect(row.recommendedAction.trim().length).toBeGreaterThan(0);
      expect(row.changedSinceLastRefresh.trim().length).toBeGreaterThan(0);
      expect(row.sourcesUpdatedLabel.trim().toLowerCase()).not.toBe("unknown");
      expect(row.confidenceLevel.trim().length).toBeGreaterThan(0);
      expect(reasonCodes.length).toBeGreaterThan(0);
      expect(limitations.length).toBeGreaterThan(0);
      expect(evidence.length).toBeGreaterThan(0);
      expect(row.scoreBreakdown.finalScore).toBeGreaterThanOrEqual(0);
    }
  });

  it("returns a structured JSON error when recommendations are unavailable", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    getDashboardBundleMock.mockRejectedValueOnce(
      new Error("Supabase recommendation lookup failed"),
    );

    const { GET } = await import("./route");
    const response = await GET(
      new Request("http://localhost/api/recommendations"),
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: "Recommendations unavailable",
      recommendations: [],
    });
    expect(consoleError).toHaveBeenCalledWith(
      "[fireafter] recommendations unavailable",
      "Supabase recommendation lookup failed",
    );
    consoleError.mockRestore();
  });
});

function recommendation(overrides: Partial<Recommendation> = {}): Recommendation {
  return {
    id: "rec-1",
    incidentId: "incident-ventura",
    assetId: "asset-1",
    assetName: "SR-33 @ Matilija Creek",
    assetType: "Road Crossing",
    locationLabel: "Matilija Creek",
    coordinates: [-119.303, 34.481],
    recommendedAction: "Inspect road crossing and monitor drainage channels.",
    finalScore: 0.72,
    score100: 72,
    riskLevel: "High",
    confidenceLevel: "High",
    reasonCodes: ["Rainfall forecast", "Road-crossing exposure"],
    limitations: ["Source-backed inference has screening limits."],
    changedSinceLastRefresh: "Higher risk than previous refresh.",
    sourcesUpdatedLabel: "Fresh",
    dataFreshnessHours: 1.2,
    scoreBreakdown: {
      rainfallThreat: 0.72,
      burnSeverity: 0.4,
      slopeTerrain: 0.5,
      downstreamExposure: 0.81,
      dataFreshness: 0.98,
      confidenceMultiplier: 0.96,
      baseScore: 0.72,
      finalScore: 0.72,
    },
    sourceSnapshotIds: ["nws", "wfigs"],
    evidence: [
      {
        sourceKey: "nws",
        sourceName: "NWS",
        summary: "Forecast confirms high rain intensity in basin window.",
      },
    ],
    createdAt: "2026-06-28T00:00:00.000Z",
    ...overrides,
  } as Recommendation;
}
