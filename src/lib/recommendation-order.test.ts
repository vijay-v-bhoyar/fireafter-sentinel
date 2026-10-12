import { describe, expect, it } from "vitest";
import { compareRecommendations } from "./recommendation-order";

describe("canonical queue order", () => {
  const item = { id: "rec-a", assetId: "asset-a", assetName: "Alpha bridge", riskLevel: "Unknown" as const, score100: 0 };
  it("puts missing-evidence reviews first, then known scores descending", () => {
    const known = { ...item, id: "known", riskLevel: "High" as const, score100: 80 };
    expect([known, { ...known, id: "lower", score100: 70 }, item].sort(compareRecommendations).map(row => row.id))
      .toEqual(["rec-a", "known", "lower"]);
  });
  it("breaks equal scores by normalized name then stable domain identity, never input order", () => {
    const items = [item, { ...item, id: "rec-b", assetId: "asset-b" },
      { ...item, id: "rec-z", assetId: "asset-z", assetName: "Zulu bridge" }];
    expect([...items].reverse().sort(compareRecommendations)).toEqual(items);
    expect(compareRecommendations(item, { ...item, assetName: " ALPHA BRIDGE " })).toBe(0);
    expect(compareRecommendations(item, { ...item, id: "rec-b" })).toBe(-1);
  });
});
