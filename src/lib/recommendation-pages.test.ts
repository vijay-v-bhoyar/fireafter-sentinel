import { expect, it } from "vitest";
import { createLiveRecommendationScorer, prepareLiveRecommendationContext, RECOMMENDATION_PAGE_SIZE,
  sourceFailureResult, type LiveSourceResult, type ScoredLiveRecommendation } from "./live-sources";
import { compareRecommendations } from "./recommendation-order";
import { calculatePriorityScore } from "./scoring";
import type { Asset, Incident, Recommendation, SourceSnapshot } from "./types";

const now = new Date("2026-10-08T12:00:00.000Z");
const incident = { id: "page-test" } as Incident;
const source: LiveSourceResult = { ...sourceFailureResult("nws", now), status: "online", stale: false, warnings: [],
  sourceUpdatedAt: "2026-10-08T10:00:00.000Z", freshnessLabel: "Current fixture", rawPayload: { privateFixture: "do-not-copy-raw-data" },
  derivedSignals: { rainfallThreat: 0.8, burnSeverity: 0.7, reasonCodes: ["Fixture reason"], limitations: ["Fixture limitation"] } };
const snapshot = { ...source, id: "source-fixture", incidentId: incident.id } as SourceSnapshot;
const assets: Asset[] = Array.from({ length: 300 }, (_, i) => ({ id: `asset-${i}`, incidentId: incident.id,
  name: `Bridge ${String(299 - i).padStart(3, "0")}`, type: "Bridge", locationLabel: "Test stream", coordinates: [-120, 35],
  source: "Test fixture", sourceKey: "fhwa-nbi-bridges", origin: "source", confidence: "Medium", localOrUploaded: i === 0,
  sourceFeatureId: `fixture-${i}`, coverageStatus: "available",
  metrics: { slopeTerrain: i % 3 ? 0.7 : undefined, downstreamExposure: (i % 10) / 10 } }));

