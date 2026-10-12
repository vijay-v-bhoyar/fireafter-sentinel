import { describe, expect, it } from "vitest";
import {
  dashboardBundleToGeoJson,
  geoJsonFileName,
  recommendationsToGeoJson,
} from "./geojson-export";
import type { Incident, Recommendation, SourceSnapshot } from "./types";

describe("GeoJSON exports", () => {
  it("preserves Unknown and the explicit review-only score basis", () => {
    const item = recommendation();
    item.riskLevel = "Unknown";
    item.scoreBreakdown.scoringVersion = "2026-09-12-independent-evidence-v2";
    item.scoreBreakdown.scoreBasis = "review-only";
    const properties = recommendationsToGeoJson([item])[0].properties;
    expect(properties.riskLevel).toBe("Unknown");
    expect(properties.scoreBasis).toBe("review-only");
    expect(properties.scoringVersion).toBe(item.scoreBreakdown.scoringVersion);
  });

  it("exports recommendations as interoperable GeoJSON features", () => {
    const features = recommendationsToGeoJson([recommendation()]);

    expect(features).toHaveLength(1);
    expect(features[0]).toMatchObject({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [-111.4518, 40.0599],
      },
      properties: {
        assetName: "Diamond Fork culvert Utah County GIS OBJECTID 4",
        recommendedAction: "Monitor culvert and review if rainfall forecast increases.",
        riskLevel: "Low",
        score100: 28,
        confidenceLevel: "Medium",
        reasonCodes: ["High Burn Severity"],
        limitations: ["Some signals are derived from mixed public sources."],
        evidence: ["County upload: County/local uploaded asset record."],
      },
    });
  });

  it("wraps queue export with incident metadata, source freshness, and safe disclaimer", () => {
    const exported = dashboardBundleToGeoJson({
      incident: incident(),
      recommendations: [recommendation()],
      sourceSnapshots: [sourceSnapshot()],
      generatedAt: "2026-07-08T22:29:00.000Z",
    });

    expect(exported).toMatchObject({
      type: "FeatureCollection",
      name: "FireAfter Utah County action queue",
      generatedAt: "2026-07-08T22:29:00.000Z",
      fireafter: {
        incidentId: "incident-utah-county-ut",
        county: "Utah County",
        decisionSupport: true,
        sourceFreshness: [
          {
            sourceKey: "nws",
            sourceName: "NWS Forecast Grid and Active Alerts",
            status: "online",
            stale: false,
          },
        ],
      },
    });
    expect(exported.features).toHaveLength(1);
    expect(exported.fireafter.disclaimer).toContain("decision-support");
    expect(exported.fireafter.disclaimer).not.toMatch(
      /order evacuation|automatically close|predict exact/i,
    );
  });

  it("uses a stable county/state filename", () => {
    expect(geoJsonFileName(incident())).toBe(
      "fireafter-utah-county-ut-action-queue.geojson",
    );
  });

  it("ages exported evidence at generation time without lowering its score", () => {
    const item = recommendation();
    item.scoreBreakdown.metricStatus = { rainfallThreat: "available", burnSeverity: "available", slopeTerrain: "available", downstreamExposure: "available", dataFreshness: "available" };
    const before = structuredClone(item);
    const exported = dashboardBundleToGeoJson({
      incident: incident(), recommendations: [item], sourceSnapshots: [sourceSnapshot()],
      generatedAt: "2026-07-08T22:30:00.000Z",
    });
    expect(exported.fireafter.sourceFreshness[0]).toMatchObject({ stale: true, freshness: { state: "expired" } });
    expect(exported.features[0].properties).toMatchObject({ riskLevel: "Unknown", score100: 28, scoreBasis: "review-only" });
    expect(item).toEqual(before);
  });
});

function incident(): Incident {
  return {
    id: "incident-utah-county-ut",
    locationId: "utah-county-ut",
    county: "Utah County",
    state: "UT",
    title: "Utah Fire",
    code: "UT-FA-49049-001",
    status: "Storm Watch",
    stormWindow: "Next 48-72 hrs",
    rainfallForecast: "No measurable rainfall in NWS grid",
    lastRefresh: "10:16 PM UTC",
    dataFreshness: "Low",
    activeAlerts: 4,
    selectedFire: {
      name: "Cherry",
      acres: 34252,
      perimeterUpdated: "2026-07-08T10:16:00.000Z",
      source: "NIFC WFIGS",
    },
  };
}

function recommendation(): Recommendation {
  return {
    id: "rec-upload-1",
    incidentId: "incident-utah-county-ut",
    assetId: "asset-upload-1",
    assetName: "Diamond Fork culvert Utah County GIS OBJECTID 4",
    assetType: "Culvert",
    locationLabel: "Diamond Fork",
    coordinates: [-111.4518, 40.0599],
    recommendedAction: "Monitor culvert and review if rainfall forecast increases.",
    finalScore: 0.276,
    score100: 28,
    riskLevel: "Low",
    confidenceLevel: "Medium",
    reasonCodes: ["High Burn Severity"],
    limitations: ["Some signals are derived from mixed public sources."],
    changedSinceLastRefresh: "Local Asset Recalculated",
    sourcesUpdatedLabel: "Just now",
    dataFreshnessHours: 0.69,
    scoreBreakdown: {
      rainfallThreat: 0,
      burnSeverity: 1,
      slopeTerrain: 1,
      downstreamExposure: 0.15,
      dataFreshness: 0.72,
      confidenceMultiplier: 0.85,
      baseScore: 0.32,
      finalScore: 0.276,
    },
    evidence: [
      {
        sourceKey: "local-upload",
        sourceName: "County upload",
        summary: "County/local uploaded asset record.",
      },
    ],
    sourceSnapshotIds: ["nws", "wfigs"],
    createdAt: "2026-07-08T22:00:00.000Z",
  };
}

function sourceSnapshot(): SourceSnapshot {
  return {
    id: "source-nws",
    incidentId: "incident-utah-county-ut",
    sourceKey: "nws",
    sourceName: "NWS Forecast Grid and Active Alerts",
    fetchedAt: "2026-07-08T22:00:00.000Z",
    sourceUpdatedAt: "2026-07-08T22:00:00.000Z",
    sourceTimeBasis: "provider",
    validUntil: "2026-07-09T22:00:00.000Z",
    status: "online",
    stale: false,
    freshnessLabel: "Just now",
    detail: "No measurable rainfall in NWS grid.",
  };
}
