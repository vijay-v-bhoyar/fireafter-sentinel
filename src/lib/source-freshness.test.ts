import { describe, expect, it } from "vitest";
import { evidenceMaxAgeMinutes, hasCurrentSourceEvidence, projectBundleFreshness, projectSourceFreshness } from "./source-freshness";
import type { Incident, Recommendation, SourceSnapshot } from "./types";

const checkedAt = "2026-09-12T12:00:00.000Z";
function source(overrides: Partial<SourceSnapshot> = {}): SourceSnapshot {
  return {
    id: "source-nws", incidentId: "incident-1", sourceKey: "nws", sourceName: "NWS",
    fetchedAt: checkedAt, sourceUpdatedAt: "2026-09-12T11:00:00.000Z", sourceTimeBasis: "provider",
    validUntil: "2026-09-14T12:00:00.000Z", status: "online", stale: false,
    freshnessLabel: "Just now", detail: "Forecast", coverageStatus: "available", ...overrides,
    // Date oracles isolate temporal provenance from the separately tested acquisition contract.
    ...(overrides.sourceKey === "usgs-pwfdf" ? { rawPayload: {
      analysisGeometryVersion: "2026-09-14-provider-resolution-v1", ...overrides.rawPayload,
    } } : {}),
  };
}
function bundle() {
  const incident: Incident = {
    id: "incident-1", locationId: "county-1", county: "Test County", state: "CA", title: "Test", code: "TEST",
    status: "Storm Watch", stormWindow: "48 hours", rainfallForecast: "Source forecast", lastRefresh: checkedAt,
    dataFreshness: "High", activeAlerts: 1, alertCoverageStatus: "available",
    selectedFire: { name: "Test fire", acres: 100, perimeterUpdated: checkedAt, source: "WFIGS" },
  };
  const recommendation: Recommendation = {
    id: "recommendation-1", incidentId: incident.id, assetId: "asset-1", assetName: "Test road",
    assetType: "Road Crossing", locationLabel: "Test", coordinates: [-119, 35],
    recommendedAction: "Review evidence", finalScore: 0.9, score100: 90, riskLevel: "Very High", confidenceLevel: "High",
    reasonCodes: ["Fresh Source Data"], limitations: [], changedSinceLastRefresh: "Updated", sourcesUpdatedLabel: "Just now",
    dataFreshnessHours: 0, sourceSnapshotIds: ["nws"], createdAt: checkedAt,
    scoreBreakdown: { rainfallThreat: 1, burnSeverity: 1, slopeTerrain: 1, downstreamExposure: 1, dataFreshness: 1,
      confidenceMultiplier: 1, baseScore: 0.9, finalScore: 0.9, scoreBasis: "hazard-screening",
      metricStatus: { rainfallThreat: "available", burnSeverity: "available", slopeTerrain: "available", downstreamExposure: "available", dataFreshness: "available" } },
  };
  return { incident, sourceSnapshots: [source()], recommendations: [recommendation],
    auditEvents: [{ snapshot: structuredClone(recommendation) }] };
}