function context(previous: Recommendation[] = [], previousSources: SourceSnapshot[] = []) {
  return prepareLiveRecommendationContext(incident, source.derivedSignals, [source], [snapshot], now, previous, previousSources);
}
function scoreAll() {
  const scorer = createLiveRecommendationScorer(context()), rows: ScoredLiveRecommendation[] = [];
  for (let offset = 0; offset < assets.length; offset += RECOMMENDATION_PAGE_SIZE) rows.push(...scorer.scorePage(assets.slice(offset, offset + RECOMMENDATION_PAGE_SIZE)));
  return rows.sort(compareRecommendations);
}
it("uses one compact serializable context without raw source data or prior recommendation payloads", () => {
  const previous = scoreAll().slice(0, 1);
  previous[0].evidence = [{ sourceName: "Large prior fixture", summary: "prior-payload-must-not-persist", sourceKey: "test" }];
  const value = context(previous), text = JSON.stringify(value);
  expect(text).not.toContain("do-not-copy-raw-data");
  expect(text).not.toContain("prior-payload-must-not-persist");
  expect(text).not.toContain("scoreBreakdown");
  expect(Object.keys(value.previousByAsset[0][1])).toEqual(["riskLevel", "score100", "rank"]);
  expect(text.length).toBeLessThan(1800);
  const original = createLiveRecommendationScorer(value), restored = createLiveRecommendationScorer(JSON.parse(text));
  expect(restored.scorePage(assets.slice(0, 8))).toEqual(original.scorePage(assets.slice(0, 8)));
  expect(value.createdAt).toBe(now.toISOString());
  expect(value.evidenceAgeHours).toBe(2);
});
it("scores pages independently but uses global ranks for explanations across page boundaries", () => {
  const previous = scoreAll();
  const scorer = createLiveRecommendationScorer(context([...previous].reverse()));
  const ranks = new Map(previous.map((row, index) => [row.id, index + 1]));
  const page = scorer.scorePage(assets.slice(128, 256));
  const finalized = scorer.finalizePage(page, id => ranks.get(id));
  for (const row of finalized) expect(row.changedSinceLastRefresh).toContain(`position unchanged (was #${ranks.get(row.id)}, now #${ranks.get(row.id)})`);
  expect(finalized.some((row, i) => ranks.get(row.id) !== i + 1)).toBe(true);
  expect(page.map(row => row.changedSinceLastRefresh)).toEqual(Array(page.length).fill("Source-Backed Candidate"));
});
it("retains exact score inputs, confidence and missingness rather than interpreting absent slope as low risk", () => {
  const scorer = createLiveRecommendationScorer(context());
  const [missing, complete] = scorer.scorePage(assets.slice(0, 2));
  expect(missing.riskLevel).toBe("Unknown");
  expect(missing.scoreBreakdown.metricStatus?.slopeTerrain).toBe("not_available");
  const expected = calculatePriorityScore({ rainfallThreat: 0.8, burnSeverity: 0.7, slopeTerrain: 0.7,
    downstreamExposure: 0.1, dataFreshness: 0.9, confidenceMultiplier: 0.94,
    missingSignals: [], staleSignals: [], sourceReliability: "official" });
  expect(complete.finalScore).toBe(expected.finalScore);
  expect(complete.confidenceLevel).toBe(expected.confidenceLevel);
  expect(complete.reasonCodes).toContain("Fixture reason");
  expect(complete.limitations).toContain("Fixture limitation");
});
it("preserves identity-first matching, name/type/location fallback and source-change wording", () => {
  const row = scoreAll().find(item => item.assetId === assets[1].id)!;
  const old = { ...row, assetId: "old-id", id: "old-recommendation", score100: 1, riskLevel: "Low" as const };
  const previousSnapshot = { ...snapshot, status: "offline" as const, stale: true, freshnessLabel: "Old fixture" };
  const scorer = createLiveRecommendationScorer(context([old], [previousSnapshot]));
  const final = scorer.finalizePage(scorer.scorePage([assets[1]]), () => 129)[0];
  expect(final.changedSinceLastRefresh).toContain("moved down 128 positions (was #1, now #129)");
  expect(final.changedSinceLastRefresh).toContain("risk level changed from Low");
  expect(final.changedSinceLastRefresh).toContain("score increased by");
  expect(final.changedSinceLastRefresh).toContain("Sources updated:");
  expect(final.changedSinceLastRefresh).toContain("offline -> online");
});
it("takes a private context snapshot and does not let one output page mutate later pages", () => {
  const value = context(), scorer = createLiveRecommendationScorer(value);
  const expected = scorer.scorePage([assets[1]]);
  value.sourceSnapshotIds.push("caller-change"); value.reasonCodes.push("caller-change");
  const changed = scorer.scorePage([assets[1]]);
  changed[0].sourceSnapshotIds!.push("output-change"); changed[0].reasonCodes.push("output-change");
  expect(scorer.scorePage([assets[1]])).toEqual(expected);
});
it.each([undefined, 0, -1, 1.5, NaN, Infinity])("rejects missing or invalid global rank %s", rank => {
  const scorer = createLiveRecommendationScorer(context());
  expect(() => scorer.finalizePage(scorer.scorePage([assets[1]]), () => rank)).toThrow("recommendation_rank_missing");
});
it("rejects oversized pages and unsupported contexts rather than silently truncating", () => {
  const scorer = createLiveRecommendationScorer(context());
  expect(() => scorer.scorePage(assets.slice(0, 129))).toThrow("recommendation_page_capacity");
  const rows = [...scorer.scorePage(assets.slice(0, 128)), ...scorer.scorePage([assets[128]])];
  expect(() => scorer.finalizePage(rows, () => 1)).toThrow("recommendation_page_capacity");
  expect(() => createLiveRecommendationScorer({ ...context(), version: 2 } as never)).toThrow("recommendation_context_invalid");
});
