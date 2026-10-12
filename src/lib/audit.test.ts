import { describe, expect, it } from "vitest";
import { createResponderAction, createRecommendationSnapshot } from "./audit";
import type { Recommendation } from "./types";

const recommendation: Recommendation = {
  id: "rec-pine-creek",
  incidentId: "incident-canyon-fire",
  assetId: "asset-pine-creek",
  assetName: "Pine Creek Road @ Canyon Creek",
  assetType: "Road Crossing",
  locationLabel: "Canyon Creek",
  coordinates: [-118.842, 34.126],
  recommendedAction: "Inspect crossing and upstream channel. Prepare for possible closure.",
  finalScore: 0.92,
  score100: 92,
  riskLevel: "Very High",
  confidenceLevel: "High",
  reasonCodes: ["Heavy Rain Forecast", "High Burn Severity", "Steep Slope"],
  limitations: [],
  changedSinceLastRefresh: "Higher Risk",
  sourcesUpdatedLabel: "10:18 AM PDT",
  dataFreshnessHours: 2,
  scoreBreakdown: {
    rainfallThreat: 0.94,
    burnSeverity: 0.88,
    slopeTerrain: 0.82,
    downstreamExposure: 0.9,
    dataFreshness: 0.9,
    confidenceMultiplier: 0.98,
    baseScore: 0.9,
    finalScore: 0.92,
  },
  createdAt: "2026-06-27T04:00:00.000Z",
};

describe("audit snapshots", () => {
  it("freezes the recommendation state used by responder actions", () => {
    const snapshot = createRecommendationSnapshot(recommendation);
    const action = createResponderAction({
      recommendation,
      action: "modify",
      note: "Assign to Road Crew 2 before 1600.",
      actorName: "J. Smith",
      createdAt: "2026-06-27T04:05:00.000Z",
      modifiedPriority: "High",
    });

    recommendation.score100 = 12;
    recommendation.reasonCodes.push("Changed after action");

    expect(snapshot.score100).toBe(92);
    expect(action.recommendationSnapshot.score100).toBe(92);
    expect(action.recommendationSnapshot.reasonCodes).toEqual([
      "Heavy Rain Forecast",
      "High Burn Severity",
      "Steep Slope",
    ]);
    expect(action.auditEvent.eventType).toBe("RecommendationModified");
    expect(action.auditEvent.summary).toContain("J. Smith modified Pine Creek Road");
  });
});