describe("clock-based evidence freshness", () => {
  it("counts only current, available evidence without changing the snapshot", () => {
    const current = projectSourceFreshness(source(), new Date(checkedAt));
    const before = structuredClone(current);
    expect(hasCurrentSourceEvidence(current)).toBe(true);
    for (const change of [
      { stale: true }, { status: "delayed" }, { status: "offline" },
      { coverageStatus: "partial" }, { coverageStatus: "not_available" },
      { coverageStatus: "error" }, { coverageStatus: undefined }, { freshness: undefined },
      { freshness: { ...current.freshness!, state: "expired" } },
      { freshness: { ...current.freshness!, state: "invalid" } },
    ] satisfies Partial<SourceSnapshot>[]) {
      expect(hasCurrentSourceEvidence({ ...current, ...change })).toBe(false);
    }
    expect(hasCurrentSourceEvidence(projectSourceFreshness(source(), new Date("2026-09-12T12:30:00Z")))).toBe(false);
    expect(current).toEqual(before);
  });
  it("keeps tied review items deterministic before and after evidence expiry", () => {
    const input = bundle();
    input.recommendations = ["Zulu", "Alpha", "Bravo"].map(name => ({ ...input.recommendations[0],
      id: `rec-${name}`, assetId: `asset-${name}`, assetName: name, riskLevel: "Unknown",
    }));
    for (const time of [checkedAt, "2026-09-12T13:00:00Z"]) {
      expect(projectBundleFreshness(input, new Date(time)).recommendations.map(row => row.assetName))
        .toEqual(["Alpha", "Bravo", "Zulu"]);
    }
    expect(input.recommendations[0].assetName).toBe("Zulu");
  });
  it.each(["", "invalid", "2026-09-12T12:00:00.001Z"])("rejects legacy PWFDF publication time %s after JSON reload", sourceUpdatedAt => {
    const input = bundle();
    input.sourceSnapshots = [source({ sourceKey: "usgs-pwfdf", sourceUpdatedAt,
      sourceTimeBasis: undefined, validUntil: undefined })];
    const reloaded = JSON.parse(JSON.stringify(input));
    const result = projectBundleFreshness(reloaded, new Date(checkedAt));
    expect(result.sourceSnapshots[0]).toMatchObject({ stale: true, freshness: { state: "invalid" } });
    expect(result.recommendations[0]).toMatchObject({ riskLevel: "Unknown", confidenceLevel: "Low", score100: 90 });
    expect(result.auditEvents).toEqual(input.auditEvents);
    expect(reloaded.sourceSnapshots[0].stale).toBe(false);
  });

  it("accepts a real PWFDF date without inventing missing provenance markers", () => {
    const result = projectSourceFreshness(source({ sourceKey: "usgs-pwfdf", sourceTimeBasis: undefined,
      sourceUpdatedAt: checkedAt, validUntil: undefined }), new Date(checkedAt));
    expect(result.freshness?.state).toBe("current");
    expect(result.sourceTimeBasis).toBeUndefined();
    expect(result.sourceUpdatedAt).toBe(checkedAt);
  });

  it.each(["assessment", "basin"])("rejects future saved %s dates behind a valid summary date", kind => {
    const future = "2026-09-12T12:00:00.001Z";
    const rawPayload = kind === "assessment" ? { assessment: { assessmentDate: future } }
      : { basins: [{ assessmentDate: checkedAt }, { assessmentDate: future }] };
    const result = projectSourceFreshness(source({ sourceKey: "usgs-pwfdf", sourceTimeBasis: undefined,
      sourceUpdatedAt: checkedAt, validUntil: undefined, rawPayload }), new Date(checkedAt));
    expect(result).toMatchObject({ stale: true, freshness: { state: "invalid" } });
  });

  it.each([{ assessment: null }, { assessment: {} }, { assessment: [] },
    { basins: null }, { basins: [null] }, { basins: [{}] }])("rejects present malformed PWFDF publication records %j", rawPayload => {
    const result = projectSourceFreshness(source({ sourceKey: "usgs-pwfdf", sourceUpdatedAt: checkedAt,
      sourceTimeBasis: undefined, validUntil: undefined, rawPayload }), new Date(checkedAt));
    expect(result.freshness?.state).toBe("invalid");
    expect(result.stale).toBe(true);
  });

  it("expires at the exact deadline without a refresh or persistence write", () => {
    const input = bundle();
    const before = projectBundleFreshness(input, new Date("2026-09-12T12:29:59.999Z"));
    const after = projectBundleFreshness(input, new Date("2026-09-12T12:30:00.000Z"));
    expect(before.sourceSnapshots[0].freshness?.state).toBe("current");
    expect(before.incident.alertCoverageStatus).toBe("available");
    expect(before.recommendations[0].riskLevel).toBe("Very High");
    expect(Object.values(before.recommendations[0].scoreBreakdown.metricStatus!)).toEqual(Array(5).fill("available"));
    expect(after.sourceSnapshots[0].freshness?.state).toBe("expired");
    expect(after.recommendations[0]).toMatchObject({ riskLevel: "Unknown", score100: 90, finalScore: 0.9, confidenceLevel: "Low", dataFreshnessHours: 1.5 });
    expect(after.recommendations[0].reasonCodes).not.toContain("Fresh Source Data");
    expect(Object.values(after.recommendations[0].scoreBreakdown.metricStatus!)).toEqual(Array(5).fill("not_available"));
    expect(after.incident).toMatchObject({ status: "Stale Data", dataFreshness: "Low" });
    expect(after.incident.alertCoverageStatus).toBe("unavailable");
    expect(after.incident.rainfallForecast).toBe("Rainfall unavailable or expired");
    expect(after.sourceSnapshots[0].detail).toContain("expired");
    expect(after.auditEvents).toBe(input.auditEvents);
    expect(input.sourceSnapshots[0].stale).toBe(false);
    expect(input.recommendations[0].riskLevel).toBe("Very High");
    expect(Object.values(input.auditEvents[0].snapshot.scoreBreakdown.metricStatus!)).toEqual(Array(5).fill("available"));
    expect(projectBundleFreshness(after, new Date("2026-09-12T12:30:00Z"))).toEqual(after);
  });

  it.each(["expired", "invalid", "absent"])("cannot restore available metrics from stored metadata when sources are %s", (state) => {
    const input = bundle();
    if (state === "invalid") input.sourceSnapshots[0].fetchedAt = "invalid timestamp";
    if (state === "absent") input.sourceSnapshots = [];
    const before = structuredClone(input);
    const result = projectBundleFreshness(input, new Date("2026-09-12T12:30:00Z"));
    expect(Object.values(result.recommendations[0].scoreBreakdown.metricStatus!)).toEqual(Array(5).fill("not_available"));
    expect(result.recommendations[0]).toMatchObject({ riskLevel: "Unknown", finalScore: 0.9, score100: 90 });
    expect(result.incident).toMatchObject({ status: "Stale Data", dataFreshness: "Low" });
    expect(input).toEqual(before);
    expect(result.auditEvents).toBe(input.auditEvents);
    expect(projectBundleFreshness(result, new Date("2026-09-12T12:30:00Z"))).toEqual(result);
  });

  it.each(["", "bad", "2026-09-13T12:00:00Z"])("fails closed on invalid or future retrieval time: %s", (fetchedAt) => {
    const result = projectSourceFreshness(source({ fetchedAt }), new Date(checkedAt));
    expect(result.freshness?.state).toBe("invalid");
    expect(result.stale).toBe(true);
    expect(result.freshnessLabel).not.toMatch(/Just now|Fresh/);
  });

  it("requires real forecast provenance, not a legacy retrieval timestamp", () => {
    const result = projectSourceFreshness(source({ sourceTimeBasis: undefined, validUntil: undefined }), new Date(checkedAt));
    expect(result.freshness?.state).toBe("invalid");
  });

  it("expires at provider validity even before the retrieval TTL", () => {
    const result = projectSourceFreshness(source({ validUntil: "2026-09-12T12:01:00Z" }), new Date("2026-09-12T12:01:00Z"));
    expect(result.freshness?.state).toBe("expired");
  });

  it("keeps historical reference dates distinct from a current retrieval", () => {
    const reference = source({ sourceKey: "wfigs-ytd", sourceUpdatedAt: "2025-01-01T00:00:00Z", stale: true, validUntil: undefined });
    const result = projectSourceFreshness(reference, new Date(checkedAt));
    expect(result.sourceUpdatedAt).toBe(reference.sourceUpdatedAt);
    expect(result.freshness?.state).toBe("current");
    expect(result.freshnessLabel).toContain("source remains limited");
    expect(result.stale).toBe(true);
  });

  it("expires old no-coverage results without changing the recorded coverage finding", () => {
    const result = projectSourceFreshness(source({ sourceKey: "firms", coverageStatus: "not_available" }), new Date("2026-09-12T13:00:00Z"));
    expect(result).toMatchObject({ coverageStatus: "not_available", status: "delayed", freshness: { state: "expired" } });
  });

  it("validates policy configuration and supports an explicit bounded TTL", () => {
    for (const value of ["", "NaN", "Infinity", "0", "-1", "1441"]) expect(evidenceMaxAgeMinutes(value)).toBe(30);
    expect(evidenceMaxAgeMinutes("15")).toBe(15);
    expect(projectSourceFreshness(source(), new Date("2026-09-12T12:15:00Z"), 15).freshness?.state).toBe("expired");
  });

  it.each(["wfigs", "wfigs-ytd", "firms", "mtbs-burn-severity"])("removes legacy %s burn proxies from current source projections without rewriting input", (sourceKey) => {
    const input = source({ sourceKey, derivedSignals: { burnSeverity: 0.9, fireAcres: 50000 } });
    const result = projectSourceFreshness(input, new Date(checkedAt));
    expect(result.derivedSignals?.burnSeverity).toBeUndefined();
    expect(result.derivedSignals?.fireAcres).toBe(50000);
    expect(input.derivedSignals?.burnSeverity).toBe(0.9);
    if (sourceKey === "mtbs-burn-severity") {
      expect(result.coverageStatus).toBe("not_available");
      expect(result.stale).toBe(true);
      expect(result.detail).toContain("requires refresh");
    }
  });
});
