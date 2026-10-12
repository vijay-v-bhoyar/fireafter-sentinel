import { describe, expect, it } from "vitest";
import {
  buildEvidenceSummaries,
  buildRecommendationClarity,
  buildRecommendationClarityChecklist,
  displayAssetName,
  highPriorityCaption,
} from "./recommendation-clarity";
import type { Recommendation } from "./types";

describe("displayAssetName", () => {
  it("moves raw GIS provenance suffixes out of the card headline", () => {
    expect(displayAssetName("Diamond Fork culvert Utah County GIS OBJECTID 4")).toBe(
      "Diamond Fork culvert",
    );
    expect(displayAssetName("SR-33 @ Matilija Creek")).toBe("SR-33 @ Matilija Creek");
    expect(displayAssetName("Utah County GIS OBJECTID 9")).toBe(
      "Utah County GIS OBJECTID 9",
    );
  });
});

describe("recommendation clarity checklist", () => {
  it("answers the six responder questions from a recommendation snapshot", () => {
    const items = buildRecommendationClarity(recommendation());

    expect(items.map((item) => item.label)).toEqual([
      "Asset at risk",
      "Why ranked",
      "Changed since last refresh",
      "Data freshness",
      "Confidence",
      "Responder action to consider",
    ]);
    expect(items.find((item) => item.key === "asset")).toMatchObject({
      value: "SR-33 @ Matilija Creek",
      detail: "Road Crossing at Matilija Creek",
    });
    expect(items.find((item) => item.key === "why")?.value).toContain(
      "Rainfall Forecast",
    );
    expect(items.find((item) => item.key === "change")?.value).toBe(
      "Higher Risk",
    );
    expect(items.find((item) => item.key === "freshness")).toMatchObject({
      value: "Fresh",
      detail: "1 hr old",
    });
    expect(items.find((item) => item.key === "confidence")).toMatchObject({
      value: "High",
      detail: "Uncalibrated evidence quality; independent of the screening score.",
    });
    expect(items.find((item) => item.key === "action")?.value).toContain(
      "Inspect road crossing",
    );
  });

  it("surfaces source evidence summaries with snapshot fallback", () => {
    expect(buildEvidenceSummaries(recommendation())).toEqual([
      "Road line matched nearby hydrography.",
      "Elevation samples used for slope proxy.",
    ]);

    expect(
      buildEvidenceSummaries({
        ...recommendation(),
        evidence: [],
        sourceSnapshotIds: ["nws", "tiger-roads"],
      }),
    ).toEqual(["Source snapshot: nws", "Source snapshot: tiger-roads"]);
  });

  it("flags missing signal items as degraded in queue checklist format", () => {
    const degraded = buildRecommendationClarityChecklist(
      recommendation({
        assetName: "",
        reasonCodes: [],
        changedSinceLastRefresh: "",
        sourcesUpdatedLabel: "unknown",
        recommendedAction: "",
      }),
    );

    expect(degraded.filter((item) => item.status === "warning")).toHaveLength(5);
    expect(degraded.map((item) => item.key)).toEqual([
      "asset",
      "why",
      "change",
      "freshness",
      "confidence",
      "action",
    ]);
    expect(degraded[0].message).toBe("Missing asset name.");
    expect(degraded[1].message).toBe("Missing reason-code signals.");
  });

  it("does not say no recommendations when recommendations exist", () => {
    expect(highPriorityCaption(0, 0)).toBe("No recommendations yet");
    expect(highPriorityCaption(0, 4)).toBe("No high-priority items");
    expect(highPriorityCaption(2, 4)).toBe("High or unassessed: review evidence");
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
    recommendedAction: "Inspect road crossing and clear debris. Monitor closely.",
    finalScore: 0.72,
    score100: 72,
    riskLevel: "High",
    confidenceLevel: "High",
    reasonCodes: ["Rainfall Forecast", "Road Crossing Exposure", "Downstream Exposure"],
    limitations: ["TIGERweb roads do not verify culvert condition."],
    changedSinceLastRefresh: "Higher Risk",
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
      {
        sourceKey: "usgs-epqs",
        sourceName: "USGS EPQS",
        summary: "Elevation samples used for slope proxy.",
      },
    ],
    sourceSnapshotIds: ["nws", "tiger-roads"],
    createdAt: "2026-06-28T00:00:00.000Z",
    ...overrides,
  };
}
