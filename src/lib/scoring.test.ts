import { describe, expect, it } from "vitest";
import {
  calculatePriorityScore,
  getRiskLevel,
  SCORE_WEIGHTS,
} from "./scoring";

describe("FireAfter priority scoring", () => {
  it("keeps confidence and freshness separate from hazard screening", () => {
    expect(SCORE_WEIGHTS).toEqual({
      rainfallThreat: 0.35,
      burnSeverity: 0.2,
      slopeTerrain: 0.15,
      downstreamExposure: 0.2,
      dataFreshness: 0,
    });

    const result = calculatePriorityScore({
      rainfallThreat: 0.9,
      burnSeverity: 0.8,
      slopeTerrain: 0.7,
      downstreamExposure: 0.85,
      dataFreshness: 0.9,
      confidenceMultiplier: 0.75,
      missingSignals: [],
      staleSignals: [],
      sourceReliability: "official",
    });

    expect(result.baseScore).toBeCloseTo(0.833, 3);
    expect(result.finalScore).toBeCloseTo(0.833, 3);
    expect(result.score100).toBe(83);
    expect(result.riskLevel).toBe("Very High");
    expect(getRiskLevel(0.8).label).toBe("Very High");
    expect(getRiskLevel(0.6).label).toBe("High");
    expect(getRiskLevel(0.595).label).toBe("High");
    expect(getRiskLevel(0.4).label).toBe("Medium");
    expect(getRiskLevel(0.19).label).toBe("Very Low");
  });

  it("lowers confidence and explains missing or stale data", () => {
    const result = calculatePriorityScore({
      rainfallThreat: 0.82,
      burnSeverity: 0.76,
      slopeTerrain: 0.62,
      downstreamExposure: 0.68,
      dataFreshness: 0.2,
      confidenceMultiplier: 1,
      missingSignals: ["verified culvert inventory"],
      staleSignals: ["burn severity"],
      sourceReliability: "mixed",
    });

    expect(result.confidenceLevel).toBe("Low");
    expect(result.confidenceMultiplier).toBeLessThan(0.8);
    expect(result.reasonCodes).toContain("Missing verified culvert inventory");
    expect(result.reasonCodes).toContain("Stale burn severity");
    expect(result.limitations).toContain(
      "verified culvert inventory is unavailable; verify the missing evidence before relying on this assessment.",
    );
    expect(result.riskLevel).toBe("Unknown");
  });

  it("never lowers hazard when confidence or freshness alone decreases", () => {
    const input = { rainfallThreat: 1, burnSeverity: 1, slopeTerrain: 1, downstreamExposure: 1,
      dataFreshness: 1, confidenceMultiplier: 1, missingSignals: [], staleSignals: [], sourceReliability: "official" as const };
    for (const confidenceMultiplier of [1, 0.5, 0]) {
      const result = calculatePriorityScore({ ...input, confidenceMultiplier, dataFreshness: 0 });
      expect(result.riskLevel).toBe("Very High");
      expect(result.score100).toBe(100);
    }
    const incomplete = calculatePriorityScore({ ...input, missingSignals: ["weather"], staleSignals: ["burn"], sourceReliability: "mixed" });
    expect(incomplete.riskLevel).toBe("Unknown");
    expect(incomplete.score100).toBe(100);
  });

  it("treats invalid and absent hazard inputs as unassessed, not zero hazard", () => {
    for (const rainfallThreat of [undefined, NaN, Infinity, -1, 2]) {
      const result = calculatePriorityScore({ rainfallThreat, burnSeverity: 0, slopeTerrain: 0, downstreamExposure: 0,
        dataFreshness: 1, confidenceMultiplier: 1, missingSignals: [], staleSignals: [], sourceReliability: "official" });
      expect(result.riskLevel).toBe("Unknown");
      expect(result.scoreBasis).toBe("review-only");
      expect(result.score100).toBe(39);
      expect(result.reasonCodes).not.toContain("Heavy Rain Forecast");
    }
    expect(getRiskLevel(NaN).label).toBe("Unknown");
  });
});
