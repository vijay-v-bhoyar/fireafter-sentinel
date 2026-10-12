import { describe, expect, it, vi } from "vitest";
import { fetchPwfdfSource } from "./live-sources";
import { buildPwfdfBasinsUrl, parsePwfdfBasins, pwfdfBasinsFromSnapshot, pwfdfLinkageBasinsFromSnapshot } from "./pwfdf";
import { coordinateInPolygon } from "./geo";
import { projectBundleFreshness, projectRecommendationFreshness, projectSourceFreshness } from "./source-freshness";
import type { Asset, Incident, LocationCandidate, Recommendation, SourceSnapshot } from "./types";

const analysisVersion = "2026-09-14-provider-resolution-v1";
const date = "2026-09-14T06:00:00.000Z";
const assessment = { fireName: "Canyon", fireId: "canyon", assessmentDate: date };
const selectedFire = { name: "Canyon Fire", sourceKey: "wfigs" as const, sourceFeatureId: "test-perimeter", coverageStatus: "available" as const };
const incident = { id: "test-incident", selectedFire } as Incident;
const location: LocationCandidate = { id: "test-county", label: "Test", county: "Test", state: "CA", fips: "06111", centroid: [-119.3, 34.5], bbox: [-119.4, 34.4, -119.2, 34.6], fireWeatherZone: "CAZ354", population: 0, wildfireContext: "Test fixture" };
const rings = [[[-119.3000046, 34.49999], [-119.2999954, 34.49999], [-119.2999954, 34.50001], [-119.3000046, 34.50001], [-119.3000046, 34.49999]]];
const feature = { attributes: { OBJECTID: 1, fire_id: "canyon", assessment_date: date, BP_Legend: "20-40%", BV_Legend: "100-1000", BCH_Legend: "High" }, geometry: { rings } };
const basins = () => parsePwfdfBasins({ features: [feature] }, assessment);
function snapshot(version: unknown = analysisVersion): SourceSnapshot {
  return { id: "test-pwfdf", incidentId: incident.id, sourceKey: "usgs-pwfdf", sourceName: "USGS",
    status: "online", coverageStatus: "available", fetchedAt: date, sourceUpdatedAt: date, stale: false,
    freshnessLabel: "Test", detail: "Test", rawPayload: { analysisGeometryVersion: version,
      geometryVersion: "2026-09-14-basin-topology-v1", available: true, linkageVersion: "2026-09-14-pwfdf-discovery-v2",
      assessmentDiscovery: { version: "2026-09-13-object-id-inventory-v1", complete: true, expectedCount: 1, receivedCount: 1 },
      selectedFire, assessment, basinCount: 1, basins: basins() } };
}

