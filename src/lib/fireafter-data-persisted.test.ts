import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getIncidentBundle } from "./fireafter-store";
import { SCORING_VERSION } from "./scoring";

const supabaseMocks = vi.hoisted(() => ({
  getSupabaseIncidentBundle: vi.fn(),
}));

vi.mock("./auth", () => ({
  getCurrentUser: vi.fn(async () => null),
}));

vi.mock("./fireafter-supabase", () => ({
  getIncidentAuthorizationContext: vi.fn(async () => null),
  getSupabaseIncidentBundle: supabaseMocks.getSupabaseIncidentBundle,
  persistBundleToSupabase: vi.fn(async () => null),
  persistImportedAssetsToSupabase: vi.fn(async () => null),
  recordSupabaseAction: vi.fn(async () => null),
}));

import { getDashboardBundle } from "./fireafter-data";

describe("persisted dashboard bundle selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => vi.useRealTimers());

  it("ages repeated dashboard reads without refreshing or mutating persisted evidence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T12:00:00Z"));
    const persisted = structuredClone(getIncidentBundle());
    persisted.sourceSnapshots = [{
      id: "source-nws", incidentId: persisted.incident.id, sourceKey: "nws", sourceName: "NWS",
      fetchedAt: "2026-09-12T12:00:00Z", sourceUpdatedAt: "2026-09-12T11:00:00Z",
      sourceTimeBasis: "provider", validUntil: "2026-09-14T12:00:00Z",
      status: "online", stale: false, freshnessLabel: "Just now", detail: "Source forecast",
    }];
    persisted.assets = [{
      id: "persisted-road-1", incidentId: persisted.incident.id, name: "County road",
      type: "Road Crossing", locationLabel: "Los Angeles County", coordinates: [-118.24, 34.05],
      source: "County GIS", confidence: "High", localOrUploaded: true,
    }];
    persisted.recommendations = [{
      id: "persisted-recommendation-1", incidentId: persisted.incident.id,
      assetId: persisted.assets[0].id, assetName: persisted.assets[0].name,
      assetType: "Road Crossing", locationLabel: persisted.assets[0].locationLabel,
      coordinates: [...persisted.assets[0].coordinates], recommendedAction: "Review evidence",
      finalScore: 0.9, score100: 90, riskLevel: "Very High", confidenceLevel: "High",
      reasonCodes: ["Fresh Source Data"], limitations: [], changedSinceLastRefresh: "Updated",
      sourcesUpdatedLabel: "Just now", dataFreshnessHours: 1,
      sourceSnapshotIds: [persisted.sourceSnapshots[0].id], createdAt: "2026-09-12T12:00:00Z",
      scoreBreakdown: {
        scoringVersion: SCORING_VERSION, scoreBasis: "hazard-screening",
        rainfallThreat: 0.9, burnSeverity: 0.9, slopeTerrain: 0.9, downstreamExposure: 0.9,
        dataFreshness: 1, confidenceMultiplier: 1, baseScore: 0.9, finalScore: 0.9,
        metricStatus: {
          rainfallThreat: "available", burnSeverity: "available", slopeTerrain: "available",
          downstreamExposure: "available", dataFreshness: "available",
        },
      },
    }];
    const original = structuredClone(persisted);
    supabaseMocks.getSupabaseIncidentBundle.mockResolvedValue(persisted);
    const fresh = await getDashboardBundle(persisted.incident.id);
    expect(fresh.sourceSnapshots[0].freshness?.state).toBe("current");
    expect(fresh.recommendations).toHaveLength(1);
    expect(fresh.recommendations[0]).toMatchObject({ riskLevel: "Very High", score100: 90 });
    expect(Object.values(fresh.recommendations[0].scoreBreakdown.metricStatus!)).toEqual(Array(5).fill("available"));
    vi.setSystemTime(new Date("2026-09-12T12:30:00Z"));
    const expired = await getDashboardBundle(persisted.incident.id);
    expect(expired.sourceSnapshots[0]).toMatchObject({ stale: true, status: "delayed", freshness: { state: "expired" } });
    expect(expired.incident.status).toBe("Stale Data");
    expect(expired.recommendations[0]).toMatchObject({ riskLevel: "Unknown", score100: 90, finalScore: 0.9 });
    expect(expired.recommendations.length).toBe(fresh.recommendations.length);
    expect(expired.recommendations.every((recommendation) =>
      Object.values(recommendation.scoreBreakdown.metricStatus!).every((status) => status === "not_available"),
    )).toBe(true);
    expect(Object.values(persisted.recommendations[0].scoreBreakdown.metricStatus!)).toEqual(Array(5).fill("available"));
    expect(persisted.sourceSnapshots[0].stale).toBe(false);
    expect(persisted).toEqual(original);
  });

  it("does not discard real persisted data because a fire name matches a legacy fixture", async () => {
    const persisted = structuredClone(getIncidentBundle());
    persisted.incident = {
      ...persisted.incident,
      title: "Persisted operational incident",
      selectedFire: {
        ...persisted.incident.selectedFire,
        name: "Los Angeles Canyon Fire",
        source: "NIFC WFIGS current perimeter",
        coverageStatus: "available",
      },
    };
    supabaseMocks.getSupabaseIncidentBundle.mockResolvedValue(persisted);

    const result = await getDashboardBundle(persisted.incident.id);

    expect(result.incident.title).toBe("Persisted operational incident");
    expect(result.incident.selectedFire.source).toBe(
      "NIFC WFIGS current perimeter",
    );
  });
});