describe("FA08 analysis geometry acquisition", () => {
  it.each([null, "unknown", analysisVersion])("sanitizes direct recommendation projections for acquisition version %s", version => {
    const evidence = [{ sourceKey: "usgs-pwfdf", sourceName: "USGS", summary: "Basin claim" },
      { sourceKey: "tiger-roads", sourceName: "Roads", summary: "Unrelated road evidence" }];
    const recommendation = { id: "test-rec", evidence, riskLevel: "High", confidenceLevel: "High", reasonCodes: [], limitations: [],
      score100: 80, scoreBreakdown: { confidenceMultiplier: 0.9, scoreBasis: "hazard-screening" } } as unknown as Recommendation;
    const before = structuredClone(recommendation);
    const sources = [projectSourceFreshness(snapshot(version), new Date(date))];
    const [result] = projectRecommendationFreshness([recommendation], sources, new Date(date));
    expect(result.evidence).toEqual(version === analysisVersion ? evidence : evidence.slice(1));
    expect(result.score100).toBe(80);
    if (version !== analysisVersion) expect(result).toMatchObject({ riskLevel: "Unknown", confidenceLevel: "Low" });
    expect(projectRecommendationFreshness([result], sources, new Date(date))).toEqual([result]);
    expect(recommendation).toEqual(before);
  });

  it("requests JSON WGS84 geometry without generalization, decimal rounding or quantization", () => {
    const params = buildPwfdfBasinsUrl("canyon").searchParams;
    expect(params.get("f")).toBe("json");
    expect(params.get("outSR")).toBe("4326");
    expect(params.get("returnGeometry")).toBe("true");
    for (const key of ["maxAllowableOffset", "geometryPrecision", "quantizationParameters"]) expect(params.has(key)).toBe(false);
    expect(params.get("resultRecordCount")).toBe("501");
  });

  it("retains sub-five-decimal geometry and provenance from the real adapter through JSON reload", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async input => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/4/query")) return Response.json({ features: [feature] });
      if (url.searchParams.get("returnIdsOnly") === "true") return Response.json({ objectIdFieldName: "OBJECTID", objectIds: [1] });
      return Response.json({ features: [{ attributes: { OBJECTID: 1, fire: "Canyon", Fire_ID: "canyon", assessment_date: date } }] });
    });
    const result = await fetchPwfdfSource(location, incident, { fetchImpl, now: new Date(date) });
    expect(result.coverageStatus).toBe("available");
    expect(result.rawPayload.analysisGeometryVersion).toBe(analysisVersion);
    const reloaded = JSON.parse(JSON.stringify({ ...result, id: "test-pwfdf", incidentId: incident.id }));
    const [basin] = pwfdfBasinsFromSnapshot(reloaded);
    expect(basin.geometry).toEqual({ type: "Polygon", coordinates: rings });
    expect(coordinateInPolygon([-119.3, 34.5], basin.geometry)).toBe(true);
    expect(coordinateInPolygon([-119.300005, 34.5], basin.geometry)).toBe(false);
    expect(coordinateInPolygon([-119.3000046, 34.5], basin.geometry)).toBe(false);
    expect(fetchImpl.mock.calls.filter(([input]) => String(input).includes("/4/query"))).toHaveLength(1);
  });

  it.each([null, "2026-09-14-basin-topology-v1", "unknown"])("rejects unverified acquisition version %s without rewriting retained evidence", version => {
    const original = snapshot(version);
    const before = structuredClone(original);
    expect(pwfdfBasinsFromSnapshot(original)).toEqual([]);
    expect(pwfdfLinkageBasinsFromSnapshot(original, incident)).toEqual([]);
    const projected = projectSourceFreshness(original, new Date(date));
    expect(projected).toMatchObject({ coverageStatus: "not_available", stale: true, freshness: { state: "invalid" } });
    expect(projected.detail).toMatch(/refresh/i);
    expect(projected.rawPayload).toMatchObject({ available: false, failureCode: "pwfdf_analysis_geometry_unverified" });
    expect(original).toEqual(before);
  });

  it("rejects a legacy snapshot with no acquisition version", () => {
    const original = snapshot();
    delete original.rawPayload!.analysisGeometryVersion;
    expect(pwfdfBasinsFromSnapshot(original)).toEqual([]);
    expect(projectSourceFreshness(original, new Date(date)).coverageStatus).toBe("not_available");
  });

  it.each([null, "2026-09-14-basin-topology-v1", "unknown"])("independently invalidates current source projection for acquisition version %s", version => {
    const original = snapshot(version);
    const projected = projectSourceFreshness(original, new Date(date));
    expect(projected).toMatchObject({ coverageStatus: "not_available", stale: true, freshness: { state: "invalid" } });
    expect(projected.rawPayload).toMatchObject({ available: false, failureCode: "pwfdf_analysis_geometry_unverified" });
    expect(projectSourceFreshness(projected, new Date(date))).toEqual(projected);
    expect(original.coverageStatus).toBe("available");
  });

  it("removes legacy current basin claims while preserving historical evidence and unrelated metrics", () => {
    const evidence = [{ sourceKey: "usgs-pwfdf", sourceName: "USGS", summary: "Legacy basin", sourceFeatureId: "pwfdf-canyon-1" }];
    const asset = { id: "test-asset", evidence, metrics: { slopeTerrain: 0.5, pwfdfCombinedHazard: "High" } } as Asset;
    const recommendation = { id: "test-rec", evidence, riskLevel: "High", confidenceLevel: "High", reasonCodes: [], limitations: [],
      score100: 80, scoreBreakdown: { confidenceMultiplier: 0.9, scoreBasis: "hazard-screening" } } as unknown as Recommendation;
    const original = { incident, sourceSnapshots: [snapshot(null)], assets: [asset], recommendations: [recommendation],
      actions: [{ recommendationSnapshot: structuredClone(recommendation) }], auditEvents: [{ payload: { recommendationSnapshot: structuredClone(recommendation) } }] };
    const before = structuredClone(original);
    const projected = projectBundleFreshness(original, new Date(date));
    expect(projected.assets[0].evidence).toEqual([]);
    expect(projected.assets[0].metrics).toEqual({ slopeTerrain: 0.5 });
    expect(projected.recommendations[0]).toMatchObject({ evidence: [], riskLevel: "Unknown", confidenceLevel: "Low", score100: 80 });
    expect(projected.actions).toEqual(before.actions);
    expect(projected.auditEvents).toEqual(before.auditEvents);
    expect(original).toEqual(before);
  });

  it("retains current geometry without treating its version as proof of fire identity", () => {
    const original = snapshot();
    expect(pwfdfBasinsFromSnapshot(original)).toEqual(basins());
    expect(projectSourceFreshness(original, new Date(date))).toMatchObject({ coverageStatus: "available", freshness: { state: "current" } });
  });
});
